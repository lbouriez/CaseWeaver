import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createPostgresRepositoryRuntime } from "./runtime.js";
import {
  PostgresRepositoryRuntimeConfigurationError,
  PostgresRepositoryRuntimeConfigurationResolver,
} from "./repository-runtime-configuration-resolver.js";

const databaseUrl = process.env.DATABASE_URL;
if (
  databaseUrl === undefined ||
  !new URL(databaseUrl).pathname.toLowerCase().includes("test")
) {
  throw new Error(
    "PostgreSQL repository runtime tests require a disposable test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});
const resolver = new PostgresRepositoryRuntimeConfigurationResolver(client);
const pin = {
  workspaceId: "workspace-a",
  runtimeVersionId: "repository-runtime-old",
  repositoryId: "support-service",
  pinnedCommit: "a".repeat(40),
};

function settings(bindingVersionId: string) {
  return {
    repositoryId: "support-service",
    pinnedCommit: "a".repeat(40),
    bindingVersionId,
    allowedTools: ["listFiles", "readFile", "searchFiles"],
    sandbox: {
      timeoutMs: 120_000,
      maximumCpuMilliseconds: 120_000,
      maximumMemoryBytes: 512 * 1024 * 1024,
      maximumOutputBytes: 1_048_576,
      maximumToolCalls: 30,
    },
    agent: {
      maximumTurns: 8,
      maximumInputTokensPerTurn: 4096,
      maximumOutputTokensPerTurn: 1024,
      maximumInstructionCharacters: 64_000,
      budget: { currency: "USD", hard: true },
    },
  };
}

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE workspaces RESTART IDENTITY CASCADE");
  await pool.query(
    "INSERT INTO workspaces (id) VALUES ('workspace-a'), ('workspace-b')",
  );
  await pool.query(
    `INSERT INTO credential_registrations (id, workspace_id, secret_reference, lifecycle)
     VALUES ('checkout-credential-a', 'workspace-a', 'vault:checkout/support-service', 'active')`,
  );
  await pool.query(
    `INSERT INTO administration_configurations (
       id, workspace_id, resource_type, lifecycle, revision, current_version_id
     ) VALUES (
       'repository-runtime-a', 'workspace-a', 'repository-runtimes', 'active', 2,
       NULL
     )`,
  );
  await pool.query(
    `INSERT INTO administration_configuration_versions (
       id, workspace_id, configuration_id, version, settings, secret_references
     ) VALUES
       ('repository-runtime-old', 'workspace-a', 'repository-runtime-a', 1, $1::jsonb, $2::jsonb),
       ('repository-runtime-current', 'workspace-a', 'repository-runtime-a', 2, $3::jsonb, $2::jsonb)`,
    [
      JSON.stringify(settings("repository-agent-binding-old")),
      JSON.stringify(["vault:checkout/support-service"]),
      JSON.stringify(settings("repository-agent-binding-current")),
    ],
  );
  // The aggregate/version relationship is deliberately immediate: first append
  // immutable history, then advance the mutable current-version pointer.
  await pool.query(
    `UPDATE administration_configurations
     SET current_version_id = 'repository-runtime-current'
     WHERE id = 'repository-runtime-a' AND workspace_id = 'workspace-a'`,
  );
});

afterAll(async () => {
  await client.$disconnect();
  await pool.end();
});

describe("PostgresRepositoryRuntimeConfigurationResolver", () => {
  it("uses an exact rotated immutable runtime version rather than the mutable current version", async () => {
    await expect(
      resolver.resolve(pin, new AbortController().signal),
    ).resolves.toMatchObject({
      runtimeVersionId: "repository-runtime-old",
      repository: {
        repositoryId: "support-service",
        pinnedCommit: "a".repeat(40),
        checkoutSecretReference: "vault:checkout/support-service",
      },
      execution: { bindingVersionId: "repository-agent-binding-old" },
    });

    const runtime = createPostgresRepositoryRuntime({ databaseUrl });
    try {
      await expect(
        runtime.resolver.resolve(pin, new AbortController().signal),
      ).resolves.toMatchObject({ runtimeVersionId: "repository-runtime-old" });
      const projection = await runtime.executionResolver.resolveExecution(
        pin,
        new AbortController().signal,
      );
      expect(JSON.stringify(projection)).not.toContain(
        "vault:checkout/support-service",
      );
    } finally {
      await runtime.close();
    }
  });

  it("fails closed for cross-workspace, disabled aggregate, and revoked checkout credentials", async () => {
    await expect(
      resolver.resolve(
        { ...pin, workspaceId: "workspace-b" },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(PostgresRepositoryRuntimeConfigurationError);

    await pool.query(
      `UPDATE administration_configurations
       SET lifecycle = 'disabled'
       WHERE id = 'repository-runtime-a' AND workspace_id = 'workspace-a'`,
    );
    await expect(
      resolver.resolve(pin, new AbortController().signal),
    ).rejects.toBeInstanceOf(PostgresRepositoryRuntimeConfigurationError);

    await pool.query(
      `UPDATE administration_configurations
       SET lifecycle = 'active'
       WHERE id = 'repository-runtime-a' AND workspace_id = 'workspace-a'`,
    );
    await pool.query(
      `UPDATE credential_registrations
       SET lifecycle = 'revoked'
       WHERE id = 'checkout-credential-a' AND workspace_id = 'workspace-a'`,
    );
    const attempt = resolver.resolve(pin, new AbortController().signal);
    await expect(attempt).rejects.toBeInstanceOf(
      PostgresRepositoryRuntimeConfigurationError,
    );
    await attempt.catch((error: unknown) => {
      expect(String(error)).not.toContain("vault:checkout/support-service");
    });
  });
});
