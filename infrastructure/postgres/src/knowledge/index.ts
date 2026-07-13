import { createHash } from "node:crypto";

import type {
  CachedEmbedding,
  EmbeddingCacheIdentity,
  FailedRevisionDiagnostic,
  KnowledgeIngestionStore,
  KnowledgeMutation,
  NewCachedEmbedding,
} from "@caseweaver/knowledge";
import type { Pool, PoolClient, QueryResultRow } from "pg";

type KnowledgeReference = Extract<
  KnowledgeMutation,
  { readonly reference: unknown }
>["reference"];
type VersionedOpaqueValue = NonNullable<
  Extract<KnowledgeMutation, { readonly kind: "activate" }>["fingerprint"]
>;

interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: readonly Row[];
    readonly rowCount: number | null;
  }>;
}

interface ItemRow extends QueryResultRow {
  readonly id: string;
  readonly active_revision_id: string | null;
  readonly content_hash: string | null;
  readonly last_fingerprint_version: string | null;
  readonly last_fingerprint_value: string | null;
  readonly embedding_binding_version_id: string | null;
  readonly embedding_profile_version: string | null;
  readonly embedding_dimensions: number | null;
  readonly normalization_profile_version: string | null;
}

interface CacheRow extends QueryResultRow {
  readonly chunk_hash: string;
  readonly embedding_binding_version_id: string;
  readonly embedding_profile_version: string;
  readonly dimensions: number;
  readonly normalization_profile_version: string;
  readonly embedding: string;
}

interface SourceRow extends QueryResultRow {
  readonly connector_registration_id: string;
  readonly normalization_profile_version: string;
  readonly chunking_profile_version: string;
  readonly embedding_binding_version_id: string;
  readonly embedding_profile_version: string;
  readonly dimensions: number;
}

interface DocumentRow extends QueryResultRow {
  readonly id: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function externalReferenceId(
  workspaceId: string,
  sourceId: string,
  reference: KnowledgeReference,
): string {
  return `external-reference:${sha256(
    `${workspaceId}:${sourceId}:${reference.connectorInstanceId}:${reference.resourceType}:${reference.externalId}`,
  )}`;
}

function documentId(
  workspaceId: string,
  sourceId: string,
  reference: KnowledgeReference,
): string {
  return `knowledge-document:${sha256(
    `${workspaceId}:${sourceId}:${reference.connectorInstanceId}:${reference.resourceType}:${reference.externalId}`,
  )}`;
}

function cacheId(
  workspaceId: string,
  identity: EmbeddingCacheIdentity,
): string {
  return `knowledge-embedding:${sha256(
    [
      workspaceId,
      identity.chunkHash,
      identity.embeddingBindingVersionId,
      identity.embeddingProfileVersion,
      identity.dimensions,
      identity.normalizationProfileVersion,
    ].join(":"),
  )}`;
}

function allocationId(workspaceId: string, entry: NewCachedEmbedding): string {
  return `knowledge-embedding-allocation:${sha256(
    `${cacheId(workspaceId, entry.identity)}:${entry.allocation.operationId}`,
  )}`;
}

function asVector(value: string): readonly number[] {
  if (!value.startsWith("[") || !value.endsWith("]")) {
    throw new Error("Persisted knowledge embedding is invalid.");
  }
  const values = value
    .slice(1, -1)
    .split(",")
    .filter((item) => item.length > 0)
    .map(Number);
  if (values.some((item) => !Number.isFinite(item))) {
    throw new Error(
      "Persisted knowledge embedding contains a non-finite value.",
    );
  }
  return values;
}

function vectorLiteral(vector: readonly number[]): string {
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Knowledge embedding contains a non-finite value.");
  }
  return `[${vector.join(",")}]`;
}

function valueOrNull(value: VersionedOpaqueValue | undefined): string | null {
  return value?.value ?? null;
}

function versionOrNull(value: VersionedOpaqueValue | undefined): string | null {
  return value?.version ?? null;
}

