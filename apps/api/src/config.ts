import { z } from "zod";

const nodeEnvironments = ["development", "test", "production"] as const;
const maximumReadinessTimeoutMs = 60_000;

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
    DATABASE_READINESS_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1)
      .max(maximumReadinessTimeoutMs),
  })
  .passthrough();

export interface ApiConfig {
  readonly nodeEnv: (typeof nodeEnvironments)[number];
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly databaseReadinessTimeoutMs: number;
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

  return {
    nodeEnv: result.data.NODE_ENV,
    host: result.data.HOST,
    port: result.data.PORT,
    databaseUrl: result.data.DATABASE_URL,
    databaseReadinessTimeoutMs: result.data.DATABASE_READINESS_TIMEOUT_MS,
  };
}
