import type {
  QueryEmbedding,
  RetrievalCandidate,
  RetrievalCollection,
  RetrievalEvidence,
  RetrievalFilterValue,
  RetrievalSearchInput,
  RetrievalSearchPort,
  RetrievalSnapshot,
  RetrievalSnapshotPort,
} from "@caseweaver/retrieval";
import { Pool, type QueryResultRow } from "pg";

export const POSTGRES_RETRIEVAL_VECTOR_DIMENSIONS = Object.freeze([3, 1536]);

const MAXIMUM_COLLECTIONS = 32;
const MAXIMUM_AUTHORIZED_SOURCES = 100;
const MAXIMUM_CANDIDATES_PER_SOURCE = 50;
const MAXIMUM_METADATA_FILTERS = 16;
const MAXIMUM_FILTER_VALUES = 32;
const MAXIMUM_EVIDENCE_PER_SNAPSHOT = 500;
const MAXIMUM_QUERY_LENGTH = 16_000;
const MAXIMUM_IDENTIFIER_LENGTH = 512;

interface SearchRow extends QueryResultRow {
  readonly collection_id: string;
  readonly source_id: string;
  readonly source_revision_id: string;
  readonly chunk_id: string;
  readonly location: string;
  readonly source_url: string | null;
  readonly content: string;
  readonly access_metadata: unknown;
  readonly rank: number;
}

interface CollectionRow extends QueryResultRow {
  readonly id: string;
  readonly embedding_binding_version_id: string;
  readonly embedding_profile_version: string;
  readonly dimensions: number;
}

interface MetadataFilter {
  readonly key: string;
  readonly values: readonly RetrievalFilterValue[];
}

interface ValidatedVectorQuery {
  readonly query: QueryEmbedding;
  readonly collectionIds: readonly string[];
}

interface ValidatedSearch {
  readonly collections: readonly RetrievalCollection[];
  readonly authorizedSourceIds: readonly string[];
  readonly metadataFilters: readonly MetadataFilter[];
  readonly vectorQueries: readonly ValidatedVectorQuery[];
}

export class PostgresRetrievalValidationError extends Error {
  public readonly code = "retrieval.invalidConfiguration";
  public readonly retryable = false;

  public constructor(message: string) {
    super(message);
    this.name = "PostgresRetrievalValidationError";
  }
}

export class PostgresRetrievalSnapshotConflictError extends Error {
  public readonly code = "retrieval.snapshotConflict";
  public readonly retryable = false;

  public constructor() {
    super("The retrieval snapshot ID already exists.");
    this.name = "PostgresRetrievalSnapshotConflictError";
  }
}

export interface PostgresRetrievalPersistenceConfiguration {
  readonly databaseUrl: string;
  /**
   * A subset of dimensions provisioned by the PBI-009 migration. Supporting a
   * new dimension requires an explicit migration and index, rather than a scan.
   */
  readonly supportedVectorDimensions?: readonly number[];
}

export interface PostgresRetrievalPersistence {
  readonly search: RetrievalSearchPort;
  readonly snapshots: RetrievalSnapshotPort;
  close(): Promise<void>;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireText(value: unknown, description: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAXIMUM_IDENTIFIER_LENGTH
  ) {
    throw new PostgresRetrievalValidationError(
      `${description} must be a non-empty string no longer than ${MAXIMUM_IDENTIFIER_LENGTH} characters.`,
    );
  }
  return value;
}

function requireQuery(value: string): void {
  if (value.trim().length === 0 || value.length > MAXIMUM_QUERY_LENGTH) {
    throw new PostgresRetrievalValidationError(
      `Retrieval query must be non-empty and no longer than ${MAXIMUM_QUERY_LENGTH} characters.`,
    );
  }
}

function requireContent(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PostgresRetrievalValidationError(
      `${description} must be a non-empty string.`,
    );
  }
  return value;
}