function asFingerprint(row: ItemRow): VersionedOpaqueValue | undefined {
  if (
    row.last_fingerprint_version === null ||
    row.last_fingerprint_value === null
  ) {
    return undefined;
  }
  return {
    version: row.last_fingerprint_version,
    value: row.last_fingerprint_value,
  };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

export class PostgresKnowledgeIngestionStore
  implements KnowledgeIngestionStore
{
  public constructor(private readonly pool: Pool) {}

  public async findItem(input: {
    readonly workspaceId: string;
    readonly sourceId: string;
    readonly reference: KnowledgeReference;
  }) {
    const result = await this.pool.query<ItemRow>(
      `SELECT
         document.id,
         document.active_revision_id,
         revision.content_hash,
         document.last_fingerprint_version,
         document.last_fingerprint_value,
         revision.embedding_binding_version_id,
         revision.embedding_profile_version,
         revision.embedding_dimensions,
         revision.normalization_profile_version
       FROM knowledge_documents AS document
       JOIN external_references AS reference
         ON reference.workspace_id = document.workspace_id
        AND reference.id = document.external_reference_id
       LEFT JOIN knowledge_revisions AS revision
         ON revision.workspace_id = document.workspace_id
        AND revision.id = document.active_revision_id
       WHERE document.workspace_id = $1
         AND document.knowledge_source_id = $2
         AND reference.kind = $3
         AND reference.external_id = $4`,
      [
        input.workspaceId,
        input.sourceId,
        input.reference.resourceType,
        input.reference.externalId,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return Object.freeze({
      documentId: row.id,
      activeRevisionId: row.active_revision_id ?? undefined,
      activeContentHash: row.content_hash ?? undefined,
      activeEmbeddingSpace:
        row.embedding_binding_version_id === null ||
        row.embedding_profile_version === null ||
        row.embedding_dimensions === null ||
        row.normalization_profile_version === null
          ? undefined
          : {
              embeddingBindingVersionId: row.embedding_binding_version_id,
              embeddingProfileVersion: row.embedding_profile_version,
              dimensions: row.embedding_dimensions,
              normalizationProfileVersion: row.normalization_profile_version,
            },
      lastSuccessfulFingerprint: asFingerprint(row),
    });
  }

  public async findReusableEmbeddings(input: {
    readonly workspaceId: string;
    readonly identities: readonly EmbeddingCacheIdentity[];
  }): Promise<readonly CachedEmbedding[]> {
    const cache: CachedEmbedding[] = [];
    for (const identity of input.identities) {
      const result = await this.pool.query<CacheRow>(
        `SELECT
           chunk_hash,
           embedding_binding_version_id,
           embedding_profile_version,
           dimensions,
           normalization_profile_version,
           embedding::text AS embedding
         FROM knowledge_embedding_cache_entries
         WHERE workspace_id = $1
           AND chunk_hash = $2
           AND embedding_binding_version_id = $3
           AND embedding_profile_version = $4
           AND dimensions = $5
           AND normalization_profile_version = $6`,
        [
          input.workspaceId,
          identity.chunkHash,
          identity.embeddingBindingVersionId,
          identity.embeddingProfileVersion,
          identity.dimensions,
          identity.normalizationProfileVersion,
        ],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        cache.push(
          Object.freeze({
            identity: {
              chunkHash: row.chunk_hash,
              embeddingBindingVersionId: row.embedding_binding_version_id,
              embeddingProfileVersion: row.embedding_profile_version,
              dimensions: row.dimensions,
              normalizationProfileVersion: row.normalization_profile_version,
            },
            vector: asVector(row.embedding),
          }),
        );
      }
    }
    return Object.freeze(cache);
  }

  public async commit(
    input: Parameters<KnowledgeIngestionStore["commit"]>[0],
  ): Promise<void> {
    await this.withTransaction(async (database) => {
      await this.insertCacheEntries(
        database,
        input.workspaceId,
        input.newEmbeddings,
      );
      for (const mutation of input.mutations) {
        if (mutation.kind === "tombstone") {
          await this.tombstone(
            database,
            input.workspaceId,
            input.sourceId,
            mutation.reference,
          );
          continue;
        }
        if (mutation.kind === "observe") {
          await this.observe(
            database,
            input.workspaceId,
            input.sourceId,
            mutation.reference,
            mutation.observedAt,
            mutation.fingerprint,
            input.scan.mode === "snapshot" ? input.scan.scanEpoch : undefined,
          );
          continue;
        }
        await this.activate(
          database,
          input.workspaceId,
          input.sourceId,
          mutation,
          input.scan.mode === "snapshot" ? input.scan.scanEpoch : undefined,
        );
      }
      if (input.scan.mode === "snapshot") {
        if (input.scan.scanEpoch === undefined) {
          throw new Error("A completed snapshot must provide a scan epoch.");
        }
        await database.query(
          `UPDATE knowledge_documents
           SET lifecycle = 'tombstoned',
               active_revision_id = NULL,
               updated_at = NOW()
           WHERE workspace_id = $1
             AND knowledge_source_id = $2
             AND lifecycle = 'active'
             AND (
               last_seen_epoch_version IS DISTINCT FROM $3
               OR last_seen_epoch_value IS DISTINCT FROM $4
             )`,
          [
            input.workspaceId,
            input.sourceId,
            input.scan.scanEpoch.version,
            input.scan.scanEpoch.value,
          ],
        );
      }
      await database.query(
        `INSERT INTO knowledge_source_states (
           workspace_id, knowledge_source_id, cursor_version, cursor_value,
           last_completed_at, last_scan_epoch_version, last_scan_epoch_value
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (workspace_id, knowledge_source_id) DO UPDATE SET
           cursor_version = EXCLUDED.cursor_version,
           cursor_value = EXCLUDED.cursor_value,
           last_completed_at = EXCLUDED.last_completed_at,
           last_scan_epoch_version = EXCLUDED.last_scan_epoch_version,
           last_scan_epoch_value = EXCLUDED.last_scan_epoch_value,
           updated_at = NOW()`,
        [
          input.workspaceId,
          input.sourceId,
          versionOrNull(input.scan.cursor),
          valueOrNull(input.scan.cursor),
          input.scan.completedAt,
          versionOrNull(input.scan.scanEpoch),
          valueOrNull(input.scan.scanEpoch),
        ],
      );
    });
  }

  public async recordFailedRevision(
    diagnostic: FailedRevisionDiagnostic,
  ): Promise<void> {
    await this.withTransaction(async (database) => {
      const document = await this.ensureDocument(
        database,
        diagnostic.workspaceId,
        diagnostic.sourceId,
        diagnostic.reference,
        diagnostic.observedAt,
      );
      const source = await this.source(
        database,
        diagnostic.workspaceId,
        diagnostic.sourceId,
      );
      const ordinal = await this.nextRevisionOrdinal(
        database,
        diagnostic.workspaceId,
        document.id,
      );
      const id =
        diagnostic.revisionId ??
        `knowledge-failed-revision:${sha256(
          `${diagnostic.sourceId}:${diagnostic.reference.externalId}:${diagnostic.observedAt}:${diagnostic.stage}`,
        )}`;
      const contentHash =
        diagnostic.contentHash ??
        sha256(
          `failed:${diagnostic.reference.connectorInstanceId}:${diagnostic.reference.resourceType}:${diagnostic.reference.externalId}:${diagnostic.observedAt}`,
        );
      await database.query(
        `INSERT INTO knowledge_revisions (
           id, workspace_id, knowledge_document_id, revision_ordinal, state,
           content_hash, normalization_profile_version, chunking_profile_version,
           embedding_binding_version_id, embedding_profile_version,
           embedding_dimensions, diagnostic, created_at
         ) VALUES (
           $1, $2, $3, $4, 'failed', $5, $6, $7, $8, $9, $10, $11::jsonb, $12
         )`,
        [
          id,
          diagnostic.workspaceId,
          document.id,
          ordinal,
          contentHash,
          source.normalization_profile_version,
          source.chunking_profile_version,
          source.embedding_binding_version_id,
          source.embedding_profile_version,
          source.dimensions,
          json({
            stage: diagnostic.stage,
            code: diagnostic.code,
            retryable: diagnostic.retryable,
            message: diagnostic.message,
          }),
          diagnostic.observedAt,
        ],
      );
    });
  }

  private async withTransaction<Result>(
    operation: (database: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async source(
    database: Queryable,
    workspaceId: string,
    sourceId: string,
  ): Promise<SourceRow> {
    const result = await database.query<SourceRow>(
      `SELECT
         source.connector_registration_id,
         source.normalization_profile_version,
         source.chunking_profile_version,
         collection.embedding_binding_version_id,
         collection.embedding_profile_version,
         collection.dimensions
       FROM knowledge_sources AS source
       JOIN knowledge_collections AS collection
         ON collection.workspace_id = source.workspace_id
        AND collection.id = source.knowledge_collection_id
       WHERE source.workspace_id = $1 AND source.id = $2`,
      [workspaceId, sourceId],
    );
    const source = result.rows[0];
    if (source === undefined) {
      throw new Error("Knowledge source configuration was not found.");
    }
    return source;
  }

  private async ensureDocument(
    database: Queryable,
    workspaceId: string,
    sourceId: string,
    reference: KnowledgeReference,
    observedAt: string,
  ): Promise<DocumentRow> {
    const source = await this.source(database, workspaceId, sourceId);
    const referenceId = externalReferenceId(workspaceId, sourceId, reference);
    const referenceResult = await database.query<DocumentRow>(
      `INSERT INTO external_references (
         id, workspace_id, connector_registration_id, kind, external_id
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (
         workspace_id, connector_registration_id, kind, external_id
       ) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [
        referenceId,
        workspaceId,
        source.connector_registration_id,
        reference.resourceType,
        reference.externalId,
      ],
    );
    const persistedReference = referenceResult.rows[0];
    if (persistedReference === undefined) {
      throw new Error("Knowledge external reference could not be persisted.");
    }
    const result = await database.query<DocumentRow>(
      `INSERT INTO knowledge_documents (
         id, workspace_id, knowledge_source_id, external_reference_id,
         lifecycle, observed_at
       ) VALUES ($1, $2, $3, $4, 'active', $5)
       ON CONFLICT (
         workspace_id, knowledge_source_id, external_reference_id
       ) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [
        documentId(workspaceId, sourceId, reference),
        workspaceId,
        sourceId,
        persistedReference.id,
        observedAt,
      ],
    );
    const document = result.rows[0];
    if (document === undefined) {
      throw new Error("Knowledge document could not be persisted.");
    }
    return document;
  }

  private async observe(
    database: Queryable,
    workspaceId: string,
    sourceId: string,
    reference: KnowledgeReference,
    observedAt: string,
    fingerprint: VersionedOpaqueValue | undefined,
    scanEpoch: VersionedOpaqueValue | undefined,
  ): Promise<void> {
    const document = await this.ensureDocument(
      database,
      workspaceId,
      sourceId,
      reference,
      observedAt,
    );
    await database.query(
      `UPDATE knowledge_documents
       SET lifecycle = 'active',
           last_fingerprint_version = $1,
           last_fingerprint_value = $2,
           last_seen_epoch_version = COALESCE($3, last_seen_epoch_version),
           last_seen_epoch_value = COALESCE($4, last_seen_epoch_value),
           observed_at = $5,
           updated_at = NOW()
       WHERE workspace_id = $6 AND id = $7`,
      [
        versionOrNull(fingerprint),
        valueOrNull(fingerprint),
        versionOrNull(scanEpoch),
        valueOrNull(scanEpoch),
        observedAt,
        workspaceId,
        document.id,
      ],
    );
  }

  private async activate(
    database: Queryable,
    workspaceId: string,
    sourceId: string,
    mutation: Extract<KnowledgeMutation, { readonly kind: "activate" }>,
    scanEpoch: VersionedOpaqueValue | undefined,
  ): Promise<void> {
    const document = await this.ensureDocument(
      database,
      workspaceId,
      sourceId,
      mutation.reference,
      mutation.observedAt,
    );
    const ordinal = await this.nextRevisionOrdinal(
      database,
      workspaceId,
      document.id,
    );
    await database.query(
      `INSERT INTO knowledge_revisions (
         id, workspace_id, knowledge_document_id, revision_ordinal, state,
         content_hash, normalization_profile_version, chunking_profile_version,
         embedding_binding_version_id, embedding_profile_version,
         embedding_dimensions, normalized_content, title, source_url, metadata,
         created_at, activated_at
       ) VALUES (
         $1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $15
       )`,
      [
        mutation.revisionId,
        workspaceId,
        document.id,
        ordinal,
        mutation.contentHash,
        mutation.normalizationProfileVersion,
        mutation.chunkingProfileVersion,
        mutation.embeddingSpace.embeddingBindingVersionId,
        mutation.embeddingSpace.embeddingProfileVersion,
        mutation.embeddingSpace.dimensions,
        mutation.normalized.normalizedText,
        mutation.normalized.title ?? null,
        mutation.normalized.sourceUrl ?? null,
        json(mutation.normalized.metadata ?? {}),
        mutation.observedAt,
      ],
    );
    for (const chunk of mutation.chunks) {
      const inserted = await database.query(
        `INSERT INTO knowledge_chunks (
           id, workspace_id, knowledge_revision_id, position, content_hash,
           content, source_anchor, embedding_cache_entry_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          chunk.id,
          workspaceId,
          mutation.revisionId,
          chunk.position,
          chunk.contentHash,
          chunk.content,
          chunk.sourceAnchor ?? null,
          cacheId(workspaceId, chunk.embedding),
        ],
      );
      if (inserted.rowCount !== 1) {
        throw new Error("Knowledge chunk could not be persisted.");
      }
    }
    await database.query(
      `UPDATE knowledge_documents
       SET lifecycle = 'active',
           active_revision_id = $1,
           last_fingerprint_version = $2,
           last_fingerprint_value = $3,
           last_seen_epoch_version = COALESCE($4, last_seen_epoch_version),
           last_seen_epoch_value = COALESCE($5, last_seen_epoch_value),
           observed_at = $6,
           updated_at = NOW()
       WHERE workspace_id = $7 AND id = $8`,
      [
        mutation.revisionId,
        versionOrNull(mutation.fingerprint),
        valueOrNull(mutation.fingerprint),
        versionOrNull(scanEpoch),
        valueOrNull(scanEpoch),
        mutation.observedAt,
        workspaceId,
        document.id,
      ],
    );
  }

  private async tombstone(
    database: Queryable,
    workspaceId: string,
    sourceId: string,
    reference: KnowledgeReference,
  ): Promise<void> {
    await database.query(
      `UPDATE knowledge_documents AS document
       SET lifecycle = 'tombstoned',
           active_revision_id = NULL,
           updated_at = NOW()
       FROM external_references AS external_reference
       WHERE document.workspace_id = $1
         AND document.knowledge_source_id = $2
         AND external_reference.workspace_id = document.workspace_id
         AND external_reference.id = document.external_reference_id
         AND external_reference.kind = $3
         AND external_reference.external_id = $4`,
      [workspaceId, sourceId, reference.resourceType, reference.externalId],
    );
  }

  private async nextRevisionOrdinal(
    database: Queryable,
    workspaceId: string,
    documentIdValue: string,
  ): Promise<number> {
    const result = await database.query<{ readonly ordinal: number }>(
      `SELECT COALESCE(MAX(revision_ordinal), 0) + 1 AS ordinal
       FROM knowledge_revisions
       WHERE workspace_id = $1 AND knowledge_document_id = $2`,
      [workspaceId, documentIdValue],
    );
    const ordinal = result.rows[0]?.ordinal;
    if (ordinal === undefined) {
      throw new Error("Knowledge revision ordinal could not be allocated.");
    }
    return ordinal;
  }

  private async insertCacheEntries(
    database: Queryable,
    workspaceId: string,
    entries: readonly NewCachedEmbedding[],
  ): Promise<void> {
    for (const entry of entries) {
      await database.query(
        `INSERT INTO knowledge_embedding_cache_entries (
           id, workspace_id, chunk_hash, embedding_binding_version_id,
           embedding_profile_version, dimensions, normalization_profile_version,
           embedding
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)
         ON CONFLICT (
           workspace_id,
           chunk_hash,
           embedding_binding_version_id,
           embedding_profile_version,
           dimensions,
           normalization_profile_version
         ) DO NOTHING`,
        [
          cacheId(workspaceId, entry.identity),
          workspaceId,
          entry.identity.chunkHash,
          entry.identity.embeddingBindingVersionId,
          entry.identity.embeddingProfileVersion,
          entry.identity.dimensions,
          entry.identity.normalizationProfileVersion,
          vectorLiteral(entry.vector),
        ],
      );
      await database.query(
        `INSERT INTO knowledge_embedding_allocations (
           id, workspace_id, embedding_cache_entry_id, ai_operation_id,
           allocated_input_tokens, calculated_cost_amount,
           calculated_cost_currency, calculation_status, weight_numerator,
           weight_denominator
         ) VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10)
         ON CONFLICT (
           workspace_id, embedding_cache_entry_id, ai_operation_id
         ) DO NOTHING`,
        [
          allocationId(workspaceId, entry),
          workspaceId,
          cacheId(workspaceId, entry.identity),
          entry.allocation.operationId,
          entry.allocation.allocatedInputTokens ?? null,
          entry.allocation.calculatedCostAmount ?? null,
          entry.allocation.calculatedCostCurrency ?? null,
          entry.allocation.calculationStatus,
          entry.allocation.weightNumerator,
          entry.allocation.weightDenominator,
        ],
      );
    }
  }
}
