import {
  KnowledgeExecutionFenceError,
  type KnowledgeIngestionStore,
} from "@caseweaver/knowledge";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresKnowledgeIngestionStore } from "./index.js";
import {
  PostgresKnowledgeSourceExecutionStore,
  PostgresPinnedKnowledgeSourceConfigurationResolver,
} from "./runtime-execution.js";

const databaseUrl = process.env.DATABASE_URL;
if (
  databaseUrl === undefined ||
  !new URL(databaseUrl).pathname.toLowerCase().includes("test")
) {
  throw new Error(
    "Knowledge runtime PostgreSQL tests require a disposable test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const workspace = "workspace-knowledge-runtime";
const source = "source-knowledge-runtime";
const resolver = new PostgresPinnedKnowledgeSourceConfigurationResolver(pool);
const executions = new PostgresKnowledgeSourceExecutionStore(pool);

beforeEach(async () => {
  await pool.query(
    "TRUNCATE TABLE administration_descriptor_revisions, workspaces, ai_catalog_snapshots RESTART IDENTITY CASCADE",
  );
  await seedRuntime();
});

afterAll(async () => {
  await pool.end();
});

describe("PostgreSQL knowledge execution runtime", () => {
  it("resolves only an exact workspace-scoped immutable source/connector/collection pin", async () => {
    const resolved = await resolve();

    expect(resolved).toEqual({
      workspaceId: workspace,
      sourceId: source,
      sourceConfigurationVersionId: "source-runtime-v1",
      connectorConfigurationVersionId: "connector-runtime-v1",
      connectorRegistrationId: "connector-runtime",
      collection: {
        id: "collection-runtime",
        runtimeVersionId: "collection-runtime-v1",
        embeddingBindingVersionId: "binding-runtime-v1",
        embeddingProfileVersion: "embedding-v1",
        dimensions: 3,
        maximumInputTokens: 100,
        budget: {
          currency: "USD",
          hard: true,
          policyReference: "budget-policy-runtime-v1",
        },
      },
      normalizationProfile: { id: "text-normalization", version: "v1" },
      chunkingProfile: { id: "text-chunking", version: "v1" },
      synchronization: { triggers: [{ mode: "manual" }] },
      embeddingBatchSize: 10,
    });
    await expect(
      resolver.resolve({
        workspaceId: "workspace-foreign",
        sourceId: source,
        sourceConfigurationVersionId: "source-runtime-v1",
        connectorConfigurationVersionId: "connector-runtime-v1",
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolver.resolve({
        workspaceId: workspace,
        sourceId: source,
        sourceConfigurationVersionId: "source-runtime-v1",
        connectorConfigurationVersionId: "connector-runtime-v2",
      }),
    ).resolves.toBeUndefined();
    expect(JSON.stringify(resolved)).not.toContain("secret");
  });

  it("treats an incomplete legacy runtime row as permanently unavailable", async () => {
    await insertSourceConfiguration("source-runtime-legacy");
    await pool.query(
      `INSERT INTO knowledge_source_runtime_versions (
         workspace_id, knowledge_source_id, source_configuration_version_id,
         connector_registration_id, connector_configuration_version_id
       ) VALUES ($1, $2, 'source-runtime-legacy', 'connector-runtime', 'connector-runtime-v1')`,
      [workspace, source],
    );

    await expect(
      resolver.resolve({
        workspaceId: workspace,
        sourceId: source,
        sourceConfigurationVersionId: "source-runtime-legacy",
        connectorConfigurationVersionId: "connector-runtime-v1",
      }),
    ).resolves.toBeUndefined();
  });

  it("projects the immutable source attachment stage without following a current policy pointer", async () => {
    await seedAttachmentPolicy();
    await insertSourceConfiguration("source-runtime-attachment");
    await pool.query(
      `INSERT INTO knowledge_source_runtime_versions (
         workspace_id, knowledge_source_id, source_configuration_version_id,
         connector_registration_id, connector_configuration_version_id,
         knowledge_collection_id, collection_runtime_version_id,
         normalization_profile_id, normalization_profile_version,
         chunking_profile_id, chunking_profile_version, synchronization_policy,
         embedding_batch_size, attachment_stage_mode,
         attachment_policy_configuration_version_id, attachment_access_policy_hash
       ) VALUES (
         $1, $2, 'source-runtime-attachment', 'connector-runtime', 'connector-runtime-v1',
         'collection-runtime', 'collection-runtime-v1',
         'text-normalization', 'v1', 'text-chunking', 'v1',
         '{"triggers":[{"mode":"manual"}]}'::jsonb, 10, 'optional',
         'attachment-policy-runtime-v1', repeat('d', 64)
       )`,
      [workspace, source],
    );

    await expect(
      resolver.resolve({
        workspaceId: workspace,
        sourceId: source,
        sourceConfigurationVersionId: "source-runtime-attachment",
        connectorConfigurationVersionId: "connector-runtime-v1",
      }),
    ).resolves.toMatchObject({
      attachmentPreparation: {
        mode: "optional",
        policyVersion: "attachment-policy-runtime-v1",
        accessPolicyHash: "d".repeat(64),
      },
    });
  });

  it("claims cursor and fence atomically, rejects stale commit, and permits the current fence", async () => {
    await pool.query(
      `INSERT INTO knowledge_source_states (
         workspace_id, knowledge_source_id, cursor_version, cursor_value
       ) VALUES ($1, $2, 'cursor-v1', 'cursor-1')`,
      [workspace, source],
    );
    const first = await executions.claim({
      workspaceId: workspace,
      sourceId: source,
      mode: "incremental",
      leaseMs: 30_000,
    });
    expect(first).toMatchObject({
      fence: { value: "1" },
      cursor: { version: "cursor-v1", value: "cursor-1" },
    });
    await expect(
      executions.claim({
        workspaceId: workspace,
        sourceId: source,
        mode: "incremental",
        leaseMs: 30_000,
      }),
    ).resolves.toBeUndefined();
    expect(first).toBeDefined();
    await expect(
      executions.renew({
        workspaceId: workspace,
        sourceId: source,
        fence: first?.fence ?? { value: "0" },
        leaseMs: 30_000,
      }),
    ).resolves.toBe(true);
    await executions.cancel({
      workspaceId: workspace,
      sourceId: source,
      fence: first?.fence ?? { value: "0" },
    });
    const replacement = await executions.claim({
      workspaceId: workspace,
      sourceId: source,
      mode: "fullRescan",
      leaseMs: 30_000,
    });
    expect(replacement).toMatchObject({ fence: { value: "2" } });

    const ingestion = new PostgresKnowledgeIngestionStore(pool);
    const scan = {
      mode: "delta" as const,
      completedAt: "2026-07-15T12:00:00.000Z",
    };
    await expect(
      ingestion.commit({
        workspaceId: workspace,
        sourceId: source,
        fence: first?.fence ?? { value: "0" },
        scan,
        mutations: [],
        newEmbeddings: [],
      } satisfies Parameters<KnowledgeIngestionStore["commit"]>[0]),
    ).rejects.toBeInstanceOf(KnowledgeExecutionFenceError);
    await expect(
      ingestion.commit({
        workspaceId: workspace,
        sourceId: source,
        fence: replacement?.fence ?? { value: "0" },
        scan,
        mutations: [],
        newEmbeddings: [],
      } satisfies Parameters<KnowledgeIngestionStore["commit"]>[0]),
    ).resolves.toBeUndefined();
  });
});

function resolve() {
  return resolver.resolve({
    workspaceId: workspace,
    sourceId: source,
    sourceConfigurationVersionId: "source-runtime-v1",
    connectorConfigurationVersionId: "connector-runtime-v1",
  });
}

async function seedRuntime(): Promise<void> {
  await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [workspace]);
  await pool.query(
    `INSERT INTO ai_catalog_snapshots (
       id, upstream_url, upstream_commit_sha, fetched_at, sha256, raw_entries
     ) VALUES ('catalog-runtime', 'https://catalog.example/runtime', 'commit-runtime', now(), repeat('a', 64), '{}'::jsonb)`,
  );
  await pool.query(
    `INSERT INTO ai_catalog_models (
       id, catalog_snapshot_id, canonical_model, provider, supported_roles, capabilities, raw_entry
     ) VALUES ('model-runtime', 'catalog-runtime', 'runtime-embedding', 'test', '["embedding"]'::jsonb, '[]'::jsonb, '{}'::jsonb)`,
  );
  await pool.query(
    `INSERT INTO ai_provider_instances (id, workspace_id, provider_type, lifecycle)
     VALUES ('provider-runtime', $1, 'test', 'active')`,
    [workspace],
  );
  await pool.query(
    `INSERT INTO ai_provider_instance_versions (
       id, workspace_id, provider_instance_id, version, endpoint, wire_api, parameters, secret_reference
     ) VALUES ('provider-runtime-v1', $1, 'provider-runtime', 1, 'https://provider.example/runtime', 'embeddings', '{}'::jsonb, 'vault:runtime')`,
    [workspace],
  );
  await pool.query(
    `INSERT INTO ai_model_bindings (id, workspace_id, role, lifecycle)
     VALUES ('binding-runtime', $1, 'embedding', 'active')`,
    [workspace],
  );
  await pool.query(
    `INSERT INTO ai_model_binding_versions (
       id, workspace_id, model_binding_id, version, provider_instance_version_id,
       catalog_snapshot_id, catalog_model_id, canonical_model, wire_api,
       parameters, capabilities, secret_reference
     ) VALUES (
       'binding-runtime-v1', $1, 'binding-runtime', 1, 'provider-runtime-v1',
       'catalog-runtime', 'model-runtime', 'runtime-embedding', 'embeddings',
       '{}'::jsonb, '[]'::jsonb, 'vault:runtime'
     )`,
    [workspace],
  );
  await pool.query(
    `INSERT INTO connector_registrations (id, workspace_id, lifecycle)
     VALUES ('connector-runtime', $1, 'active')`,
    [workspace],
  );
  await pool.query(
    `INSERT INTO connector_capabilities (workspace_id, connector_registration_id, capability)
     VALUES ($1, 'connector-runtime', 'knowledgeSource')`,
    [workspace],
  );
  await pool.query(
    `INSERT INTO administration_descriptor_revisions (
       kind, type, version, descriptor, descriptor_hash
     ) VALUES ('connector', 'runtime-connector', 'v1', '{}'::jsonb, repeat('a', 64))`,
  );
  await pool.query(
    `INSERT INTO administration_configurations (
       id, workspace_id, resource_type, lifecycle, current_version_id
     ) VALUES ('connector-runtime', $1, 'connector-instances', 'active', NULL)`,
    [workspace],
  );
  await pool.query(
    `INSERT INTO administration_configuration_versions (
       id, workspace_id, configuration_id, version, settings, secret_references,
       descriptor_kind, descriptor_type, descriptor_version
     ) VALUES (
       'connector-runtime-v1', $1, 'connector-runtime', 1, '{}'::jsonb, '[]'::jsonb,
       'connector', 'runtime-connector', 'v1'
     )`,
    [workspace],
  );
  await pool.query(
    `UPDATE administration_configurations
       SET current_version_id = 'connector-runtime-v1'
     WHERE workspace_id = $1 AND id = 'connector-runtime'`,
    [workspace],
  );
  await insertSourceConfiguration("source-runtime-v1");
  await pool.query(
    `INSERT INTO knowledge_collections (
       id, workspace_id, embedding_binding_version_id, embedding_profile_version, dimensions
     ) VALUES ('collection-runtime', $1, 'binding-runtime-v1', 'embedding-v1', 3)`,
    [workspace],
  );
  await pool.query(
    `INSERT INTO knowledge_collection_runtime_versions (
       id, workspace_id, knowledge_collection_id, embedding_binding_version_id,
       embedding_profile_version, dimensions, maximum_input_tokens, budget_currency,
       budget_hard, budget_policy_reference
     ) VALUES (
       'collection-runtime-v1', $1, 'collection-runtime', 'binding-runtime-v1',
       'embedding-v1', 3, 100, 'USD', true, 'budget-policy-runtime-v1'
     )`,
    [workspace],
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO knowledge_sources (
         id, workspace_id, connector_registration_id, knowledge_collection_id,
         lifecycle, configuration_version, connector_configuration_version_id,
         normalization_profile_version, chunking_profile_version,
         synchronization_policy, deletion_behavior
       ) VALUES (
         $1, $2, 'connector-runtime', 'collection-runtime', 'enabled',
         'source-runtime-v1', 'connector-runtime-v1', 'v1', 'v1', '{}'::jsonb, 'tombstone'
       )`,
      [source, workspace],
    );
    await client.query(
      `INSERT INTO knowledge_source_runtime_versions (
         workspace_id, knowledge_source_id, source_configuration_version_id,
         connector_registration_id, connector_configuration_version_id,
         knowledge_collection_id, collection_runtime_version_id,
         normalization_profile_id, normalization_profile_version,
         chunking_profile_id, chunking_profile_version, synchronization_policy,
         embedding_batch_size
       ) VALUES (
         $1, $2, 'source-runtime-v1', 'connector-runtime', 'connector-runtime-v1',
         'collection-runtime', 'collection-runtime-v1',
       'text-normalization', 'v1', 'text-chunking', 'v1', '{"triggers":[{"mode":"manual"}]}'::jsonb, 10
       )`,
      [workspace, source],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertSourceConfiguration(versionId: string): Promise<void> {
  const revision = versionId === "source-runtime-v1" ? 1 : 2;
  if (revision === 1) {
    await pool.query(
      `INSERT INTO administration_configurations (
         id, workspace_id, resource_type, lifecycle, current_version_id
       ) VALUES ($1, $2, 'knowledge-sources', 'active', NULL)`,
      [source, workspace],
    );
  }
  await pool.query(
    `INSERT INTO administration_configuration_versions (
       id, workspace_id, configuration_id, version, settings, secret_references
     ) VALUES ($1, $2, $3, $4, '{}'::jsonb, '[]'::jsonb)`,
    [versionId, workspace, source, revision],
  );
  if (revision === 1) {
    await pool.query(
      `UPDATE administration_configurations SET current_version_id = $1
       WHERE workspace_id = $2 AND id = $3`,
      [versionId, workspace, source],
    );
  }
}

async function seedAttachmentPolicy(): Promise<void> {
  await pool.query(
    `INSERT INTO administration_configurations (
       id, workspace_id, resource_type, lifecycle, current_version_id
     ) VALUES ('attachment-policy-runtime', $1, 'attachment-policies', 'active', NULL)`,
    [workspace],
  );
  await pool.query(
    `INSERT INTO administration_configuration_versions (
       id, workspace_id, configuration_id, version, settings, secret_references
     ) VALUES (
       'attachment-policy-runtime-v1', $1, 'attachment-policy-runtime', 1,
       '{}'::jsonb, '[]'::jsonb
     )`,
    [workspace],
  );
  await pool.query(
    `UPDATE administration_configurations
        SET current_version_id = 'attachment-policy-runtime-v1'
      WHERE workspace_id = $1 AND id = 'attachment-policy-runtime'`,
    [workspace],
  );
  await pool.query(
    `INSERT INTO attachment_policy_versions (
       id, workspace_id, configuration_version_id,
       processor_security_policy_version_id, vision_binding_version_id,
       maximum_attachment_count, maximum_attachment_bytes,
       maximum_archive_entries, maximum_expanded_archive_bytes,
       maximum_archive_depth
     ) VALUES (
       'attachment-policy-runtime-record', $1, 'attachment-policy-runtime-v1',
       'attachment-security-runtime-v1', 'binding-runtime-v1',
       8, 4096, 20, 8192, 2
     )`,
    [workspace],
  );
}