function requirePositiveInteger(
  value: number,
  description: string,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new PostgresRetrievalValidationError(
      `${description} must be a positive integer no greater than ${maximum}.`,
    );
  }
}

function requireNonNegativeInteger(value: number, description: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PostgresRetrievalValidationError(
      `${description} must be a non-negative safe integer.`,
    );
  }
}

function requireFiniteNumber(value: number, description: string): void {
  if (!Number.isFinite(value)) {
    throw new PostgresRetrievalValidationError(
      `${description} must be finite.`,
    );
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new PostgresRetrievalValidationError("Retrieval was cancelled.");
  }
}

function sortedUniqueTexts(
  values: readonly string[],
  description: string,
  maximum: number,
): readonly string[] {
  if (values.length > maximum) {
    throw new PostgresRetrievalValidationError(
      `${description} must contain no more than ${maximum} values.`,
    );
  }
  const unique = new Set<string>();
  for (const value of values) {
    unique.add(requireText(value, description));
  }
  if (unique.size !== values.length) {
    throw new PostgresRetrievalValidationError(
      `${description} must not contain duplicates.`,
    );
  }
  return Object.freeze([...unique].sort(compareText));
}

function isFilterValue(value: unknown): value is RetrievalFilterValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function validateMetadataFilters(
  filters: RetrievalSearchInput["metadataFilters"],
): readonly MetadataFilter[] {
  if (filters === undefined) return Object.freeze([]);
  const entries = Object.entries(filters);
  if (entries.length > MAXIMUM_METADATA_FILTERS) {
    throw new PostgresRetrievalValidationError(
      `Retrieval metadata filters must contain no more than ${MAXIMUM_METADATA_FILTERS} fields.`,
    );
  }
  return Object.freeze(
    entries
      .map(([key, values]) => {
        requireText(key, "Retrieval metadata filter key");
        if (
          !Array.isArray(values) ||
          values.length === 0 ||
          values.length > MAXIMUM_FILTER_VALUES
        ) {
          throw new PostgresRetrievalValidationError(
            `Retrieval metadata filter "${key}" must contain between 1 and ${MAXIMUM_FILTER_VALUES} values.`,
          );
        }
        const canonical = new Map<string, RetrievalFilterValue>();
        for (const value of values) {
          if (!isFilterValue(value)) {
            throw new PostgresRetrievalValidationError(
              `Retrieval metadata filter "${key}" contains an unsupported value.`,
            );
          }
          if (
            typeof value === "string" &&
            value.length > MAXIMUM_QUERY_LENGTH
          ) {
            throw new PostgresRetrievalValidationError(
              `Retrieval metadata filter "${key}" contains an oversized string.`,
            );
          }
          canonical.set(JSON.stringify(value), value);
        }
        return Object.freeze({
          key,
          values: Object.freeze(
            [...canonical.entries()]
              .sort(([left], [right]) => compareText(left, right))
              .map(([, value]) => value),
          ),
        });
      })
      .sort((left, right) => compareText(left.key, right.key)),
  );
}

function resolveSupportedDimensions(
  configured: readonly number[] | undefined,
): ReadonlySet<number> {
  const dimensions =
    configured === undefined
      ? POSTGRES_RETRIEVAL_VECTOR_DIMENSIONS
      : configured;
  if (dimensions.length === 0) {
    throw new PostgresRetrievalValidationError(
      "At least one PostgreSQL retrieval vector dimension must be configured.",
    );
  }
  const supported = new Set<number>();
  for (const dimension of dimensions) {
    if (
      !Number.isSafeInteger(dimension) ||
      !POSTGRES_RETRIEVAL_VECTOR_DIMENSIONS.includes(dimension)
    ) {
      throw new PostgresRetrievalValidationError(
        "PostgreSQL retrieval was configured with an unsupported vector dimension.",
      );
    }
    if (supported.has(dimension)) {
      throw new PostgresRetrievalValidationError(
        "PostgreSQL retrieval vector dimensions must not contain duplicates.",
      );
    }
    supported.add(dimension);
  }
  return supported;
}

