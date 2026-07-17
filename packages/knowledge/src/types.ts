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
    /** Opaque policy identity retained for execution diagnostics and audit only. */
    readonly policyReference?: string;
  };
}

/** A source command selects its discovery semantics explicitly. */
export type KnowledgeExecutionMode = "incremental" | "fullRescan";

export interface KnowledgeDiscoveryControl {
  readonly mode: KnowledgeExecutionMode;
  /** Full rescans are explicit resets, never inferred solely from an absent cursor. */
  readonly reset: boolean;
  readonly cursor?: VersionedOpaqueValue;
  readonly signal: AbortSignal;
}

/** Opaque durable fencing identity. Callers must not derive or reinterpret it. */
export interface KnowledgeSourceExecutionFence {
  readonly value: string;
}

export interface ImmutableKnowledgeCollectionExecution
  extends KnowledgeCollection {
  readonly runtimeVersionId: string;
}

/**
 * Safe runtime projection of an immutable source/connector/collection selection.
 * It intentionally excludes connector settings, credential locators, and clients.
 */
export interface PinnedKnowledgeSourceConfiguration {
  readonly workspaceId: string;
  readonly sourceId: string;
  readonly sourceConfigurationVersionId: string;
  readonly connectorConfigurationVersionId: string;
  readonly connectorRegistrationId: string;
  readonly collection: ImmutableKnowledgeCollectionExecution;
  readonly normalizationProfile: Readonly<{
    readonly id: string;
    readonly version: string;
  }>;
  readonly chunkingProfile: Readonly<{
    readonly id: string;
    readonly version: string;
  }>;
  readonly synchronization: SourceSynchronizationPolicy;
  readonly embeddingBatchSize: number;
  /**
   * Immutable source-owned attachment policy. It is absent only for legacy
   * source versions that predate attachment preparation.
   */
  readonly attachmentPreparation?: AttachmentPreparationPolicy;
}

