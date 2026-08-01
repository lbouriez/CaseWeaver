import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const siteRoot = resolve(import.meta.dirname, "..");

test("the portal foundation has its required standalone files", () => {
  for (const file of [
    "docusaurus.config.ts",
    "sidebars.ts",
    "src/theme/Navbar/index.tsx",
    "src/theme/Footer/index.tsx",
    "docs/overview.md",
    "docs/capability-status.md",
  ]) {
    assert.equal(
      existsSync(resolve(siteRoot, file)),
      true,
      `${file} is missing`,
    );
  }
});

test("the portal uses CaseWeaver-owned presentation rather than Rekindle imports", () => {
  const sources = [
    "docusaurus.config.ts",
    "src/theme/Navbar/index.tsx",
    "src/theme/Footer/index.tsx",
    "src/localization/languages.ts",
  ].map((file) => readFileSync(resolve(siteRoot, file), "utf8"));

  assert.equal(sources.join("\n").includes("@rekindle/"), false);
});

test("all required launch locales are configured", () => {
  const config = readFileSync(
    resolve(siteRoot, "docusaurus.config.ts"),
    "utf8",
  );
  for (const locale of ["en", "fr"]) {
    assert.match(config, new RegExp(`"${locale}"`, "u"));
  }
});

test("every documented operator page has a French counterpart and sidebar entry", () => {
  const documents = [
    "overview",
    "quick-start",
    "access-and-secrets",
    "connectors",
    "git-markdown",
    "jitbit",
    "knowledge-analysis",
    "ai-and-cost",
    "configuration-reference",
    "self-hosting",
    "persistence-recovery",
    "testing",
    "troubleshooting",
    "architecture",
    "capability-status",
    "contributing",
  ];
  const sidebar = readFileSync(resolve(siteRoot, "sidebars.ts"), "utf8");
  for (const document of documents) {
    assert.equal(existsSync(resolve(siteRoot, "docs", `${document}.md`)), true);
    assert.equal(
      existsSync(
        resolve(
          siteRoot,
          "i18n/fr/docusaurus-plugin-content-docs/current",
          `${document}.md`,
        ),
      ),
      true,
      `French counterpart for ${document} is missing`,
    );
    assert.match(sidebar, new RegExp(`"${document}"`, "u"));
  }
});

test("operator docs cover current configuration, connectors, and safe examples", () => {
  const docs = readdirSync(resolve(siteRoot, "docs"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(resolve(siteRoot, "docs", name), "utf8"))
    .join("\n");
  for (const key of [
    "ADMIN_ALLOWED_ORIGINS",
    "ADMIN_LOGIN",
    "ADMIN_PASSWORD",
    "ADMIN_DISABLE_LOGIN_AUTHENTICATION",
    "OIDC_CALLBACK_URL",
    "TRUSTED_PROXY_CIDRS",
    "CASEWEAVER_APPLICATION_SECRETS_DIRECTORY",
    "CASEWEAVER_EDGE_API_UPSTREAM",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "CASEWEAVER_TEST_DB_PORT",
  ]) {
    assert.match(docs, new RegExp(key, "u"));
  }
  for (const connector of ["Git / Markdown", "Jitbit"]) {
    assert.match(docs, new RegExp(connector.replaceAll("/", "\\/"), "u"));
  }
  assert.doesNotMatch(docs, /https:\/\/[^\s/]+:[^\s@/]+@/u);
  assert.doesNotMatch(
    docs,
    /(?:api[_-]?key|token|password)\s*[:=]\s*[A-Za-z0-9_-]{12,}/iu,
  );
});

test("locale preference is CaseWeaver-owned and has no identity or provider path", () => {
  const sources = [
    "src/localization/language-preference.ts",
    "src/components/LanguageSuggestionBanner.tsx",
    "src/theme/Root.tsx",
  ]
    .map((file) => readFileSync(resolve(siteRoot, file), "utf8"))
    .join("\n");
  assert.match(sources, /caseweaver\.docs\.locale/u);
  assert.doesNotMatch(sources, /rekindle|token|cookie|fetch\(/iu);
});
