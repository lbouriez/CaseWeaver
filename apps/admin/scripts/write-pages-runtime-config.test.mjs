import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createPagesHeaders,
  parsePagesRuntimeConfiguration,
  writeCloudflarePagesRuntimeConfiguration,
} from "./write-pages-runtime-config.mjs";

const scriptPath = fileURLToPath(
  new URL("./write-pages-runtime-config.mjs", import.meta.url),
);
const testDirectory = dirname(fileURLToPath(import.meta.url));

test("writes the only public Pages configuration and restrictive headers", () => {
  const outputDirectory = mkdtempSync(
    join(tmpdir(), "caseweaver-admin-pages-"),
  );
  try {
    const result = writeCloudflarePagesRuntimeConfiguration({
      apiBaseUrl: "https://api.caseweaver.example",
      uiTitle: " CaseWeaver Operations ",
      outputDirectory,
    });

    assert.deepEqual(result.runtimeConfig, {
      apiBaseUrl: "https://api.caseweaver.example",
      uiTitle: "CaseWeaver Operations",
    });
    assert.deepEqual(
      JSON.parse(readFileSync(result.runtimeConfigPath, "utf8")),
      {
        apiBaseUrl: "https://api.caseweaver.example",
        uiTitle: "CaseWeaver Operations",
      },
    );

    const headers = readFileSync(result.headersPath, "utf8");
    assert.match(headers, /^\/runtime-config\.json$/m);
    assert.match(headers, /Cache-Control: no-store, max-age=0/);
    assert.match(
      headers,
      /connect-src 'self' https:\/\/api\.caseweaver\.example/,
    );
    assert.doesNotMatch(headers, /token|secret|authorization/i);
  } finally {
    rmSync(outputDirectory, { force: true, recursive: true });
  }
});

test("rejects an API value that cannot safely be exposed to a static host", () => {
  for (const apiBaseUrl of [
    "http://api.caseweaver.example",
    "https://operator:credential@api.caseweaver.example",
    "https://api.caseweaver.example/v1",
    "https://api.caseweaver.example?debug=true",
    "https://api.caseweaver.example#fragment",
  ]) {
    assert.throws(
      () =>
        parsePagesRuntimeConfiguration({
          apiBaseUrl,
          uiTitle: "CaseWeaver Control Room",
        }),
      /Cloudflare Pages Admin configuration is invalid/,
    );
  }
});

test("rejects title control characters and keeps the generated CSP deterministic", () => {
  assert.throws(
    () =>
      parsePagesRuntimeConfiguration({
        apiBaseUrl: "https://api.caseweaver.example",
        uiTitle: "CaseWeaver\nControl Room",
      }),
    /control characters/,
  );
  assert.equal(
    createPagesHeaders("https://api.caseweaver.example"),
    createPagesHeaders("https://api.caseweaver.example"),
  );
});

test("the CLI artifact contains only the explicitly public values", () => {
  const outputDirectory = mkdtempSync(
    join(tmpdir(), "caseweaver-admin-pages-cli-"),
  );
  try {
    const result = spawnSync(process.execPath, [scriptPath, outputDirectory], {
      cwd: resolve(testDirectory, "../../.."),
      encoding: "utf8",
      env: {
        CASEWEAVER_ADMIN_API_BASE_URL: "https://api.caseweaver.example",
        CASEWEAVER_ADMIN_UI_TITLE: "CaseWeaver Control Room",
        DATABASE_URL:
          "postgres://operator:private-database-password@db.example",
        CASEWEAVER_OPENROUTER_KEY: "private-provider-key",
        OIDC_CLIENT_SECRET: "private-oidc-secret",
      },
    });
    assert.equal(result.status, 0, result.stderr);

    const publicArtifact = [
      readFileSync(join(outputDirectory, "runtime-config.json"), "utf8"),
      readFileSync(join(outputDirectory, "_headers"), "utf8"),
    ].join("\n");
    assert.deepEqual(
      JSON.parse(
        readFileSync(join(outputDirectory, "runtime-config.json"), "utf8"),
      ),
      {
        apiBaseUrl: "https://api.caseweaver.example",
        uiTitle: "CaseWeaver Control Room",
      },
    );
    assert.doesNotMatch(
      publicArtifact,
      /private-(database-password|provider-key|oidc-secret)/,
    );
    assert.doesNotMatch(
      publicArtifact,
      /DATABASE_URL|OPENROUTER|OIDC_CLIENT_SECRET/,
    );
  } finally {
    rmSync(outputDirectory, { force: true, recursive: true });
  }
});
