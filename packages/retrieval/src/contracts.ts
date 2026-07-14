export interface AiBudgetPolicy {
  readonly currency: string;
  readonly hard: boolean;
  readonly allowUnknownPricing?: boolean;
}

/**
 * A collection's immutable vector-space identity. Collections with the same
 * binding must also share profile and dimensions before their query vector is
 * reused.
 */
export interface RetrievalCollection {
  readonly id: string;
  readonly embeddingBindingVersionId: string;
  readonly embeddingProfileVersion: string;
  readonly dimensions: number;
}

export interface SourceQuota {
  readonly sourceId: string;
  readonly maximumCandidates: number;
  readonly maximumFinalResults: number;
}

export interface RetrievalPolicy {
  readonly rankConstant: number;
  readonly lexicalWeight: number;
  readonly vectorWeight: number;
  readonly maximumFinalResults: number;
  readonly maximumCharacters: number;
  readonly maximumTokens: number;
  readonly defaultSourceQuota: Omit<SourceQuota, "sourceId">;
  readonly sourceQuotas: readonly SourceQuota[];
}

export interface QueryEmbeddingPolicy {
  readonly maximumInputTokens: number;
  readonly budget: AiBudgetPolicy;
}

export interface RerankerPolicy {
  readonly bindingVersionId: string;
  readonly maximumCandidates: number;
  readonly maximumInputTokens: number;
  readonly timeoutMs?: number;
  readonly budget: AiBudgetPolicy;
}

export interface RetrievalProfile {
  readonly id: string;
  readonly version: string;
  readonly collections: readonly RetrievalCollection[];
  readonly policy: RetrievalPolicy;
  readonly queryEmbedding: QueryEmbeddingPolicy;
  /** Omit to retain fused RRF ordering without an additional AI operation. */
  readonly reranker?: RerankerPolicy;
}

/**
 * This is the authorization decision made at the application boundary. The
 * search adapter must enforce it in its query, and the service defends against
 * an adapter returning a source outside this set.
 */
export interface RetrievalAccessScope {
  readonly authorizedSourceIds: readonly string[];
}

export type RetrievalFilterValue = string | number | boolean | null;

export interface RetrievalRequest {
  readonly workspaceId: string;
  readonly query: string;
  readonly profile: RetrievalProfile;
  readonly access: RetrievalAccessScope;
  readonly metadataFilters?: Readonly<
    Record<string, readonly RetrievalFilterValue[]>
  >;
  readonly snapshot: {
    readonly id: string;
    readonly analysisId?: string;
    readonly capturedAt: string;
  };
  readonly signal: AbortSignal;
}

export interface QueryEmbedding {
  readonly embeddingBindingVersionId: string;
  readonly embeddingProfileVersion: string;
  readonly dimensions: number;
  readonly collectionIds: readonly string[];
  readonly vector: readonly number[];
}

export interface RetrievalSearchInput {
  readonly workspaceId: string;
  readonly query: string;
  readonly collections: readonly RetrievalCollection[];
  readonly vectorQueries: readonly QueryEmbedding[];
  readonly access: RetrievalAccessScope;
  readonly metadataFilters?: Readonly<
    Record<string, readonly RetrievalFilterValue[]>
  >;
  /**
   * Per-source bounds must be applied by the persistence adapter, rather than
   * loading a corpus into process memory.
   */
  readonly maximumCandidatesPerSource: number;
  readonly signal: AbortSignal;
}

export interface RetrievalCandidate {
  readonly collectionId: string;
  readonly sourceId: string;
  readonly sourceRevisionId: string;
  readonly chunkId: string;
  readonly location: string;
  readonly sourceUrl?: string;
  readonly content: string;
  readonly activeRevision: boolean;
  readonly lexicalRank?: number;
  readonly vectorRank?: number;
  readonly accessMetadata: Readonly<Record<string, RetrievalFilterValue>>;
}

/**
 * Database adapters perform bounded lexical/vector search and enforce active
 * revision, workspace, and source-access predicates before returning rows.
 */
export interface RetrievalSearchPort {
  search(input: RetrievalSearchInput): Promise<readonly RetrievalCandidate[]>;
}

export interface RetrievalTokenCounter {
  count(text: string): number;
}

export interface RetrievalEvidenceScores {
  readonly fusedRrf: number;
  readonly lexicalRrf: number;
  readonly vectorRrf: number;
  readonly reranker?: number;
}

export interface RetrievalEvidence {
  readonly collectionId: string;
  readonly sourceId: string;
  readonly sourceRevisionId: string;
  readonly chunkId: string;
  readonly location: string;
  readonly sourceUrl?: string;
  readonly content: string;
  readonly accessMetadata: Readonly<Record<string, RetrievalFilterValue>>;
  readonly scores: RetrievalEvidenceScores;
  readonly characterCount: number;
  readonly tokenCount: number;
}

export interface RetrievalSnapshot {
  readonly id: string;
  readonly workspaceId: string;
  readonly analysisId?: string;
  readonly capturedAt: string;
  readonly query: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly queryEmbeddingOperationIds: Readonly<Record<string, string>>;
  readonly rerankerOperationId?: string;
  readonly evidence: readonly RetrievalEvidence[];
}

/**
 * Implementations persist insert-only snapshots and reject an existing ID.
 * The frozen evidence is the exact context observed by the caller.
 */
export interface RetrievalSnapshotPort {
  persist(snapshot: RetrievalSnapshot): Promise<void>;
}

export interface RetrievalDependencies {
  readonly search: RetrievalSearchPort;
  readonly snapshots: RetrievalSnapshotPort;
  readonly tokens: RetrievalTokenCounter;
}
