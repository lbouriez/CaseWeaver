import { z } from "zod";

const nodeEnvironments = ["development", "test", "production"] as const;
const maximumReadinessTimeoutMs = 60_000;
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u);
const httpsUrl = z
  .url()
  .refine((value) => new URL(value).protocol === "https:", {
    message: "Expected an HTTPS URL.",
  });
const proxyAddress = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      /^(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$/u.test(value) ||
      /^[0-9a-fA-F:]+(?:\/\d{1,3})?$/u.test(value),
    { message: "Expected an IP address or CIDR." },
  );
const booleanEnvironmentValue = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

function validEphemeralKey(value: string): boolean {
  try {
    return Buffer.from(value, "base64url").length === 32;
  } catch {
    return false;
  }
}

const databaseUrlSchema = z.url().refine(
  (value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "postgres:" || protocol === "postgresql:";
    } catch {
      return false;
    }
  },
  { message: "Expected a PostgreSQL connection URL." },
);

const apiConfigSchema = z
  .object({
    NODE_ENV: z.enum(nodeEnvironments).default("development"),
    HOST: z.string().trim().min(1).default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535),
    DATABASE_URL: databaseUrlSchema,
    API_WORKSPACE_ID: identifier,
    API_PRINCIPAL_ID: identifier,
    DATABASE_READINESS_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1)
      .max(maximumReadinessTimeoutMs),
    OIDC_ISSUER: httpsUrl.optional(),
    OIDC_CLIENT_ID: identifier.optional(),
    OIDC_CLIENT_SECRET: z.string().min(1).max(4_000).optional(),
    OIDC_CALLBACK_URL: httpsUrl.optional(),
    OIDC_EPHEMERAL_ENCRYPTION_KEY: z
      .string()
      .min(1)
      .max(500)
      .refine(validEphemeralKey, {
        message: "Expected a base64url 32-byte encryption key.",
      })
      .optional(),
    OIDC_EPHEMERAL_KEY_ID: identifier.optional(),
    /** Deployment-only first-administrator bootstrap; never exposed by the API. */
    ADMIN_BOOTSTRAP_OIDC_SUBJECT: z.string().trim().min(1).max(500).optional(),
    ADMIN_BOOTSTRAP_DISPLAY_NAME: z.string().trim().min(1).max(160).optional(),
    /** Local-only operator login. Development and test have safe-to-discover defaults. */
    ADMIN_LOGIN: z.string().trim().min(1).max(160).optional(),
    ADMIN_PASSWORD: z.string().min(1).max(1_024).optional(),
    /** Required to deliberately enable password login in production. */
    ADMIN_ENABLE_PASSWORD_AUTHENTICATION: booleanEnvironmentValue.optional(),
    ADMIN_DISABLE_LOGIN_AUTHENTICATION: booleanEnvironmentValue
      .optional()
      .default(false),
    ADMIN_ALLOWED_ORIGINS: z.string().max(8_000).optional(),
    TRUSTED_PROXY_CIDRS: z.string().max(8_000).optional(),
  })
  .passthrough();

export interface ApiConfig {
  readonly nodeEnv: (typeof nodeEnvironments)[number];
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly databaseReadinessTimeoutMs: number;
  readonly oidc?: Readonly<{
    readonly issuer: string;
    readonly clientId: string;
    readonly clientSecret?: string;
    readonly callbackUrl: string;
    /** Base64url/base64 32-byte authenticated-encryption key; never logged. */
    readonly ephemeralEncryptionKey: string;
    readonly ephemeralKeyId: string;
  }>;
  /** First-installation identity bootstrap, sourced only from deployment config. */
  readonly administrationBootstrap?: Readonly<{
    readonly oidcSubject: string;
    readonly displayName: string;
  }>;
  /** Deployment-owned password login; its credential is never exposed in a DTO. */
  readonly localAuthentication?: Readonly<{
    readonly login: string;
    readonly password: string;
    readonly principalId: string;
    readonly displayName: string;
  }>;
  readonly allowedAdminOrigins: readonly string[];
  /** Explicit proxy sources only; forwarding headers are otherwise ignored. */
  readonly trustedProxyCidrs: readonly string[];
}

export class ApiConfigurationError extends Error {
  public constructor() {
    super("API configuration is invalid.");
    this.name = "ApiConfigurationError";
  }
}