function validateCollection(
  collection: RetrievalCollection,
  supportedDimensions: ReadonlySet<number>,
): void {
  requireText(collection.id, "Retrieval collection ID");
  requireText(
    collection.embeddingBindingVersionId,
    "Retrieval collection embedding binding version ID",
  );
  requireText(
    collection.embeddingProfileVersion,
    "Retrieval collection embedding profile version",
  );
  if (!supportedDimensions.has(collection.dimensions)) {
    throw new PostgresRetrievalValidationError(
      `Vector dimension ${collection.dimensions} is not supported by PostgreSQL retrieval.`,
    );
  }
}

function validateVectorQueries(
  input: RetrievalSearchInput,
  collections: readonly RetrievalCollection[],
  supportedDimensions: ReadonlySet<number>,
): readonly ValidatedVectorQuery[] {
  const collectionsById = new Map(
    collections.map((collection) => [collection.id, collection] as const),
  );
  const queriedCollectionIds = new Set<string>();
  return Object.freeze(
    input.vectorQueries
      .map((query) => {
        requireText(
          query.embeddingBindingVersionId,
          "Query embedding binding version ID",
        );
        requireText(
          query.embeddingProfileVersion,
          "Query embedding profile version",
        );
        if (!supportedDimensions.has(query.dimensions)) {
          throw new PostgresRetrievalValidationError(
            `Vector dimension ${query.dimensions} is not supported by PostgreSQL retrieval.`,
          );
        }
        if (
          query.vector.length !== query.dimensions ||
          query.vector.some((value) => !Number.isFinite(value))
        ) {
          throw new PostgresRetrievalValidationError(
            "Query vector does not match its configured dimensions.",
          );
        }
        const collectionIds = sortedUniqueTexts(
          query.collectionIds,
          "Query embedding collection IDs",
          MAXIMUM_COLLECTIONS,
        );
        if (collectionIds.length === 0) {
          throw new PostgresRetrievalValidationError(
            "Query embedding must target at least one collection.",
          );
        }
        for (const collectionId of collectionIds) {
          const collection = collectionsById.get(collectionId);
          if (
            collection === undefined ||
            queriedCollectionIds.has(collectionId) ||
            collection.embeddingBindingVersionId !==
              query.embeddingBindingVersionId ||
            collection.embeddingProfileVersion !==
              query.embeddingProfileVersion ||
            collection.dimensions !== query.dimensions
          ) {
            throw new PostgresRetrievalValidationError(
              "Query embedding does not match its selected collection configuration.",
            );
          }
          queriedCollectionIds.add(collectionId);
        }
        return Object.freeze({ query, collectionIds });
      })
      .sort((left, right) => {
        const binding = compareText(
          left.query.embeddingBindingVersionId,
          right.query.embeddingBindingVersionId,
        );
        if (binding !== 0) return binding;
        const profile = compareText(
          left.query.embeddingProfileVersion,
          right.query.embeddingProfileVersion,
        );
        if (profile !== 0) return profile;
        return left.query.dimensions - right.query.dimensions;
      }),
  );
}