/** Fail-closed private resolver: missing, legacy, disabled, or mismatched pins return undefined. */
export interface PinnedKnowledgeSourceConfigurationResolver {
  resolve(
    input: Readonly<{
      readonly workspaceId: string;
      readonly sourceId: string;
      readonly sourceConfigurationVersionId: string;
      readonly connectorConfigurationVersionId: string;
    }>,
  ): Promise<PinnedKnowledgeSourceConfiguration | undefined>;
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
  readonly normalizationProfileId: string;
  readonly normalizationProfileVersion: string;
  readonly chunkingProfileId: string;
  readonly chunkingProfileVersion: string;
  readonly synchronization: SourceSynchronizationPolicy;
  readonly embeddingBatchSize: number;
  /**
   * Immutable attachment handling. Omitted only for legacy source versions that
   * never requested attachment preparation; new source versions pin this policy.
   */
  readonly attachmentPreparation?: AttachmentPreparationPolicy;
  /**
   * Exact runtime pins needed to reopen attachment bytes. They are supplied
   * solely by the durable source-version resolver; callers must never infer
   * them from a mutable source or connector configuration.
   */
  readonly attachmentPreparationPins?: Readonly<{
    readonly sourceConfigurationVersionId: string;
    readonly connectorRegistrationId: string;
    readonly connectorConfigurationVersionId: string;
  }>;
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

export type AttachmentPreparationMode = "disabled" | "optional" | "required";

/**
 * This consumer projection is structurally compatible with the attachment
 * package's producer contract. Keeping it local prevents a sibling feature
 * dependency while allowing trusted composition to adapt PBI-008 processing.
 */
export interface AttachmentPreparationPolicy {
  readonly mode: AttachmentPreparationMode;
  readonly policyVersion: string;
  readonly accessPolicyHash: string;
}

/** A bounded safe diagnostic; it never carries a URL, locator, blob key, or text. */
export interface AttachmentPreparationWarning {
  readonly kind: "attachmentPreparationWarning";
  readonly code: string;
  readonly retryable: boolean;
  readonly occurrenceIdentity?: string;
}

export interface SelectedAttachmentDerivative {
  readonly occurrenceIdentity: string;
  readonly derivativeIdentity: string;
  readonly derivativeContentHash: string;
}

/**
 * Server-private result returned by the attachment runtime. The policy remains
 * here only long enough for knowledge ingestion to verify that the runtime
 * honoured the immutable source policy that it was given. This type must never
 * be placed in a durable activation or store payload.
 */
export interface AttachmentPreparationOutcome {
  readonly status: "prepared" | "terminal";
  readonly identityHash: string;
  readonly policy: AttachmentPreparationPolicy;
  readonly selectedDerivatives: readonly SelectedAttachmentDerivative[];
  readonly warnings: readonly AttachmentPreparationWarning[];
  readonly retryRequired: boolean;
}

/**
 * Policy-free attachment state retained with an activated knowledge revision.
 *
 * The policy itself remains in the immutable source configuration. Its hash is
 * retained separately on the activation for no-op comparison, while this
 * projection preserves only the result identities that an active revision
 * needs to describe its derived evidence and retry state.
 */
export interface ActivatedAttachmentPreparation {
  readonly status: "prepared" | "terminal";
  readonly identityHash: string;
  readonly selectedDerivatives: readonly SelectedAttachmentDerivative[];
  readonly warnings: readonly AttachmentPreparationWarning[];
  readonly retryRequired: boolean;
}

export interface KnowledgeNormalizer {
  normalize(input: {
    readonly document: KnowledgeDocument;
    readonly normalizationProfileVersion: string;
    readonly signal: AbortSignal;
  }): Promise<NormalizedKnowledgeDocument>;
}

/**
 * Server-private canonical derivative text used only to create derived evidence
 * chunks. It is never copied into an attachment outcome or durable activation
 * projection.
 */
export interface PreparedAttachment extends SelectedAttachmentDerivative {
  readonly searchableText: string;
}

export interface AttachmentPreparationResult {
  readonly outcome: AttachmentPreparationOutcome;
  readonly derivatives: readonly PreparedAttachment[];
  /**
   * Opaque immutable terminal-attempt identity supplied by trusted worker
   * composition. It is pinned by persistence, never exposed in a read model.
   */
  readonly attemptId?: string;
}

/**
 * Knowledge ingestion requests attachment preparation through a port. Attachment runtimes own
 * fetching and parsing and are never imported into knowledge ingestion.
 */
export interface AttachmentPreparationPort {
  prepare(input: {
    readonly sourceId: string;
    readonly workspaceId: string;
    readonly sourceConfigurationVersionId: string;
    readonly connectorRegistrationId: string;
    readonly connectorConfigurationVersionId: string;
    readonly document: KnowledgeDocument;
    readonly policy: AttachmentPreparationPolicy;
    readonly signal: AbortSignal;
  }): Promise<AttachmentPreparationResult>;
}

export interface ChunkCandidate {
  readonly content: string;
  readonly sourceAnchor?: string;
  /** Source chunks are immutable normalizer output; evidence chunks are derived. */
  readonly kind?: "source" | "attachmentEvidence";
  readonly attachmentEvidence?: SelectedAttachmentDerivative;
}

export interface KnowledgeChunker {
  chunk(input: {
    readonly document: NormalizedKnowledgeDocument;
    /**
     * Attachment text is never supplied to arbitrary chunker implementations.
     * Ingestion creates dedicated derived evidence chunks after source chunking.
     */
    readonly attachments: readonly [];
    readonly chunkingProfileVersion: string;
  }): Promise<readonly ChunkCandidate[]>;
}

export interface KnowledgeTextProfileRegistry {
  resolve(
    input: Readonly<{
      readonly normalizationProfileId: string;
      readonly normalizationProfileVersion: string;
      readonly chunkingProfileId: string;
      readonly chunkingProfileVersion: string;
    }>,
  ):
    | Readonly<{
        readonly normalizer: KnowledgeNormalizer;
        readonly chunker: KnowledgeChunker;
      }>
    | undefined;
}

export interface StoredKnowledgeItem {
  readonly documentId: string;
  readonly activeRevisionId?: string;
  readonly activeContentHash?: string;
  readonly activeEmbeddingSpace?: ActiveEmbeddingSpace;
  /**
   * Hash-only identity of the attachment policy used by the active revision.
   * `undefined` is the durable representation of a legacy/no-policy revision.
   */
  readonly activeAttachmentPreparationPolicyIdentity?: string;
  /** Retries must not be hidden by an otherwise unchanged source fingerprint. */
  readonly activeAttachmentPreparationRetryRequired?: boolean;
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
  readonly kind: "source" | "attachmentEvidence";
  readonly attachmentEvidence?: SelectedAttachmentDerivative;
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
  /**
   * Hash-only identity persisted with the active revision/item state. It is
   * `undefined` clears a former policy identity for a legacy/no-policy source
   * version, rather than leaving stale policy state on the active item.
   */
  readonly attachmentPreparationPolicyIdentity: string | undefined;
  /**
   * Policy-free preparation result. The immutable policy remains solely in the
   * source configuration identified by `attachmentPreparationPolicyIdentity`.
   */
  readonly attachmentPreparation?: ActivatedAttachmentPreparation;
  /** Server-private stable attempt pin, committed with this exact revision. */
  readonly attachmentPreparationAttemptId?: string;
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
    readonly fence: KnowledgeSourceExecutionFence;
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
  /** Immutable profile lookup; there is deliberately no mutable/default profile fallback. */
  readonly profiles: KnowledgeTextProfileRegistry;
  readonly ai: AiExecutionGateway;
  readonly ids: KnowledgeIdGenerator;
  readonly clock: KnowledgeClock;
  readonly attachments?: AttachmentPreparationPort;
}

export interface KnowledgeSynchronizationRequest {
  readonly configuration: KnowledgeSourceConfiguration;
  readonly source: KnowledgeSource;
  readonly signal: AbortSignal;
  readonly discovery: KnowledgeDiscoveryControl;
  readonly fence: KnowledgeSourceExecutionFence;
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
