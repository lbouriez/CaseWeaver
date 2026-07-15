import type { AiExecutionGateway } from "@caseweaver/ai-execution";
import type { EmbeddingResult } from "@caseweaver/ai-sdk";
import type {
  ExternalFingerprint,
  ExternalReference,
  ExternalRevision,
  KnowledgeDocument,
  KnowledgeProvenance,
  KnowledgeSource,
  SourceAnchor,
  VersionedOpaqueValue,
} from "@caseweaver/connector-sdk";

export type {
  ExternalFingerprint,
  ExternalReference,
  ExternalRevision,
  KnowledgeDocument,
  KnowledgeSource,
  VersionedOpaqueValue,
};

export interface KnowledgeCollection {
  readonly id: string;
  /** Immutable AI binding version for this collection's vector space. */
  readonly embeddingBindingVersionId: string;
  readonly embeddingProfileVersion: string;
  readonly dimensions: number;
  readonly maximumInputTokens: number;
  readonly budget: {
    readonly currency: string;
    readonly hard: boolean;
    readonly allowUnknownPricing?: boolean;
  };
}

export type KnowledgeSynchronizationTrigger =
  | Readonly<{ readonly mode: "manual" }>
  | Readonly<{ readonly mode: "webhook" }>
  | Readonly<{
      readonly mode: "cron";
      readonly expression: string;
      readonly timezone: string;
      readonly jitterMs?: number;
      readonly overlapPolicy: "skip" | "queue";
      readonly maximumDurationMs: number;
    }>
  | Readonly<{
      readonly mode: "interval";
      readonly intervalMs: number;
      readonly jitterMs?: number;
      readonly overlapPolicy: "skip" | "queue";
      readonly maximumDurationMs: number;
    }>;

export interface SourceSynchronizationPolicy {
  readonly triggers: readonly KnowledgeSynchronizationTrigger[];
  readonly periodicFullRescanIntervalMs?: number;
}

export interface KnowledgeSourceConfiguration {
  readonly id: string;
  readonly workspaceId: string;
  readonly connectorInstanceId: string;
  readonly collection: KnowledgeCollection;
  readonly normalizationProfileVersion: string;
  readonly chunkingProfileVersion: string;
  readonly synchronization: SourceSynchronizationPolicy;
  readonly embeddingBatchSize: number;
}

export interface NormalizedKnowledgeDocument {
  readonly normalizedText: string;
  /** The connector-opaque revision used to load this exact source version. */
  readonly externalRevision?: ExternalRevision;
  /**
   * Attachment identity is supplied by a normalizer when attachments contribute to
   * searchable content. Cosmetic source metadata deliberately does not affect this.
   */
  readonly attachmentIdentity?: string;
  readonly title?: string;
  readonly sourceUrl?: string;
  /** Source-neutral evidence retained from the loaded document. */
  readonly provenance?: KnowledgeProvenance;
  /** Source-defined locations available to heading-aware chunking profiles. */
  readonly sourceAnchors?: readonly SourceAnchor[];
  readonly metadata?: Readonly<
    Record<string, string | number | boolean | null>
  >;
}

export interface KnowledgeNormalizer {
  normalize(input: {
    readonly document: KnowledgeDocument;
    readonly normalizationProfileVersion: string;
    readonly signal: AbortSignal;
  }): Promise<NormalizedKnowledgeDocument>;
}

export interface PreparedAttachment {
  readonly reference: ExternalReference;
  readonly searchableText?: string;
}

/**
 * Knowledge ingestion requests attachment preparation through a port. Attachment runtimes own
 * fetching and parsing and are never imported into knowledge ingestion.
 */
export interface AttachmentPreparationPort {
  prepare(input: {
    readonly sourceId: string;
    readonly workspaceId: string;
    readonly document: KnowledgeDocument;
    readonly signal: AbortSignal;
  }): Promise<readonly PreparedAttachment[]>;
}

export interface ChunkCandidate {
  readonly content: string;
  readonly sourceAnchor?: string;
}

export interface KnowledgeChunker {
  chunk(input: {
    readonly document: NormalizedKnowledgeDocument;
    readonly attachments: readonly PreparedAttachment[];
    readonly chunkingProfileVersion: string;
  }): Promise<readonly ChunkCandidate[]>;
}

export interface StoredKnowledgeItem {
  readonly documentId: string;
  readonly activeRevisionId?: string;
  readonly activeContentHash?: string;
  readonly activeEmbeddingSpace?: ActiveEmbeddingSpace;
  readonly lastSuccessfulFingerprint?: ExternalFingerprint;
}

export interface ActiveEmbeddingSpace {
  readonly embeddingBindingVersionId: string;
  readonly embeddingProfileVersion: string;
  readonly dimensions: number;
  readonly normalizationProfileVersion: string;
}