function validateSearch(
  input: RetrievalSearchInput,
  supportedDimensions: ReadonlySet<number>,
): ValidatedSearch {
  requireText(input.workspaceId, "Workspace ID");
  requireQuery(input.query);
  requirePositiveInteger(
    input.maximumCandidatesPerSource,
    "Maximum candidates per source",
    MAXIMUM_CANDIDATES_PER_SOURCE,
  );
  if (
    input.collections.length === 0 ||
    input.collections.length > MAXIMUM_COLLECTIONS
  ) {
    throw new PostgresRetrievalValidationError(
      `Retrieval must select between 1 and ${MAXIMUM_COLLECTIONS} collections.`,
    );
  }
  const collections = [...input.collections].sort((left, right) =>
    compareText(left.id, right.id),
  );
  const collectionIds = new Set<string>();
  for (const collection of collections) {
    validateCollection(collection, supportedDimensions);
    if (collectionIds.has(collection.id)) {
      throw new PostgresRetrievalValidationError(
        "Retrieval collections must not contain duplicate IDs.",
      );
    }
    collectionIds.add(collection.id);
  }
  const authorizedSourceIds = sortedUniqueTexts(
    input.access.authorizedSourceIds,
    "Authorized source IDs",
    MAXIMUM_AUTHORIZED_SOURCES,
  );
  return Object.freeze({
    collections: Object.freeze(collections),
    authorizedSourceIds,
    metadataFilters: validateMetadataFilters(input.metadataFilters),
    vectorQueries: validateVectorQueries(
      input,
      collections,
      supportedDimensions,
    ),
  });
}