export function parseApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const result = apiConfigSchema.safeParse(env);

  if (!result.success) {
    throw new ApiConfigurationError();
  }

  const oidcValues = [
    result.data.OIDC_ISSUER,
    result.data.OIDC_CLIENT_ID,
    result.data.OIDC_CALLBACK_URL,
    result.data.OIDC_EPHEMERAL_ENCRYPTION_KEY,
    result.data.OIDC_EPHEMERAL_KEY_ID,
  ];
  if (
    oidcValues.some((value) => value !== undefined) &&
    oidcValues.some((value) => value === undefined)
  ) {
    throw new ApiConfigurationError();
  }
  const bootstrapValues = [
    result.data.ADMIN_BOOTSTRAP_OIDC_SUBJECT,
    result.data.ADMIN_BOOTSTRAP_DISPLAY_NAME,
  ];
  if (
    bootstrapValues.some((value) => value === undefined) &&
    bootstrapValues.some((value) => value !== undefined)
  ) {
    throw new ApiConfigurationError();
  }
  if (
    result.data.ADMIN_BOOTSTRAP_OIDC_SUBJECT !== undefined &&
    result.data.OIDC_ISSUER === undefined
  ) {
    throw new ApiConfigurationError();
  }
  const origins = (result.data.ADMIN_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (
    origins.some((origin) => !validAdminOrigin(origin, result.data.NODE_ENV))
  ) {
    throw new ApiConfigurationError();
  }
  // A cookie-authenticated operator console cannot perform CSRF-protected
  // mutations or accept password credentials without an explicit origin
  // allow-list. Do not silently run an interactive administration API without
  // this browser boundary.
  if (origins.length === 0) {
    throw new ApiConfigurationError();
  }
  if (
    result.data.ADMIN_DISABLE_LOGIN_AUTHENTICATION &&
    result.data.ADMIN_ENABLE_PASSWORD_AUTHENTICATION === true
  ) {
    throw new ApiConfigurationError();
  }
  const developmentPasswordAuthentication =
    result.data.NODE_ENV === "development" || result.data.NODE_ENV === "test";
  const passwordAuthenticationEnabled =
    !result.data.ADMIN_DISABLE_LOGIN_AUTHENTICATION &&
    (result.data.ADMIN_ENABLE_PASSWORD_AUTHENTICATION ??
      developmentPasswordAuthentication);
  if (
    passwordAuthenticationEnabled &&
    result.data.NODE_ENV === "production" &&
    (result.data.ADMIN_LOGIN === undefined ||
      result.data.ADMIN_PASSWORD === undefined ||
      (result.data.ADMIN_LOGIN === "admin" &&
        result.data.ADMIN_PASSWORD === "admin"))
  ) {
    throw new ApiConfigurationError();
  }
  if (!passwordAuthenticationEnabled && result.data.OIDC_ISSUER === undefined) {
    throw new ApiConfigurationError();
  }
  const trustedProxyCidrs = (result.data.TRUSTED_PROXY_CIDRS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (
    trustedProxyCidrs.some((value) => !proxyAddress.safeParse(value).success)
  ) {
    throw new ApiConfigurationError();
  }
  return {
    nodeEnv: result.data.NODE_ENV,
    host: result.data.HOST,
    port: result.data.PORT,
    databaseUrl: result.data.DATABASE_URL,
    workspaceId: result.data.API_WORKSPACE_ID,
    principalId: result.data.API_PRINCIPAL_ID,
    databaseReadinessTimeoutMs: result.data.DATABASE_READINESS_TIMEOUT_MS,
    allowedAdminOrigins: Object.freeze(origins),
    trustedProxyCidrs: Object.freeze(trustedProxyCidrs),
    ...(result.data.OIDC_ISSUER === undefined
      ? {}
      : {
          oidc: Object.freeze({
            issuer: result.data.OIDC_ISSUER,
            clientId: result.data.OIDC_CLIENT_ID as string,
            ...(result.data.OIDC_CLIENT_SECRET === undefined
              ? {}
              : { clientSecret: result.data.OIDC_CLIENT_SECRET }),
            callbackUrl: result.data.OIDC_CALLBACK_URL as string,
            ephemeralEncryptionKey: result.data
              .OIDC_EPHEMERAL_ENCRYPTION_KEY as string,
            ephemeralKeyId: result.data.OIDC_EPHEMERAL_KEY_ID as string,
          }),
        }),
    ...(result.data.ADMIN_BOOTSTRAP_OIDC_SUBJECT === undefined
      ? {}
      : {
          administrationBootstrap: Object.freeze({
            oidcSubject: result.data.ADMIN_BOOTSTRAP_OIDC_SUBJECT,
            displayName: result.data.ADMIN_BOOTSTRAP_DISPLAY_NAME as string,
          }),
        }),
    ...(passwordAuthenticationEnabled
      ? {
          localAuthentication: Object.freeze({
            login: result.data.ADMIN_LOGIN ?? "admin",
            password: result.data.ADMIN_PASSWORD ?? "admin",
            // Keep local-password sessions distinguishable from OIDC sessions,
            // so disabling this login method also invalidates those sessions.
            principalId: "local-password-administrator",
            displayName: "Local administrator",
          }),
        }
      : {}),
  };
}

function validAdminOrigin(
  value: string,
  nodeEnv: (typeof nodeEnvironments)[number],
): boolean {
  if (httpsUrl.safeParse(value).success) return true;
  if (nodeEnv !== "development") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.pathname === "/" &&
      url.search.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
}
