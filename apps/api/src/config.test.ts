import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ApiConfigurationError, parseApiConfig } from "./config.js";

const validEnvironment = {
  DATABASE_READINESS_TIMEOUT_MS: "500",
  DATABASE_URL: "postgresql://caseweaver:password@localhost:5432/caseweaver",
  PORT: "3000",
};

describe("parseApiConfig", () => {
  it("returns only validated API configuration values", () => {
    expect(
      parseApiConfig({
        ...validEnvironment,
        EXTRA_VALUE: "ignored",
        HOST: "127.0.0.1",
        NODE_ENV: "test",
      }),
    ).toEqual({
      databaseReadinessTimeoutMs: 500,
      databaseUrl: "postgresql://caseweaver:password@localhost:5432/caseweaver",
      host: "127.0.0.1",
      nodeEnv: "test",
      port: 3000,
    });
  });

  it.each([
    ["DATABASE_URL", undefined],
    ["DATABASE_URL", "not-a-url"],
    ["PORT", undefined],
    ["PORT", "0"],
    ["DATABASE_READINESS_TIMEOUT_MS", undefined],
    ["DATABASE_READINESS_TIMEOUT_MS", "0"],
  ])("rejects invalid required %s without exposing validation details", (key, value) => {
    expect(() => parseApiConfig({ ...validEnvironment, [key]: value })).toThrow(
      ApiConfigurationError,
    );
    expect(() => parseApiConfig({ ...validEnvironment, [key]: value })).toThrow(
      "API configuration is invalid.",
    );
  });
});

describe("API process configuration", () => {
  it("fails before serving traffic when its environment is invalid", () => {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url),
        ),
        fileURLToPath(new URL("./main.ts", import.meta.url)),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_READINESS_TIMEOUT_MS: "500",
          DATABASE_URL: "not-a-database-url",
          PORT: "3000",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("API startup failed.\n");
    expect(result.stderr).not.toContain("not-a-database-url");
  });
});