function metadataPredicate(
  filters: readonly MetadataFilter[],
  parameters: unknown[],
): string {
  if (filters.length === 0) return "";
  const clauses = filters.map((filter) => {
    const values = filter.values.map((value) => {
      parameters.push(JSON.stringify({ [filter.key]: value }));
      return `revision.metadata @> $${parameters.length}::jsonb`;
    });
    return `(${values.join(" OR ")})`;
  });
  return ` AND ${clauses.join(" AND ")}`;
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => value.toString()).join(",")}]`;
}

function vectorDistanceExpression(dimension: number): string {
  switch (dimension) {
    case 3:
      return "cache.embedding::vector(3) <=> $7::vector(3)";
    case 1536:
      return "cache.embedding::vector(1536) <=> $7::vector(1536)";
    default:
      throw new PostgresRetrievalValidationError(
        `Vector dimension ${dimension} is not supported by PostgreSQL retrieval.`,
      );
  }
}

function asText(value: unknown, description: string): string {
  return requireText(value, description);
}

function asMetadata(
  value: unknown,
): Readonly<Record<string, RetrievalFilterValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PostgresRetrievalValidationError(
      "Persisted retrieval metadata is invalid.",
    );
  }
  const metadata: Record<string, RetrievalFilterValue> = {};
  for (const [key, item] of Object.entries(value)) {
    requireText(key, "Persisted retrieval metadata key");
    if (!isFilterValue(item)) {
      throw new PostgresRetrievalValidationError(
        "Persisted retrieval metadata contains an unsupported value.",
      );
    }
    metadata[key] = item;
  }
  return Object.freeze(metadata);
}

function toCandidate(
  row: SearchRow,
  rank: "lexicalRank" | "vectorRank",
): RetrievalCandidate {
  requirePositiveInteger(
    row.rank,
    "Persisted retrieval rank",
    Number.MAX_SAFE_INTEGER,
  );
  return Object.freeze({
    collectionId: asText(
      row.collection_id,
      "Persisted retrieval collection ID",
    ),
    sourceId: asText(row.source_id, "Persisted retrieval source ID"),
    sourceRevisionId: asText(
      row.source_revision_id,
      "Persisted retrieval revision ID",
    ),
    chunkId: asText(row.chunk_id, "Persisted retrieval chunk ID"),
    location: requireContent(row.location, "Persisted retrieval location"),
    ...(row.source_url === null
      ? {}
      : {
          sourceUrl: requireContent(
            row.source_url,
            "Persisted retrieval source URL",
          ),
        }),
    content: requireContent(row.content, "Persisted retrieval content"),
    activeRevision: true,
    [rank]: row.rank,
    accessMetadata: asMetadata(row.access_metadata),
  });
}

function canonicalMetadata(
  value: Readonly<Record<string, RetrievalFilterValue>>,
): string {
  const sorted: Record<string, RetrievalFilterValue> = {};
  for (const [key, metadata] of Object.entries(value).sort(([left], [right]) =>
    compareText(left, right),
  )) {
    sorted[key] = metadata;
  }
  return JSON.stringify(sorted);
}

function canonicalOperationIds(
  value: Readonly<Record<string, string>>,
): string {
  if (Object.keys(value).length > MAXIMUM_COLLECTIONS) {
    throw new PostgresRetrievalValidationError(
      `Retrieval snapshot operation IDs must contain no more than ${MAXIMUM_COLLECTIONS} bindings.`,
    );
  }
  const sorted: Record<string, string> = {};
  for (const [key, operationId] of Object.entries(value).sort(
    ([left], [right]) => compareText(left, right),
  )) {
    sorted[requireText(key, "Query embedding operation binding ID")] =
      requireText(operationId, "Query embedding operation ID");
  }
  return JSON.stringify(sorted);
}

function validateSnapshot(snapshot: RetrievalSnapshot): void {
  requireText(snapshot.id, "Retrieval snapshot ID");
  requireText(snapshot.workspaceId, "Retrieval snapshot workspace ID");
  requireQuery(snapshot.query);
  requireText(snapshot.profileId, "Retrieval snapshot profile ID");
  requireText(snapshot.profileVersion, "Retrieval snapshot profile version");
  if (Number.isNaN(Date.parse(snapshot.capturedAt))) {
    throw new PostgresRetrievalValidationError(
      "Retrieval snapshot timestamp must be a valid instant.",
    );
  }
  if (snapshot.analysisId !== undefined) {
    requireText(snapshot.analysisId, "Retrieval snapshot analysis ID");
  }
  if (snapshot.rerankerOperationId !== undefined) {
    requireText(
      snapshot.rerankerOperationId,
      "Retrieval snapshot reranker operation ID",
    );
  }
  if (snapshot.evidence.length > MAXIMUM_EVIDENCE_PER_SNAPSHOT) {
    throw new PostgresRetrievalValidationError(
      `Retrieval snapshots can contain no more than ${MAXIMUM_EVIDENCE_PER_SNAPSHOT} evidence entries.`,
    );
  }
  canonicalOperationIds(snapshot.queryEmbeddingOperationIds);
  for (const evidence of snapshot.evidence) {
    validateEvidence(evidence);
  }
}

function validateEvidence(evidence: RetrievalEvidence): void {
  requireText(evidence.collectionId, "Retrieval evidence collection ID");
  requireText(evidence.sourceId, "Retrieval evidence source ID");
  requireText(evidence.sourceRevisionId, "Retrieval evidence revision ID");
  requireText(evidence.chunkId, "Retrieval evidence chunk ID");
  requireContent(evidence.location, "Retrieval evidence location");
  requireContent(evidence.content, "Retrieval evidence content");
  if (evidence.sourceUrl !== undefined) {
    requireContent(evidence.sourceUrl, "Retrieval evidence source URL");
  }
  if (evidence.characterCount !== evidence.content.length) {
    throw new PostgresRetrievalValidationError(
      "Retrieval evidence character count must equal its content length.",
    );
  }
  requireNonNegativeInteger(
    evidence.characterCount,
    "Retrieval evidence character count",
  );
  requireNonNegativeInteger(
    evidence.tokenCount,
    "Retrieval evidence token count",
  );
  requireFiniteNumber(
    evidence.scores.fusedRrf,
    "Retrieval evidence fused score",
  );
  requireFiniteNumber(
    evidence.scores.lexicalRrf,
    "Retrieval evidence lexical score",
  );
  requireFiniteNumber(
    evidence.scores.vectorRrf,
    "Retrieval evidence vector score",
  );
  if (evidence.scores.reranker !== undefined) {
    requireFiniteNumber(
      evidence.scores.reranker,
      "Retrieval evidence reranker score",
    );
  }
  asMetadata(evidence.accessMetadata);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "23505"
  );
}

export class PostgresRetrievalAdapter
  implements RetrievalSearchPort, RetrievalSnapshotPort
{
  private readonly supportedDimensions: ReadonlySet<number>;

  public constructor(
    private readonly pool: Pool,
    configuration: Pick<
      PostgresRetrievalPersistenceConfiguration,
      "supportedVectorDimensions"
    > = {},
  ) {
    this.supportedDimensions = resolveSupportedDimensions(
      configuration.supportedVectorDimensions,
    );
  }

  public async search(
    input: RetrievalSearchInput,
  ): Promise<readonly RetrievalCandidate[]> {
    assertNotAborted(input.signal);
    const validated = validateSearch(input, this.supportedDimensions);
    if (validated.authorizedSourceIds.length === 0) {
      return Object.freeze([]);
    }
    await this.assertCollections(input.workspaceId, validated.collections);
    assertNotAborted(input.signal);
    const lexical = await this.lexical(input, validated);
    const vector: RetrievalCandidate[] = [];
    for (const query of validated.vectorQueries) {
      vector.push(...(await this.vector(input, validated, query)));
    }
    assertNotAborted(input.signal);
    return Object.freeze([...lexical, ...vector]);
  }

  public async persist(snapshot: RetrievalSnapshot): Promise<void> {
    validateSnapshot(snapshot);
    const database = await this.pool.connect();
    try {
      await database.query("BEGIN");
      await database.query(
        `INSERT INTO retrieval_snapshots (
           id, workspace_id, analysis_id, captured_at, query, profile_id,
           profile_version, query_embedding_operation_ids, reranker_operation_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
        [
          snapshot.id,
          snapshot.workspaceId,
          snapshot.analysisId ?? null,
          snapshot.capturedAt,
          snapshot.query,
          snapshot.profileId,
          snapshot.profileVersion,
          canonicalOperationIds(snapshot.queryEmbeddingOperationIds),
          snapshot.rerankerOperationId ?? null,
        ],
      );
      for (const [ordinal, evidence] of snapshot.evidence.entries()) {
        await database.query(
          `INSERT INTO retrieval_snapshot_evidence (
             workspace_id, retrieval_snapshot_id, ordinal, collection_id,
             source_id, source_revision_id, chunk_id, location, source_url,
             content, access_metadata, fused_rrf, lexical_rrf, vector_rrf,
             reranker_score, character_count, token_count
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12,
             $13, $14, $15, $16, $17
           )`,
          [
            snapshot.workspaceId,
            snapshot.id,
            ordinal,
            evidence.collectionId,
            evidence.sourceId,
            evidence.sourceRevisionId,
            evidence.chunkId,
            evidence.location,
            evidence.sourceUrl ?? null,
            evidence.content,
            canonicalMetadata(evidence.accessMetadata),
            evidence.scores.fusedRrf,
            evidence.scores.lexicalRrf,
            evidence.scores.vectorRrf,
            evidence.scores.reranker ?? null,
            evidence.characterCount,
            evidence.tokenCount,
          ],
        );
      }
      await database.query("COMMIT");
    } catch (error) {
      await database.query("ROLLBACK");
      if (isUniqueViolation(error)) {
        throw new PostgresRetrievalSnapshotConflictError();
      }
      throw error;
    } finally {
      database.release();
    }
  }

  private async assertCollections(
    workspaceId: string,
    collections: readonly RetrievalCollection[],
  ): Promise<void> {
    const rows = await this.pool.query<CollectionRow>(
      `SELECT
         id,
         embedding_binding_version_id,
         embedding_profile_version,
         dimensions
       FROM knowledge_collections
       WHERE workspace_id = $1 AND id = ANY($2::text[])`,
      [workspaceId, collections.map((collection) => collection.id)],
    );
    if (rows.rows.length !== collections.length) {
      throw new PostgresRetrievalValidationError(
        "A selected retrieval collection was not found in the workspace.",
      );
    }
    const persisted = new Map(rows.rows.map((row) => [row.id, row] as const));
    for (const collection of collections) {
      const row = persisted.get(collection.id);
      if (
        row === undefined ||
        row.embedding_binding_version_id !==
          collection.embeddingBindingVersionId ||
        row.embedding_profile_version !== collection.embeddingProfileVersion ||
        row.dimensions !== collection.dimensions
      ) {
        throw new PostgresRetrievalValidationError(
          "A selected retrieval collection does not match its immutable embedding space.",
        );
      }
    }
  }

  private async lexical(
    input: RetrievalSearchInput,
    validated: ValidatedSearch,
  ): Promise<readonly RetrievalCandidate[]> {
    const parameters: unknown[] = [
      input.workspaceId,
      validated.collections.map((collection) => collection.id),
      validated.authorizedSourceIds,
      input.query,
      input.maximumCandidatesPerSource,
      input.maximumCandidatesPerSource * validated.authorizedSourceIds.length,
    ];
    const metadata = metadataPredicate(validated.metadataFilters, parameters);
    const result = await this.pool.query<SearchRow>(
      `WITH lexical_candidates AS (
         SELECT
           collection.id AS collection_id,
           source.id AS source_id,
           revision.id AS source_revision_id,
           chunk.id AS chunk_id,
           COALESCE(chunk.source_anchor, 'chunk:' || chunk.id) AS location,
           revision.source_url,
           chunk.content,
           revision.metadata AS access_metadata,
           ts_rank_cd(
             to_tsvector('simple', chunk.content),
             websearch_to_tsquery('simple', $4)
           ) AS score
         FROM knowledge_chunks AS chunk
         JOIN knowledge_revisions AS revision
           ON revision.workspace_id = chunk.workspace_id
          AND revision.id = chunk.knowledge_revision_id
         JOIN knowledge_documents AS document
           ON document.workspace_id = revision.workspace_id
          AND document.id = revision.knowledge_document_id
         JOIN knowledge_sources AS source
           ON source.workspace_id = document.workspace_id
          AND source.id = document.knowledge_source_id
         JOIN knowledge_collections AS collection
           ON collection.workspace_id = source.workspace_id
          AND collection.id = source.knowledge_collection_id
         WHERE chunk.workspace_id = $1
           AND collection.id = ANY($2::text[])
           AND source.id = ANY($3::text[])
           AND source.lifecycle = 'enabled'
           AND document.lifecycle = 'active'
           AND document.active_revision_id = revision.id
           AND revision.state = 'active'
           AND revision.embedding_binding_version_id =
             collection.embedding_binding_version_id
           AND revision.embedding_profile_version =
             collection.embedding_profile_version
           AND revision.embedding_dimensions = collection.dimensions
           AND to_tsvector('simple', chunk.content) @@
             websearch_to_tsquery('simple', $4)
           ${metadata}
         ORDER BY
           score DESC,
           collection.id,
           source.id,
           revision.id,
           chunk.id
         LIMIT $6
       ),
       matched AS (
         SELECT
           *,
           ROW_NUMBER() OVER (
             PARTITION BY source_id
             ORDER BY score DESC, collection_id, source_revision_id, chunk_id
           ) AS source_ordinal
         FROM lexical_candidates
       ),
       source_bounded AS (
         SELECT *
         FROM matched
         WHERE source_ordinal <= $5
       ),
       ranked AS (
         SELECT
           *,
           (ROW_NUMBER() OVER (
             ORDER BY score DESC, collection_id, source_id, source_revision_id, chunk_id
           ))::integer AS rank
         FROM source_bounded
       )
       SELECT
         collection_id, source_id, source_revision_id, chunk_id, location,
         source_url, content, access_metadata, rank
       FROM ranked
       ORDER BY rank`,
      parameters,
    );
    return Object.freeze(
      result.rows.map((row) => toCandidate(row, "lexicalRank")),
    );
  }

  private async vector(
    input: RetrievalSearchInput,
    validated: ValidatedSearch,
    query: ValidatedVectorQuery,
  ): Promise<readonly RetrievalCandidate[]> {
    const parameters: unknown[] = [
      input.workspaceId,
      query.collectionIds,
      validated.authorizedSourceIds,
      query.query.embeddingBindingVersionId,
      query.query.embeddingProfileVersion,
      query.query.dimensions,
      vectorLiteral(query.query.vector),
      input.maximumCandidatesPerSource,
      input.maximumCandidatesPerSource * validated.authorizedSourceIds.length,
    ];
    const metadata = metadataPredicate(validated.metadataFilters, parameters);
    const distance = vectorDistanceExpression(query.query.dimensions);
    const result = await this.pool.query<SearchRow>(
      `WITH nearest AS (
         SELECT
           collection.id AS collection_id,
           source.id AS source_id,
           revision.id AS source_revision_id,
           chunk.id AS chunk_id,
           COALESCE(chunk.source_anchor, 'chunk:' || chunk.id) AS location,
           revision.source_url,
           chunk.content,
           revision.metadata AS access_metadata,
           ${distance} AS distance
         FROM knowledge_chunks AS chunk
         JOIN knowledge_embedding_cache_entries AS cache
           ON cache.workspace_id = chunk.workspace_id
          AND cache.id = chunk.embedding_cache_entry_id
         JOIN knowledge_revisions AS revision
           ON revision.workspace_id = chunk.workspace_id
          AND revision.id = chunk.knowledge_revision_id
         JOIN knowledge_documents AS document
           ON document.workspace_id = revision.workspace_id
          AND document.id = revision.knowledge_document_id
         JOIN knowledge_sources AS source
           ON source.workspace_id = document.workspace_id
          AND source.id = document.knowledge_source_id
         JOIN knowledge_collections AS collection
           ON collection.workspace_id = source.workspace_id
          AND collection.id = source.knowledge_collection_id
         WHERE chunk.workspace_id = $1
           AND collection.id = ANY($2::text[])
           AND source.id = ANY($3::text[])
           AND source.lifecycle = 'enabled'
           AND document.lifecycle = 'active'
           AND document.active_revision_id = revision.id
           AND revision.state = 'active'
           AND revision.embedding_binding_version_id = $4
           AND revision.embedding_profile_version = $5
           AND revision.embedding_dimensions = $6
           AND cache.embedding_binding_version_id = $4
           AND cache.embedding_profile_version = $5
           AND cache.dimensions = $6
           ${metadata}
         ORDER BY
           distance,
           collection.id,
           source.id,
           revision.id,
           chunk.id
         LIMIT $9
       ),
       matched AS (
         SELECT
           *,
           ROW_NUMBER() OVER (
             PARTITION BY source_id
             ORDER BY distance, collection_id, source_revision_id, chunk_id
           ) AS source_ordinal
         FROM nearest
       ),
       source_bounded AS (
         SELECT *
         FROM matched
         WHERE source_ordinal <= $8
       ),
       ranked AS (
         SELECT
           *,
           (ROW_NUMBER() OVER (
             ORDER BY distance, collection_id, source_id, source_revision_id, chunk_id
           ))::integer AS rank
         FROM source_bounded
       )
       SELECT
         collection_id, source_id, source_revision_id, chunk_id, location,
         source_url, content, access_metadata, rank
       FROM ranked
       ORDER BY rank`,
      parameters,
    );
    return Object.freeze(
      result.rows.map((row) => toCandidate(row, "vectorRank")),
    );
  }
}

export function createPostgresRetrievalPersistence(
  configuration: PostgresRetrievalPersistenceConfiguration,
): PostgresRetrievalPersistence {
  requireText(configuration.databaseUrl, "PostgreSQL database URL");
  const pool = new Pool({ connectionString: configuration.databaseUrl });
  const adapter = new PostgresRetrievalAdapter(pool, configuration);
  return Object.freeze({
    search: adapter,
    snapshots: adapter,
    close: async () => pool.end(),
  });
}
