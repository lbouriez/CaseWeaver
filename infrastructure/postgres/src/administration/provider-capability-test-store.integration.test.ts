import type { MeteredAiRequest } from "@caseweaver/ai-execution";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  PostgresProviderCapabilityTestConfigurationStore,
  PostgresProviderCapabilityTestStore,
  type ProviderCapabilityTestTemplateLookup,
} from "./provider-capability-test-store.js";

const databaseUrl = process.env.DATABASE_URL;
if (
  databaseUrl === undefined ||
  !new URL(databaseUrl).pathname.toLowerCase().includes("test")
) {
  throw new Error(
    "Provider capability-test store integration tests require a disposable test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const timestamp = "2026-07-15T12:00:00.000Z";
const digest = (value: string) => value.repeat(64);

const template: MeteredAiRequest = Object.freeze({
  kind: "generation",
  role: "analysis",
  request: Object.freeze({
    messages: Object.freeze([
      Object.freeze({
        role: "user",
        content: "Run the fixed capability probe.",
      }),
    ]),
    maxOutputTokens: 4,
  }),
  maximumInputTokens: 16,
  maximumOutputTokens: 4,
  budget: Object.freeze({ currency: "USD", hard: false }),
});

const templates: ProviderCapabilityTestTemplateLookup = {
  load: async ({ providerType, testOperation }) =>
    providerType === "test-provider" && testOperation === "healthCheck"
      ? Object.freeze({
          templateDigest: digest("a"),
          request: template,
          timeoutMs: 5_000,
        })
      : undefined,
};

function createClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
}

function createStores(
  options: ConstructorParameters<
    typeof PostgresProviderCapabilityTestStore
  >[1] = {},
) {
  const client = createClient();
  return {
    client,
    configuration: new PostgresProviderCapabilityTestConfigurationStore(
      client,
      templates,
    ),
    store: new PostgresProviderCapabilityTestStore(client, options),
  };
}

function previewInput(
  overrides: Partial<{
    readonly workspaceId: string;
    readonly principalId: string;
    readonly sessionId: string;
  }> = {},
) {
  const workspaceId = overrides.workspaceId ?? "provider-workspace-a";
  const principalId = overrides.principalId ?? "provider-principal-a";
  return {
    workspaceId,
    principalId,
    sessionId: overrides.sessionId ?? "provider-session-a",
    providerInstanceId: "provider-instance-a",
    providerInstanceVersionId: "provider-instance-version-a",
    bindingVersionId: "provider-binding-a:1",
    testOperation: "healthCheck",
    templateDigest: digest("a"),
    estimatedCost: { amount: "0.012", currency: "USD" },
    now: timestamp,
    audit: {
      workspaceId,
      actorPrincipalId: principalId,
      action: "admin.provider.capabilityTest.preview" as const,
      targetType: "ai-provider-instance" as const,
      targetId: "provider-instance-a",
      permission: "configuration.manage" as const,
      outcome: "succeeded" as const,
      occurredAt: timestamp,
    },
  };
}

function claimInput(
  overrides: Partial<{
    readonly keyDigest: string;
    readonly principalId: string;
    readonly testOperation: string;
  }> = {},
) {
  return {
    workspaceId: "provider-workspace-a",
    principalId: overrides.principalId ?? "provider-principal-a",
    providerInstanceId: "provider-instance-a",
    providerInstanceVersionId: "provider-instance-version-a",
    bindingVersionId: "provider-binding-a:1",
    testOperation: overrides.testOperation ?? "healthCheck",
    idempotency: { keyDigest: overrides.keyDigest ?? digest("b") },
    createdAt: timestamp,
  };
}

function result(claimId: string) {
  return {
    id: claimId,
    workspaceId: "provider-workspace-a",
    providerInstanceId: "provider-instance-a",
    providerInstanceVersionId: "provider-instance-version-a",
    bindingVersionId: "provider-binding-a:1",
    testOperation: "healthCheck",
    outcome: "denied" as const,
    estimatedCost: { amount: "0.012", currency: "USD" },
    reasonCode: "rate_limited" as const,
    completedAt: "2026-07-15T12:00:02.000Z",
  };
}

function terminalAudit() {
  return {
    workspaceId: "provider-workspace-a",
    actorPrincipalId: "provider-principal-a",
    action: "admin.provider.capabilityTest" as const,
    targetType: "ai-provider-instance" as const,
    targetId: "provider-instance-a",
    permission: "configuration.manage" as const,
    outcome: "denied" as const,
    reasonCode: "rate_limited" as const,
    idempotencyKeyDigest: digest("b"),
    occurredAt: "2026-07-15T12:00:02.000Z",
  };
}

beforeEach(async () => {
  await pool.query(
    "TRUNCATE TABLE ai_catalog_snapshots, workspaces RESTART IDENTITY CASCADE",
  );
  await seedConfiguration("a");
  await seedConfiguration("b");
});

afterAll(async () => {
  await pool.end();
});

describe("PostgreSQL provider capability-test stores", () => {
  it("resolves only an active provider with an exact active default binding and reports missing budget policy safely", async () => {
    const stores = createStores();
    try {
      await expect(
        stores.configuration.load({
          workspaceId: "provider-workspace-a",
          providerInstanceId: "provider-instance-a",
          testOperation: "healthCheck",
        }),
      ).resolves.toMatchObject({
        workspaceId: "provider-workspace-a",
        providerInstanceVersionId: "provider-instance-version-a",
        bindingVersionId: "provider-binding-a:1",
        templateDigest: digest("a"),
        budgetPolicy: { status: "configured" },
      });
      await expect(
        stores.configuration.load({
          workspaceId: "provider-workspace-b",
          providerInstanceId: "provider-instance-a",
          testOperation: "healthCheck",
        }),
      ).resolves.toBeUndefined();

      // Budget policies are immutable history. Simulate the absence of an
      // applicable policy by deactivating its superseded row rather than
      // deleting it, which the database guard correctly forbids.
      await stores.client.aiBudgetPolicy.updateMany({
        where: { workspaceId: "provider-workspace-a", active: true },
        data: { active: false },
      });
      await expect(
        stores.configuration.load({
          workspaceId: "provider-workspace-a",
          providerInstanceId: "provider-instance-a",
          testOperation: "healthCheck",
        }),
      ).resolves.toMatchObject({ budgetPolicy: { status: "missing" } });

      await stores.client.aiProviderInstance.update({
        where: {
          workspaceId_id: {
            workspaceId: "provider-workspace-a",
            id: "provider-instance-a",
          },
        },
        data: { lifecycle: "disabled" },
      });
      await expect(
        stores.configuration.load({
          workspaceId: "provider-workspace-a",
          providerInstanceId: "provider-instance-a",
          testOperation: "healthCheck",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await stores.client.$disconnect();
    }
  });

  it("atomically issues a session-bound confirmation with its preview audit and consumes it once", async () => {
    const stores = createStores();
    try {
      const issued = await stores.store.issueAndRecord(previewInput());
      await expect(
        stores.store.consume({
          ...previewInput({ sessionId: "other-session" }),
          confirmationId: issued.confirmationId,
        }),
      ).resolves.toBe(false);
      await expect(
        stores.store.consume({
          ...previewInput(),
          confirmationId: issued.confirmationId,
        }),
      ).resolves.toBe(true);
      await expect(
        stores.store.consume({
          ...previewInput(),
          confirmationId: issued.confirmationId,
        }),
      ).resolves.toBe(false);
      await expect(
        pool.query(
          `SELECT action, target_id, permission, outcome
           FROM audit_events WHERE action = 'admin.provider.capabilityTest.preview'`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            action: "admin.provider.capabilityTest.preview",
            target_id: "provider-instance-a",
            permission: "configuration.manage",
            outcome: "succeeded",
          },
        ],
      });
    } finally {
      await stores.client.$disconnect();
    }
  });

  it("retains durable idempotency claims through in-progress, terminal replay, and conflicting requests", async () => {
    const stores = createStores();
    try {
      const first = await stores.store.claim(claimInput());
      expect(first).toMatchObject({ kind: "acquired" });
      if (first.kind !== "acquired")
        throw new Error("Expected acquired claim.");

      await expect(stores.store.claim(claimInput())).resolves.toEqual({
        kind: "inProgress",
        id: first.id,
      });
      await expect(
        stores.store.claim(claimInput({ testOperation: "differentOperation" })),
      ).resolves.toEqual({ kind: "conflict" });

      await expect(
        stores.store.completeAndRecord({
          claimId: first.id,
          result: result(first.id),
          audit: terminalAudit(),
        }),
      ).resolves.toMatchObject({ id: first.id, outcome: "denied" });
      await expect(stores.store.claim(claimInput())).resolves.toMatchObject({
        kind: "replayed",
        result: { id: first.id, reasonCode: "rate_limited" },
      });
    } finally {
      await stores.client.$disconnect();
    }
  });

  it("uses PostgreSQL time for bounded atomic rate windows, not a route-supplied clock", async () => {
    const stores = createStores({ rateLimit: 2 });
    try {
      const attempts = await Promise.all(
        Array.from({ length: 3 }, () =>
          stores.store.acquire({
            workspaceId: "provider-workspace-a",
            principalId: "provider-principal-a",
            providerInstanceId: "provider-instance-a",
            providerInstanceVersionId: "provider-instance-version-a",
            now: "1999-01-01T00:00:00.000Z",
          }),
        ),
      );
      expect(attempts.filter((attempt) => attempt.allowed)).toHaveLength(2);
      await expect(
        pool.query(
          `SELECT window_started_at::date <> DATE '1999-01-01' AS uses_database_time,
                  acquired_count
           FROM administration_provider_capability_test_rate_windows`,
        ),
      ).resolves.toMatchObject({
        rows: [{ uses_database_time: true, acquired_count: 2 }],
      });
    } finally {
      await stores.client.$disconnect();
    }
  });

  it("rolls back the terminal result when the required audit append cannot persist", async () => {
    const stores = createStores({ nextId: () => "audit-collision" });
    try {
      const claim = await stores.store.claim(claimInput());
      if (claim.kind !== "acquired")
        throw new Error("Expected acquired claim.");
      await pool.query(
        `INSERT INTO audit_events (id, workspace_id, action, occurred_at)
         VALUES ('audit-collision', 'provider-workspace-a', 'existing.audit', now())`,
      );
      await expect(
        stores.store.completeAndRecord({
          claimId: claim.id,
          result: result(claim.id),
          audit: terminalAudit(),
        }),
      ).rejects.toThrow();
      await expect(
        pool.query(
          `SELECT completed_at FROM administration_provider_capability_test_claims
           WHERE id = $1`,
          [claim.id],
        ),
      ).resolves.toMatchObject({ rows: [{ completed_at: null }] });
      await expect(
        pool.query(
          `SELECT count(*)::int AS count
           FROM administration_provider_capability_test_results WHERE claim_id = $1`,
          [claim.id],
        ),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await stores.client.$disconnect();
    }
  });
});

async function seedConfiguration(suffix: "a" | "b"): Promise<void> {
  const workspaceId = `provider-workspace-${suffix}`;
  const providerId = `provider-instance-${suffix}`;
  const providerVersionId = `provider-instance-version-${suffix}`;
  const bindingId = `provider-binding-${suffix}`;
  const bindingVersionId = `${bindingId}:1`;
  const snapshotId = `provider-snapshot-${suffix}`;
  const modelId = `provider-model-${suffix}`;
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("INSERT INTO workspaces (id) VALUES ($1)", [
      workspaceId,
    ]);
    await connection.query(
      "INSERT INTO principals (id, workspace_id) VALUES ($1, $2)",
      [`provider-principal-${suffix}`, workspaceId],
    );
    await connection.query(
      `INSERT INTO ai_catalog_snapshots (
        id, upstream_url, upstream_commit_sha, fetched_at, sha256, raw_entries
      ) VALUES ($1, $2, '1234567', now(), repeat('a', 64), '{}'::jsonb)`,
      [snapshotId, `https://catalog.example/${suffix}/model.json`],
    );
    await connection.query(
      `INSERT INTO ai_catalog_models (
        id, catalog_snapshot_id, canonical_model, provider, supported_roles,
        capabilities, raw_entry
      ) VALUES ($1, $2, 'fixed-model', 'test-provider', '["analysis"]'::jsonb, '[]'::jsonb, '{}'::jsonb)`,
      [modelId, snapshotId],
    );
    await connection.query(
      `INSERT INTO ai_provider_instances (id, workspace_id, provider_type, lifecycle)
       VALUES ($1, $2, 'test-provider', 'active')`,
      [providerId, workspaceId],
    );
    await connection.query(
      `INSERT INTO ai_provider_instance_versions (
        id, workspace_id, provider_instance_id, version, endpoint, wire_api,
        parameters, secret_reference
      ) VALUES ($1, $2, $3, 1, 'https://provider.example', 'chatCompletions', '{}'::jsonb, 'vault:redacted')`,
      [providerVersionId, workspaceId, providerId],
    );
    await connection.query(
      `INSERT INTO ai_model_bindings (id, workspace_id, role, lifecycle)
       VALUES ($1, $2, 'analysis', 'draft')`,
      [bindingId, workspaceId],
    );
    await connection.query(
      `INSERT INTO ai_model_binding_versions (
        id, workspace_id, model_binding_id, version, provider_instance_version_id,
        catalog_snapshot_id, catalog_model_id, canonical_model, wire_api,
        parameters, capabilities, secret_reference
      ) VALUES ($1, $2, $3, 1, $4, $5, $6, 'fixed-model', 'chatCompletions', '{}'::jsonb, '[]'::jsonb, 'vault:redacted')`,
      [
        bindingVersionId,
        workspaceId,
        bindingId,
        providerVersionId,
        snapshotId,
        modelId,
      ],
    );
    await connection.query(
      `UPDATE ai_model_bindings
       SET lifecycle = 'active', active_version_id = $1
       WHERE workspace_id = $2 AND id = $3`,
      [bindingVersionId, workspaceId, bindingId],
    );
    await connection.query(
      `INSERT INTO ai_workspace_binding_defaults (workspace_id, role, model_binding_version_id)
       VALUES ($1, 'analysis', $2)`,
      [workspaceId, bindingVersionId],
    );
    await connection.query(
      `INSERT INTO ai_budget_policies (
        id, workspace_id, scope, scope_key, limit_amount, currency, hard
      ) VALUES ($1, $2, 'workspace', 'all', 10, 'USD', true)`,
      [`provider-budget-${suffix}`, workspaceId],
    );
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}
