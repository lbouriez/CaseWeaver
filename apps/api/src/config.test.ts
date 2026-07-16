import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ApiConfigurationError, parseApiConfig } from "./config.js";

const validEnvironment = {
  API_PRINCIPAL_ID: "principal-test",
  API_WORKSPACE_ID: "workspace-test",
  DATABASE_READINESS_TIMEOUT_MS: "500",
  DATABASE_URL: "postgresql://caseweaver:password@localhost:5432/caseweaver",
  PORT: "3000",
  ADMIN_ALLOWED_ORIGINS: "https://admin.example",
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
      principalId: "principal-test",
      workspaceId: "workspace-test",
      allowedAdminOrigins: ["https://admin.example"],
      trustedProxyCidrs: [],
      localAuthentication: {
        login: "admin",
        password: "admin",
        principalId: "local-password-administrator",
        displayName: "Local administrator",
      },
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

  it("requires complete HTTPS OIDC bootstrap configuration", () => {
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        OIDC_ISSUER: "https://issuer.example",
      }),
    ).toThrow(ApiConfigurationError);
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        OIDC_ISSUER: "http://issuer.example",
        OIDC_CLIENT_ID: "admin-client",
        OIDC_CALLBACK_URL: "https://caseweaver.example/v1/auth/callback",
      }),
    ).toThrow(ApiConfigurationError);
  });

  it("requires a deployment encryption key whenever OIDC is enabled", () => {
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        OIDC_ISSUER: "https://issuer.example",
        OIDC_CLIENT_ID: "admin-client",
        OIDC_CALLBACK_URL: "https://caseweaver.example/v1/auth/callback",
      }),
    ).toThrow(ApiConfigurationError);
  });

  it("requires an explicit trusted UI origin whenever interactive administration authentication is enabled", () => {
    const oidc = {
      OIDC_ISSUER: "https://issuer.example",
      OIDC_CLIENT_ID: "admin-client",
      OIDC_CALLBACK_URL: "https://caseweaver.example/v1/auth/callback",
      OIDC_EPHEMERAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
      OIDC_EPHEMERAL_KEY_ID: "key-1",
    };
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        ...oidc,
        ADMIN_ALLOWED_ORIGINS: undefined,
      }),
    ).toThrow(ApiConfigurationError);
    expect(
      parseApiConfig({
        ...validEnvironment,
        ...oidc,
        ADMIN_ALLOWED_ORIGINS: "https://admin.example",
      }).allowedAdminOrigins,
    ).toEqual(["https://admin.example"]);
  });

  it("limits default password authentication to development and test, while allowing OAuth-only deployments", () => {
    expect(parseApiConfig(validEnvironment).localAuthentication).toEqual({
      login: "admin",
      password: "admin",
      principalId: "local-password-administrator",
      displayName: "Local administrator",
    });
    expect(
      parseApiConfig({
        ...validEnvironment,
        ADMIN_LOGIN: "operator",
        ADMIN_PASSWORD: "local-only-password",
      }).localAuthentication,
    ).toMatchObject({ login: "operator", password: "local-only-password" });
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        ADMIN_DISABLE_LOGIN_AUTHENTICATION: "true",
      }),
    ).toThrow(ApiConfigurationError);
    expect(
      parseApiConfig({
        ...validEnvironment,
        ADMIN_DISABLE_LOGIN_AUTHENTICATION: "true",
        OIDC_ISSUER: "https://issuer.example",
        OIDC_CLIENT_ID: "admin-client",
        OIDC_CALLBACK_URL: "https://caseweaver.example/v1/auth/callback",
        OIDC_EPHEMERAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString(
          "base64url",
        ),
        OIDC_EPHEMERAL_KEY_ID: "key-1",
      }).localAuthentication,
    ).toBeUndefined();
  });

  it("requires an explicit non-default production password-login configuration", () => {
    const oidc = {
      OIDC_ISSUER: "https://issuer.example",
      OIDC_CLIENT_ID: "admin-client",
      OIDC_CALLBACK_URL: "https://caseweaver.example/v1/auth/callback",
      OIDC_EPHEMERAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
      OIDC_EPHEMERAL_KEY_ID: "key-1",
    };
    expect(
      parseApiConfig({
        ...validEnvironment,
        ...oidc,
        NODE_ENV: "production",
      }).localAuthentication,
    ).toBeUndefined();
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        ...oidc,
        NODE_ENV: "production",
        ADMIN_ENABLE_PASSWORD_AUTHENTICATION: "true",
      }),
    ).toThrow(ApiConfigurationError);
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        ...oidc,
        NODE_ENV: "production",
        ADMIN_ENABLE_PASSWORD_AUTHENTICATION: "true",
        ADMIN_LOGIN: "admin",
        ADMIN_PASSWORD: "admin",
      }),
    ).toThrow(ApiConfigurationError);
    expect(
      parseApiConfig({
        ...validEnvironment,
        ...oidc,
        NODE_ENV: "production",
        ADMIN_ENABLE_PASSWORD_AUTHENTICATION: "true",
        ADMIN_LOGIN: "operator",
        ADMIN_PASSWORD: "production-only-password",
      }).localAuthentication,
    ).toMatchObject({
      login: "operator",
      password: "production-only-password",
    });
  });

  it("accepts a complete deployment-only first-administrator bootstrap and rejects partial values", () => {
    const oidc = {
      OIDC_ISSUER: "https://issuer.example",
      OIDC_CLIENT_ID: "admin-client",
      OIDC_CALLBACK_URL: "https://caseweaver.example/v1/auth/callback",
      OIDC_EPHEMERAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
      OIDC_EPHEMERAL_KEY_ID: "key-1",
      ADMIN_ALLOWED_ORIGINS: "https://admin.example",
    };
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        ...oidc,
        ADMIN_BOOTSTRAP_OIDC_SUBJECT: "operator-subject",
      }),
    ).toThrow(ApiConfigurationError);
    expect(
      parseApiConfig({
        ...validEnvironment,
        ...oidc,
        ADMIN_BOOTSTRAP_OIDC_SUBJECT: "operator-subject",
        ADMIN_BOOTSTRAP_DISPLAY_NAME: "Initial Administrator",
      }).administrationBootstrap,
    ).toEqual({
      oidcSubject: "operator-subject",
      displayName: "Initial Administrator",
    });
  });

  it("allows localhost UI origins only for explicit development deployments and validates trusted proxy sources", () => {
    expect(
      parseApiConfig({
        ...validEnvironment,
        NODE_ENV: "development",
        ADMIN_ALLOWED_ORIGINS: "http://localhost:8082",
        TRUSTED_PROXY_CIDRS: "127.0.0.1/32,10.0.0.0/8",
      }),
    ).toMatchObject({
      allowedAdminOrigins: ["http://localhost:8082"],
      trustedProxyCidrs: ["127.0.0.1/32", "10.0.0.0/8"],
    });
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        NODE_ENV: "production",
        ADMIN_ALLOWED_ORIGINS: "http://localhost:8082",
      }),
    ).toThrow(ApiConfigurationError);
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        TRUSTED_PROXY_CIDRS: "forwarded.example",
      }),
    ).toThrow(ApiConfigurationError);
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
