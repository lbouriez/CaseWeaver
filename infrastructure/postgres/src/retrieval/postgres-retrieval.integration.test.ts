import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPostgresRetrievalPersistence,
  PostgresRetrievalSnapshotConflictError,
  PostgresRetrievalValidationError,
} from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error(
    "PostgreSQL integration tests require DATABASE_URL for a disposable test database.",
  );
}
if (!new URL(databaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error(
    "PostgreSQL integration DATABASE_URL must name a test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const persistence = createPostgresRetrievalPersistence({ databaseUrl });
const controller = new AbortController();

const workspaceId = "retrieval-workspace";
const collection = {
  id: "retrieval-collection",
  embeddingBindingVersionId: "retrieval-binding-version",
  embeddingProfileVersion: "retrieval-profile-v1",
  dimensions: 3,
} as const;

async function resetDatabase(): Promise<void> {
  await pool.query(
    "TRUNCATE TABLE workspaces, ai_catalog_snapshots RESTART IDENTITY CASCADE",
  );
}

async function seedAiBinding(): Promise<void> {
  await pool.query(
    `INSERT INTO ai_catalog_snapshots (
       id, upstream_url, upstream_commit_sha, fetched_at, sha256, raw_entries
     ) VALUES (
       'retrieval-catalog', 'https://catalog.example/retrieval.json',
       'retrieval-sha', now(), repeat('a', 64), '{}'::jsonb
     )`,
  );
  await pool.query(
    `INSERT INTO ai_catalog_models (
       id, catalog_snapshot_id, canonical_model, provider, supported_roles,
       capabilities, raw_entry
     ) VALUES (
       'retrieval-model', 'retrieval-catalog', 'embedding-model', 'fake',
       '["embedding"]'::jsonb, '[]'::jsonb, '{}'::jsonb
     )`,
  );
  await pool.query(
    `INSERT INTO ai_provider_instances (
       id, workspace_id, provider_type, lifecycle
     ) VALUES ('retrieval-provider', $1, 'fake', 'active')`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO ai_provider_instance_versions (
       id, workspace_id, provider_instance_id, version, endpoint, wire_api,
       parameters, secret_reference
     ) VALUES (
       'retrieval-provider-version', $1, 'retrieval-provider', 1,
       'https://fake.example/retrieval', 'embeddings', '{}'::jsonb,
       'vault:retrieval'
     )`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO ai_model_bindings (id, workspace_id, role, lifecycle)
     VALUES ('retrieval-binding', $1, 'embedding', 'active')`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO ai_model_binding_versions (
       id, workspace_id, model_binding_id, version, provider_instance_version_id,
       catalog_snapshot_id, catalog_model_id, canonical_model, wire_api,
       parameters, capabilities, secret_reference
     ) VALUES (
       $1, $2, 'retrieval-binding', 1, 'retrieval-provider-version',
       'retrieval-catalog', 'retrieval-model', 'embedding-model', 'embeddings',
       '{}'::jsonb, '[]'::jsonb, 'vault:retrieval'
     )`,
    [collection.embeddingBindingVersionId, workspaceId],
  );
}

async function seedKnowledge(): Promise<void> {
  const connectorConfigurationVersionId =
    "retrieval-connector-configuration-v1";
  await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [workspaceId]);
  await seedAiBinding();
  await pool.query(
    `INSERT INTO connector_registrations (id, workspace_id, lifecycle)
     VALUES ('retrieval-connector', $1, 'active')`,
    [workspaceId],
  );
  await seedConnectorConfiguration({
    versionId: connectorConfigurationVersionId,
  });
  await pool.query(
    `INSERT INTO knowledge_collections (
       id, workspace_id, embedding_binding_version_id,
       embedding_profile_version, dimensions
     ) VALUES ($1, $2, $3, $4, $5)`,
    [
      collection.id,
      workspaceId,
      collection.embeddingBindingVersionId,
      collection.embeddingProfileVersion,
      collection.dimensions,
    ],
  );
  for (const sourceId of [
    "retrieval-source-active",
    "retrieval-source-denied",
  ]) {
    const configurationVersionId = `${sourceId}-configuration-v1`;
    await seedSourceConfiguration({
      sourceId,
      versionId: configurationVersionId,
    });
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
           $1, $2, 'retrieval-connector', $3, 'enabled', $4, $5,
           'normalization-v1', 'chunking-v1', '{}'::jsonb, 'tombstone'
         )`,
        [
          sourceId,
          workspaceId,
          collection.id,
          configurationVersionId,
          connectorConfigurationVersionId,
        ],
      );
      await client.query(
        `INSERT INTO knowledge_source_runtime_versions (
           workspace_id, knowledge_source_id, source_configuration_version_id,
           connector_registration_id, connector_configuration_version_id
         ) VALUES ($1, $2, $3, 'retrieval-connector', $4)`,
        [
          workspaceId,
          sourceId,
          configurationVersionId,
          connectorConfigurationVersionId,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  await seedDocument({
    documentId: "retrieval-document-active",
    referenceId: "retrieval-reference-active",
    revisionId: "retrieval-revision-active",
    cacheId: "retrieval-cache-active",
    cacheHash: `${"b".repeat(63)}1`,
    chunkId: "retrieval-chunk-active",
    sourceId: "retrieval-source-active",
    lifecycle: "active",
    content: "Password reset steps for Widget",
    metadata: { product: "widget", visibility: "internal" },
  });
  await seedDocument({
    documentId: "retrieval-document-tombstoned",
    referenceId: "retrieval-reference-tombstoned",
    revisionId: "retrieval-revision-tombstoned",
    cacheId: "retrieval-cache-tombstoned",
    cacheHash: `${"b".repeat(63)}2`,
    chunkId: "retrieval-chunk-tombstoned",
    sourceId: "retrieval-source-active",
    lifecycle: "tombstoned",
    content: "Password reset steps from a removed revision",
    metadata: { product: "widget" },
  });
  await seedDocument({
    documentId: "retrieval-document-denied",
    referenceId: "retrieval-reference-denied",
    revisionId: "retrieval-revision-denied",
    cacheId: "retrieval-cache-denied",
    cacheHash: `${"b".repeat(63)}3`,
    chunkId: "retrieval-chunk-denied",
    sourceId: "retrieval-source-denied",
    lifecycle: "active",
    content: "Password reset secret for Widget",
    metadata: { product: "widget" },
  });
}

async function seedSourceConfiguration(
  input: Readonly<{
    readonly sourceId: string;
    readonly versionId: string;
  }>,
): Promise<void> {
  await pool.query(
    `INSERT INTO administration_configurations (
       id, workspace_id, resource_type, lifecycle, current_version_id
     ) VALUES ($1, $2, 'knowledge-sources', 'active', NULL)`,
    [input.sourceId, workspaceId],
  );
  await pool.query(
    `INSERT INTO administration_configuration_versions (
       id, workspace_id, configuration_id, version, settings, secret_references
     ) VALUES ($1, $2, $3, 1, '{}'::jsonb, '[]'::jsonb)`,
    [input.versionId, workspaceId, input.sourceId],
  );
  await pool.query(
    `UPDATE administration_configurations
     SET current_version_id = $1
     WHERE workspace_id = $2 AND id = $3`,
    [input.versionId, workspaceId, input.sourceId],
  );
}

async function seedConnectorConfiguration(input: {
  readonly versionId: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO connector_capabilities (
       workspace_id, connector_registration_id, capability
     ) VALUES ($1, 'retrieval-connector', 'knowledgeSource')`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO administration_descriptor_revisions (
       kind, type, version, descriptor, descriptor_hash
     ) VALUES ('connector', 'retrieval-test-connector', 'v1', '{}'::jsonb, repeat('a', 64))
     ON CONFLICT (kind, type, version) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO administration_configurations (
       id, workspace_id, resource_type, lifecycle, current_version_id
     ) VALUES ('retrieval-connector', $1, 'connector-instances', 'active', NULL)`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO administration_configuration_versions (
       id, workspace_id, configuration_id, version, settings, secret_references,
       descriptor_kind, descriptor_type, descriptor_version
     ) VALUES ($1, $2, 'retrieval-connector', 1, '{}'::jsonb, '[]'::jsonb,
       'connector', 'retrieval-test-connector', 'v1')`,
    [input.versionId, workspaceId],
  );
  await pool.query(
    `UPDATE administration_configurations
     SET current_version_id = $1
     WHERE workspace_id = $2 AND id = 'retrieval-connector'`,
    [input.versionId, workspaceId],
  );
}

async function seedDocument(input: {
  readonly documentId: string;
  readonly referenceId: string;
  readonly revisionId: string;
  readonly cacheId: string;
  readonly cacheHash: string;
  readonly chunkId: string;
  readonly sourceId: string;
  readonly lifecycle: "active" | "tombstoned";
  readonly content: string;
  readonly metadata: Readonly<Record<string, string>>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO external_references (
       id, workspace_id, connector_registration_id, kind, external_id
     ) VALUES ($1, $2, 'retrieval-connector', 'document', $3)`,
    [input.referenceId, workspaceId, input.referenceId],
  );
  await pool.query(
    `INSERT INTO knowledge_documents (
       id, workspace_id, knowledge_source_id, external_reference_id, lifecycle,
       observed_at
     ) VALUES ($1, $2, $3, $4, $5, '2026-07-14T14:00:00.000Z')`,
    [
      input.documentId,
      workspaceId,
      input.sourceId,
      input.referenceId,
      input.lifecycle,
    ],
  );
  await pool.query(
    `INSERT INTO knowledge_revisions (
       id, workspace_id, knowledge_document_id, revision_ordinal, state,
       content_hash, normalization_profile_version, chunking_profile_version,
       embedding_binding_version_id, embedding_profile_version,
       embedding_dimensions, normalized_content, source_url, metadata,
       activated_at
     ) VALUES (
       $1, $2, $3, 1, 'active', repeat('a', 64), 'normalization-v1',
       'chunking-v1', $4, $5, 3, $6, 'https://example.invalid/retrieval',
       $7::jsonb, '2026-07-14T14:00:00.000Z'
     )`,
    [
      input.revisionId,
      workspaceId,
      input.documentId,
      collection.embeddingBindingVersionId,
      collection.embeddingProfileVersion,
      input.content,
      JSON.stringify(input.metadata),
    ],
  );
  await pool.query(
    `UPDATE knowledge_documents
     SET active_revision_id = $1
     WHERE workspace_id = $2 AND id = $3`,
    [input.revisionId, workspaceId, input.documentId],
  );
  await pool.query(
    `INSERT INTO knowledge_embedding_cache_entries (
       id, workspace_id, chunk_hash, embedding_binding_version_id,
       embedding_profile_version, dimensions, normalization_profile_version,
       embedding
     ) VALUES (
       $1, $2, $3, $4, $5, 3, 'normalization-v1',
       '[1,0,0]'::vector
     )`,
    [
      input.cacheId,
      workspaceId,
      input.cacheHash,
      collection.embeddingBindingVersionId,
      collection.embeddingProfileVersion,
    ],
  );
  await pool.query(
    `INSERT INTO knowledge_chunks (
       id, workspace_id, knowledge_revision_id, position, content_hash, content,
       source_anchor, embedding_cache_entry_id
     ) VALUES (
       $1, $2, $3, 0, repeat('c', 64), $4, '#reset', $5
     )`,
    [
      input.chunkId,
      workspaceId,
      input.revisionId,
      input.content,
      input.cacheId,
    ],
  );
}

function searchInput() {
  return {
    workspaceId,
    query: "password reset",
    collections: [collection],
    vectorQueries: [
      {
        embeddingBindingVersionId: collection.embeddingBindingVersionId,
        embeddingProfileVersion: collection.embeddingProfileVersion,
        dimensions: collection.dimensions,
        collectionIds: [collection.id],
        vector: [1, 0, 0],
      },
    ],
    access: {
      authorizedSourceIds: ["retrieval-source-active"],
    },
    metadataFilters: { product: ["widget"] },
    maximumCandidatesPerSource: 2,
    signal: controller.signal,
  };
}

beforeEach(async () => {
  await resetDatabase();
  await seedKnowledge();
});

afterAll(async () => {
  await persistence.close();
  await pool.end();
});

describe("PostgreSQL retrieval adapter", () => {
  it("uses bounded lexical and vector search while enforcing workspace, source, and active-revision access", async () => {
    const candidates = await persistence.search.search(searchInput());

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.chunkId)).toEqual([
      "retrieval-chunk-active",
      "retrieval-chunk-active",
    ]);
    expect(candidates[0]).toMatchObject({
      sourceId: "retrieval-source-active",
      sourceRevisionId: "retrieval-revision-active",
      location: "#reset",
      lexicalRank: 1,
      accessMetadata: { product: "widget", visibility: "internal" },
    });
    expect(candidates[1]).toMatchObject({
      sourceId: "retrieval-source-active",
      vectorRank: 1,
    });
    expect(
      candidates.some(
        (candidate) =>
          candidate.chunkId === "retrieval-chunk-denied" ||
          candidate.chunkId === "retrieval-chunk-tombstoned",
      ),
    ).toBe(false);
  });

  it("caps lexical and vector candidates per authorized source in PostgreSQL", async () => {
    await seedDocument({
      documentId: "retrieval-document-second",
      referenceId: "retrieval-reference-second",
      revisionId: "retrieval-revision-second",
      cacheId: "retrieval-cache-second",
      cacheHash: `${"b".repeat(63)}4`,
      chunkId: "retrieval-chunk-second",
      sourceId: "retrieval-source-active",
      lifecycle: "active",
      content: "Alternative password reset steps for Widget",
      metadata: { product: "widget" },
    });

    const candidates = await persistence.search.search({
      ...searchInput(),
      maximumCandidatesPerSource: 1,
    });

    expect(
      candidates.filter((candidate) => candidate.lexicalRank !== undefined),
    ).toHaveLength(1);
    expect(
      candidates.filter((candidate) => candidate.vectorRank !== undefined),
    ).toHaveLength(1);
  });

  it("rejects dimensions outside the finite indexed configuration", async () => {
    const input = searchInput();
    const vectorQuery = input.vectorQueries[0];
    if (vectorQuery === undefined)
      throw new Error("Missing test query vector.");
    await expect(
      persistence.search.search({
        ...input,
        collections: [{ ...collection, dimensions: 2 }],
        vectorQueries: [
          {
            ...vectorQuery,
            dimensions: 2,
            vector: [1, 0],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(PostgresRetrievalValidationError);

    await expect(
      pool.query(
        `INSERT INTO knowledge_collections (
           id, workspace_id, embedding_binding_version_id,
           embedding_profile_version, dimensions
         ) VALUES (
           'retrieval-unsupported-dimension', $1, $2, 'retrieval-profile-v1', 2
         )`,
        [workspaceId, collection.embeddingBindingVersionId],
      ),
    ).rejects.toThrow();
  });

  it("persists selected evidence and scopes snapshot ID conflicts to a workspace", async () => {
    await persistence.snapshots.persist({
      id: "retrieval-snapshot",
      workspaceId,
      analysisId: "analysis-1",
      capturedAt: "2026-07-14T14:05:00.000Z",
      query: "password reset",
      profileId: "retrieval.v1",
      profileVersion: "1",
      queryEmbeddingOperationIds: {
        "embedding.z": "operation-z",
        "embedding.a": "operation-a",
      },
      rerankerOperationId: "reranker-operation",
      evidence: [
        {
          collectionId: collection.id,
          sourceId: "retrieval-source-active",
          sourceRevisionId: "retrieval-revision-active",
          chunkId: "retrieval-chunk-active",
          location: "#reset",
          sourceUrl: "https://example.invalid/retrieval",
          content: "Password reset steps for Widget",
          accessMetadata: { visibility: "internal", product: "widget" },
          scores: {
            fusedRrf: 0.1,
            lexicalRrf: 0.05,
            vectorRrf: 0.05,
          },
          characterCount: "Password reset steps for Widget".length,
          tokenCount: 5,
        },
      ],
    });

    const persisted = await pool.query<{
      readonly query_embedding_operation_ids: Record<string, string>;
      readonly ordinal: number;
      readonly chunk_id: string;
      readonly access_metadata: Record<string, string>;
      readonly fused_rrf: number;
    }>(
      `SELECT
         snapshot.query_embedding_operation_ids,
         evidence.ordinal,
         evidence.chunk_id,
         evidence.access_metadata,
         evidence.fused_rrf
       FROM retrieval_snapshots AS snapshot
       JOIN retrieval_snapshot_evidence AS evidence
         ON evidence.workspace_id = snapshot.workspace_id
        AND evidence.retrieval_snapshot_id = snapshot.id
       WHERE snapshot.workspace_id = $1 AND snapshot.id = $2`,
      [workspaceId, "retrieval-snapshot"],
    );

    expect(persisted.rows).toEqual([
      {
        query_embedding_operation_ids: {
          "embedding.a": "operation-a",
          "embedding.z": "operation-z",
        },
        ordinal: 0,
        chunk_id: "retrieval-chunk-active",
        access_metadata: { product: "widget", visibility: "internal" },
        fused_rrf: 0.1,
      },
    ]);
    await expect(
      pool.query(
        `UPDATE retrieval_snapshots
         SET query = 'replacement'
         WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, "retrieval-snapshot"],
      ),
    ).rejects.toThrow();
    const secondWorkspaceId = "retrieval-workspace-second";
    await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [
      secondWorkspaceId,
    ]);
    await persistence.snapshots.persist({
      id: "retrieval-snapshot",
      workspaceId: secondWorkspaceId,
      capturedAt: "2026-07-14T14:05:00.000Z",
      query: "password reset",
      profileId: "retrieval.v1",
      profileVersion: "1",
      queryEmbeddingOperationIds: {},
      evidence: [],
    });
    expect(
      (
        await pool.query<{ readonly workspace_id: string }>(
          `SELECT workspace_id
           FROM retrieval_snapshots
           WHERE id = $1
           ORDER BY workspace_id`,
          ["retrieval-snapshot"],
        )
      ).rows,
    ).toEqual([
      { workspace_id: workspaceId },
      { workspace_id: secondWorkspaceId },
    ]);
    await expect(
      persistence.snapshots.persist({
        id: "retrieval-snapshot",
        workspaceId,
        capturedAt: "2026-07-14T14:05:00.000Z",
        query: "password reset",
        profileId: "retrieval.v1",
        profileVersion: "1",
        queryEmbeddingOperationIds: {},
        evidence: [],
      }),
    ).rejects.toBeInstanceOf(PostgresRetrievalSnapshotConflictError);
  });
});
