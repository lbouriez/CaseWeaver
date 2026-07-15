import { randomUUID } from "node:crypto";

import {
  type Clock,
  type ExecutionContext,
  type IdGenerator,
  RequestKnowledgeSourceSynchronization,
} from "@caseweaver/application";
import {
  correlationId,
  principalId,
  requestId,
  sha256Digest,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createPostgresPersistence } from "../index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("PostgreSQL integration tests require DATABASE_URL.");
}
if (!new URL(databaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error(
    "PostgreSQL integration DATABASE_URL must name a test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const workspace = "workspace-source-command";
const foreignWorkspace = "workspace-source-command-foreign";
const principal = "principal-source-command";
const source = "source-command-enabled";
const foreignSource = "source-command-foreign";
const clock: Clock = {
  now: () => utcInstant("2026-07-15T12:00:00.000Z"),
};
const ids: IdGenerator = { next: () => randomUUID() };

async function resetDatabase(): Promise<void> {
  await pool.query(
    "TRUNCATE TABLE workspaces, ai_catalog_snapshots RESTART IDENTITY CASCADE",
  );
}

async function seedWorkspaceKnowledge(
  workspaceIdValue: string,
  sourceId: string,
): Promise<void> {
  const suffix = workspaceIdValue === workspace ? "primary" : "foreign";
  const catalogId = `source-catalog-${suffix}`;
  const modelId = `source-model-${suffix}`;
  const providerId = `source-provider-${suffix}`;
  const providerVersionId = `source-provider-version-${suffix}`;
  const bindingId = `source-binding-${suffix}`;
  const bindingVersionId = `source-binding-version-${suffix}`;
  const collectionId = `source-collection-${suffix}`;
  const connectorId = `source-connector-${suffix}`;
  const sourceConfigurationVersionId =
    suffix === "primary"
      ? "source-configuration-v7"
      : `source-configuration-v7-${suffix}`;

  await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [
    workspaceIdValue,
  ]);
  await pool.query(
    `INSERT INTO ai_catalog_snapshots (
       id, upstream_url, upstream_commit_sha, fetched_at, sha256, raw_entries
     ) VALUES ($1, $2, $3, now(), repeat('a', 64), '{}'::jsonb)`,
    [
      catalogId,
      `https://catalog.example/source-${suffix}.json`,
      `source-commit-${suffix}`,
    ],
  );
  await pool.query(
    `INSERT INTO ai_catalog_models (
       id, catalog_snapshot_id, canonical_model, provider, supported_roles, capabilities, raw_entry
     ) VALUES ($1, $2, 'source-embedding', 'test', '["embedding"]'::jsonb, '[]'::jsonb, '{}'::jsonb)`,
    [modelId, catalogId],
  );
  await pool.query(
    `INSERT INTO ai_provider_instances (id, workspace_id, provider_type, lifecycle)
     VALUES ($1, $2, 'test', 'active')`,
    [providerId, workspaceIdValue],
  );
  await pool.query(
    `INSERT INTO ai_provider_instance_versions (
       id, workspace_id, provider_instance_id, version, endpoint, wire_api, parameters, secret_reference
     ) VALUES ($1, $2, $3, 1, 'https://provider.example/source', 'embeddings', '{}'::jsonb, 'vault:test')`,
    [providerVersionId, workspaceIdValue, providerId],
  );
  await pool.query(
    `INSERT INTO ai_model_bindings (id, workspace_id, role, lifecycle)
     VALUES ($1, $2, 'embedding', 'active')`,
    [bindingId, workspaceIdValue],
  );
  await pool.query(
    `INSERT INTO ai_model_binding_versions (
       id, workspace_id, model_binding_id, version, provider_instance_version_id,
       catalog_snapshot_id, catalog_model_id, canonical_model, wire_api,
       parameters, capabilities, secret_reference
     ) VALUES ($1, $2, $3, 1, $4, $5, $6, 'source-embedding', 'embeddings', '{}'::jsonb, '[]'::jsonb, 'vault:test')`,
    [
      bindingVersionId,
      workspaceIdValue,
      bindingId,
      providerVersionId,
      catalogId,
      modelId,
    ],
  );
  await pool.query(
    `INSERT INTO connector_registrations (id, workspace_id, lifecycle)
     VALUES ($1, $2, 'active')`,
    [connectorId, workspaceIdValue],
  );
  await pool.query(
    `INSERT INTO knowledge_collections (
       id, workspace_id, embedding_binding_version_id, embedding_profile_version, dimensions
     ) VALUES ($1, $2, $3, 'embedding-profile-v1', 3)`,
    [collectionId, workspaceIdValue, bindingVersionId],
  );
  await seedSourceConfiguration({
    workspaceId: workspaceIdValue,
    sourceId,
    versionId: sourceConfigurationVersionId,
  });
  await pool.query(
    `INSERT INTO knowledge_sources (
       id, workspace_id, connector_registration_id, knowledge_collection_id,
       lifecycle, configuration_version, normalization_profile_version,
       chunking_profile_version, synchronization_policy, deletion_behavior
     ) VALUES ($1, $2, $3, $4, 'enabled', $5,
       'normalization-v1', 'chunking-v1', '{}'::jsonb, 'tombstone')`,
    [
      sourceId,
      workspaceIdValue,
      connectorId,
      collectionId,
      sourceConfigurationVersionId,
    ],
  );
}

/** New rows must model the immutable administration reference introduced by
 * PBI-016; legacy string-only source versions are preserved only for upgraded
 * pre-existing data, not recreated by current integration fixtures. */
async function seedSourceConfiguration(
  input: Readonly<{
    readonly workspaceId: string;
    readonly sourceId: string;
    readonly versionId: string;
  }>,
): Promise<void> {
  await pool.query(
    `INSERT INTO administration_configurations (
       id, workspace_id, resource_type, lifecycle, current_version_id
     ) VALUES ($1, $2, 'knowledge-sources', 'active', NULL)`,
    [input.sourceId, input.workspaceId],
  );
  await pool.query(
    `INSERT INTO administration_configuration_versions (
       id, workspace_id, configuration_id, version, settings, secret_references
     ) VALUES ($1, $2, $3, 1, '{}'::jsonb, '[]'::jsonb)`,
    [input.versionId, input.workspaceId, input.sourceId],
  );
  await pool.query(
    `UPDATE administration_configurations
     SET current_version_id = $1
     WHERE workspace_id = $2 AND id = $3`,
    [input.versionId, input.workspaceId, input.sourceId],
  );
}

async function seedDatabase(): Promise<void> {
  await seedWorkspaceKnowledge(workspace, source);
  await seedWorkspaceKnowledge(foreignWorkspace, foreignSource);
  await pool.query(
    "INSERT INTO principals (id, workspace_id) VALUES ($1, $2)",
    [principal, workspace],
  );
  await pool.query(
    `INSERT INTO workspace_role_assignments (workspace_id, principal_id, role)
     VALUES ($1, $2, 'administrator')`,
    [workspace, principal],
  );
}

function context(): ExecutionContext {
  return {
    requestId: requestId("request-source-command"),
    workspaceId: workspaceId(workspace),
    principalId: principalId(principal),
    correlationId: correlationId("correlation-source-command"),
    signal: new AbortController().signal,
  };
}

function subject() {
  const persistence = createPostgresPersistence({ databaseUrl });
  return {
    persistence,
    useCase: new RequestKnowledgeSourceSynchronization(
      persistence.unitOfWork,
      persistence.knowledgeSourceCommandStore,
      persistence.outboxStore,
      persistence.auditStore,
      persistence.authorizationGuard,
      ids,
      clock,
    ),
  };
}

beforeEach(async () => {
  await resetDatabase();
  await seedDatabase();
});

afterAll(async () => {
  await pool.end();
});

describe("PostgreSQL knowledge source command persistence", () => {
  it("commits a version-pinned command, idempotency record, and audit atomically", async () => {
    const { persistence, useCase } = subject();
    const command = {
      sourceId: source,
      kind: "synchronize" as const,
      idempotencyKeyDigest: sha256Digest("a".repeat(64)),
      requestDigest: sha256Digest("b".repeat(64)),
    };
    try {
      const first = await useCase.execute(command, context());
      const replay = await useCase.execute(command, context());

      expect(first).toMatchObject({
        status: "queued",
        configurationVersion: "source-configuration-v7",
        replayed: false,
      });
      expect(replay).toEqual({ ...first, replayed: true });
      const outbox = await pool.query<{
        type: string;
        payload: {
          sourceId: string;
          configurationVersion: string;
          trigger: string;
        };
      }>("SELECT type, payload FROM outbox_envelopes WHERE workspace_id = $1", [
        workspace,
      ]);
      expect(outbox.rows).toEqual([
        {
          type: "knowledge.synchronize.v1",
          payload: {
            sourceId: source,
            configurationVersion: "source-configuration-v7",
            trigger: "manual",
          },
        },
      ]);
      const audit = await pool.query<{
        action: string;
        outcome: string;
        permission: string;
        target_id: string;
      }>(
        "SELECT action, outcome, permission, target_id FROM audit_events WHERE workspace_id = $1",
        [workspace],
      );
      expect(audit.rows).toEqual([
        {
          action: "knowledgeSource.synchronization.queued",
          outcome: "succeeded",
          permission: "connector.manage",
          target_id: source,
        },
      ]);
      const idempotency = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM idempotency_records WHERE workspace_id = $1",
        [workspace],
      );
      expect(idempotency.rows[0]?.count).toBe("1");
    } finally {
      await persistence.close();
    }
  });

  it("enforces full-rescan cooldown and cannot resolve a source from another workspace", async () => {
    const { persistence, useCase } = subject();
    try {
      await expect(
        useCase.execute(
          {
            sourceId: source,
            kind: "fullRescan",
            idempotencyKeyDigest: sha256Digest("c".repeat(64)),
            requestDigest: sha256Digest("d".repeat(64)),
          },
          context(),
        ),
      ).resolves.toMatchObject({ status: "queued" });
      await expect(
        useCase.execute(
          {
            sourceId: source,
            kind: "fullRescan",
            idempotencyKeyDigest: sha256Digest("e".repeat(64)),
            requestDigest: sha256Digest("f".repeat(64)),
          },
          context(),
        ),
      ).resolves.toEqual({ status: "cooldown", replayed: false });
      await expect(
        useCase.execute(
          {
            sourceId: foreignSource,
            kind: "synchronize",
            idempotencyKeyDigest: sha256Digest("1".repeat(64)),
            requestDigest: sha256Digest("2".repeat(64)),
          },
          context(),
        ),
      ).resolves.toEqual({ status: "unavailable", replayed: false });

      const foreignOutbox = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM outbox_envelopes WHERE workspace_id = $1",
        [foreignWorkspace],
      );
      expect(foreignOutbox.rows[0]?.count).toBe("0");
      const sourceState = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM knowledge_source_states WHERE workspace_id = $1 AND knowledge_source_id = $2",
        [workspace, source],
      );
      expect(sourceState.rows[0]?.count).toBe("1");
    } finally {
      await persistence.close();
    }
  });
});