export interface EmbeddingCacheIdentity {
  readonly chunkHash: string;
  readonly embeddingBindingVersionId: string;
  readonly embeddingProfileVersion: string;
  readonly dimensions: number;
  readonly normalizationProfileVersion: string;
}

export interface CachedEmbedding {
  readonly identity: EmbeddingCacheIdentity;
  readonly vector: readonly number[];
}

export interface EmbeddingCostAllocation {
  readonly operationId: string;
  readonly allocatedInputTokens?: number;
  readonly calculatedCostAmount?: string;
  readonly calculatedCostCurrency?: string;
  readonly calculationStatus: "known" | "unknown" | "incomplete";
  /** Exact attribution when a decimal cost cannot be divided without rounding. */
  readonly weightNumerator: number;
  readonly weightDenominator: number;
}

export interface NewCachedEmbedding extends CachedEmbedding {
  readonly allocation: EmbeddingCostAllocation;
}

export interface KnowledgeChunkDraft {
  readonly id: string;
  readonly position: number;
  readonly contentHash: string;
  readonly content: string;
  readonly sourceAnchor?: string;
  readonly embedding: EmbeddingCacheIdentity;
}

export interface ActivatedRevision {
  readonly kind: "activate";
  readonly reference: ExternalReference;
  readonly observedAt: string;
  readonly fingerprint?: ExternalFingerprint;
  readonly revisionId: string;
  readonly contentHash: string;
  readonly normalized: NormalizedKnowledgeDocument;
  readonly normalizationProfileVersion: string;
  readonly chunkingProfileVersion: string;
  readonly embeddingSpace: ActiveEmbeddingSpace;
  readonly chunks: readonly KnowledgeChunkDraft[];
}

export interface ObservedKnowledgeItem {
  readonly kind: "observe";
  readonly reference: ExternalReference;
  readonly observedAt: string;
  readonly fingerprint?: ExternalFingerprint;
  readonly contentHash?: string;
}

export interface TombstonedKnowledgeItem {
  readonly kind: "tombstone";
  readonly reference: ExternalReference;
  readonly observedAt: string;
}

export type KnowledgeMutation =
  | ActivatedRevision
  | ObservedKnowledgeItem
  | TombstonedKnowledgeItem;

export interface FailedRevisionDiagnostic {
  readonly sourceId: string;
  readonly workspaceId: string;
  readonly reference: ExternalReference;
  readonly observedAt: string;
  readonly revisionId?: string;
  readonly contentHash?: string;
  readonly stage: "load" | "normalize" | "attachments" | "chunk" | "embedding";
  readonly code: string;
  readonly retryable: boolean;
  readonly message: string;
}

export interface CompletedScan {
  readonly mode: "snapshot" | "delta";
  readonly cursor?: VersionedOpaqueValue;
  readonly scanEpoch?: VersionedOpaqueValue;
  readonly completedAt: string;
}

export interface KnowledgeIngestionStore {
  findItem(input: {
    readonly workspaceId: string;
    readonly sourceId: string;
    readonly reference: ExternalReference;
  }): Promise<StoredKnowledgeItem | undefined>;
  findReusableEmbeddings(input: {
    readonly workspaceId: string;
    readonly identities: readonly EmbeddingCacheIdentity[];
  }): Promise<readonly CachedEmbedding[]>;
  /**
   * The adapter must transactionally persist embeddings, mutations, snapshot
   * reconciliation, and the completed cursor as one commit.
   */
  commit(input: {
    readonly workspaceId: string;
    readonly sourceId: string;
    readonly scan: CompletedScan;
    readonly mutations: readonly KnowledgeMutation[];
    readonly newEmbeddings: readonly NewCachedEmbedding[];
  }): Promise<void>;
  recordFailedRevision(diagnostic: FailedRevisionDiagnostic): Promise<void>;
}

export interface KnowledgeIdGenerator {
  next(kind: "knowledgeRevision"): string;
}

export interface KnowledgeClock {
  now(): string;
}

export interface KnowledgeIngestionDependencies {
  readonly store: KnowledgeIngestionStore;
  readonly normalizer: KnowledgeNormalizer;
  readonly chunker: KnowledgeChunker;
  readonly ai: AiExecutionGateway;
  readonly ids: KnowledgeIdGenerator;
  readonly clock: KnowledgeClock;
  readonly attachments?: AttachmentPreparationPort;
}

export interface KnowledgeSynchronizationRequest {
  readonly configuration: KnowledgeSourceConfiguration;
  readonly source: KnowledgeSource;
  readonly signal: AbortSignal;
  readonly cursor?: VersionedOpaqueValue;
}

export interface KnowledgeSynchronizationResult {
  readonly mode: "snapshot" | "delta";
  readonly processed: number;
  readonly fingerprintNoops: number;
  readonly normalizedNoops: number;
  readonly activatedRevisions: number;
  readonly tombstones: number;
  readonly embeddedChunks: number;
}

export interface EmbeddingGatewayResult {
  readonly value: EmbeddingResult;
}
