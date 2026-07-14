import { z } from "zod";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u);
const databaseUrl = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "postgres:" || protocol === "postgresql:";
}, "Expected a PostgreSQL connection URL.");

const schema = z
  .object({
    DATABASE_URL: databaseUrl,
    CLI_WORKSPACE_ID: identifier,
    CLI_PRINCIPAL_ID: identifier,
  })
  .passthrough();

export interface CliConfig {
  readonly databaseUrl: string;
  readonly workspaceId: string;
  readonly principalId: string;
}

export function parseCliConfig(env: NodeJS.ProcessEnv): CliConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error("CLI configuration is invalid.");
  }
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    workspaceId: parsed.data.CLI_WORKSPACE_ID,
    principalId: parsed.data.CLI_PRINCIPAL_ID,
  };
}
