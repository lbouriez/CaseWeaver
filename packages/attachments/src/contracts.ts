import type {
  AttachmentOpenIdentity,
  AttachmentSource,
  ExternalReference,
} from "@caseweaver/connector-sdk";
import type {
  AttachmentPreparationPolicy,
  AttachmentPreparationResult,
} from "./preparation.js";

export interface BlobHandle {
  readonly workspaceId: string;
  /** Deployment-selected storage namespace; never a bucket, endpoint, or credential. */
  readonly storageBackendId: string;
  readonly key: string;
}

export interface BlobStagingHandle {
  readonly workspaceId: string;
  readonly storageBackendId: string;
  readonly id: string;
}

export interface BlobStore {
  beginStaging(input: {
    readonly workspaceId: string;
    readonly maximumBytes: number;
    readonly signal: AbortSignal;
  }): Promise<BlobStagingHandle>;
  append(
    staging: BlobStagingHandle,
    content: Uint8Array,
    signal: AbortSignal,
  ): Promise<void>;
  commit(
    staging: BlobStagingHandle,
    input: { readonly sha256: string; readonly byteLength: number },
    signal: AbortSignal,
  ): Promise<BlobHandle>;
  abort(staging: BlobStagingHandle): Promise<void>;
  open(
    handle: BlobHandle,
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>>;
  writeText(
    handle: BlobHandle,
    workspaceId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<void>;
  delete(handle: BlobHandle, workspaceId: string): Promise<void>;
}

export interface AttachmentOutputStore {
  createOutput(workspaceId: string, signal: AbortSignal): Promise<BlobHandle>;
}

export interface AttachmentRuntimeAttestation {
  readonly networkDisabled: true;
  readonly credentialsUnavailable: true;
  readonly disposableFilesystem: true;
  readonly quotasEnforced: true;
}

export interface AttachmentRuntimeQuotas {
  readonly timeoutMs: number;
  readonly maximumMemoryBytes: number;
  /** Runtime independently bounds a reopened opaque input blob before staging. */
  readonly maximumInputBytes: number;
  readonly maximumOutputBytes: number;
  readonly maximumFiles: number;
  readonly maximumExpandedBytes: number;
  readonly maximumExtractedFileBytes: number;
  readonly maximumArchiveDepth: number;
  readonly maximumCompressionRatio: number;
}

export type AttachmentRuntimeProcessor = "text" | "zip";

export interface AttachmentRuntimeRequest {
  readonly workspaceId: string;
  readonly processor: AttachmentRuntimeProcessor;
  readonly input: BlobHandle;
  readonly output: BlobHandle;
  readonly quotas: AttachmentRuntimeQuotas;
  readonly signal: AbortSignal;
}

export interface AttachmentRuntimeResult {
  readonly output: BlobHandle;
  readonly outputByteLength: number;
  readonly attestation: AttachmentRuntimeAttestation;
}

export interface AttachmentRuntime {
  execute(request: AttachmentRuntimeRequest): Promise<AttachmentRuntimeResult>;
  cleanup(input: {
    readonly workspaceId: string;
    readonly handles: readonly BlobHandle[];
  }): Promise<void>;
}

export interface AttachmentIntakePolicy {
  readonly maximumAttachmentBytes: number;
  readonly allowedMimeTypes: ReadonlySet<string>;
}

export interface AttachmentIntakeRequest {
  readonly workspaceId: string;
  readonly source: AttachmentSource;
  readonly reference: ExternalReference;
  readonly blobStore: BlobStore;
  readonly declaredMimeType?: string;
  readonly policy: AttachmentIntakePolicy;
  readonly signal: AbortSignal;
}

export interface AcceptedAttachment {
  readonly workspaceId: string;
  readonly sourceReference: ExternalReference;
  readonly blob: BlobHandle;
  readonly byteLength: number;
  readonly sha256: string;
  readonly detectedMimeType: string;
  readonly declaredMimeType?: string;
}

export interface DerivativeCacheIdentityInput {
  readonly workspaceId: string;
  readonly accessPolicyHash: string;
  readonly contentSha256: string;
  readonly processor: string;
  readonly processorVersion: string;
  readonly securityPolicyVersion: string;
  readonly normalizationVersion: string;
  readonly visionPromptVersion?: string;
  readonly visionBindingVersionId?: string;
}

export interface DerivativeCacheIdentity extends DerivativeCacheIdentityInput {
  readonly key: string;
}

export type AttachmentProcessingParameters = Pick<
  DerivativeCacheIdentityInput,
  | "processor"
  | "processorVersion"
  | "securityPolicyVersion"
  | "normalizationVersion"
>;

export interface AttachmentDerivative {
  readonly id: string;
  readonly identity: DerivativeCacheIdentity;
  readonly status: "completed";
  readonly output: BlobHandle;
  readonly mimeType: "text/plain";
  /** SHA-256 of the exact canonical UTF-8 bytes in `output`. */
  readonly outputContentHash: string;
  /** Exact byte length of the canonical UTF-8 bytes in `output`. */
  readonly outputByteLength: number;
  readonly operationId?: string;
}

export interface AttachmentSkip {
  readonly status: "skipped";
  readonly code: "attachment.unsupportedMime";
  readonly mimeType: string;
}

export type DerivativeClaim =
  | Readonly<{
      readonly kind: "completed";
      readonly derivative: AttachmentDerivative;
    }>
  | Readonly<{ readonly kind: "claimed"; readonly claimId: string }>
  | Readonly<{ readonly kind: "inProgress" }>;

export interface AttachmentRepository {
  claimDerivative(identity: DerivativeCacheIdentity): Promise<DerivativeClaim>;
  completeDerivative(input: {
    readonly claimId: string;
    readonly derivative: AttachmentDerivative;
  }): Promise<void>;
  failDerivative(input: {
    readonly claimId: string;
    readonly code: string;
    readonly retryable: boolean;
  }): Promise<void>;
}

/**
 * A server-private storage record for frozen analysis evidence. This is an
 * infrastructure boundary, not an API DTO: callers must never serialize the
 * opaque storage handle outside trusted server composition.
 */
export interface AttachmentDerivativeEvidenceRecord {
  readonly workspaceId: string;
  readonly attachmentId: string;
  readonly derivativeId: string;
  readonly output: BlobHandle;
  readonly outputContentHash: string;
  readonly outputByteLength: number;
}

/**
 * Resolves one retention-active, completed derivative only when it is linked
 * to the requested attachment in the requested workspace.
 */
export interface AttachmentDerivativeEvidenceRecordStore {
  findDerivativeEvidenceRecord(input: {
    readonly workspaceId: string;
    readonly attachmentId: string;
    readonly derivativeId: string;
    readonly signal: AbortSignal;
  }): Promise<AttachmentDerivativeEvidenceRecord | undefined>;
}

export interface VisionPolicy {
  readonly prompt: string;
  readonly promptVersion: string;
  readonly bindingVersionId: string;
  /** Server-configured cap for bytes held while constructing a vision request. */
  readonly maximumInlineBytes: number;
  readonly maximumInputTokens: number;
  readonly maximumOutputTokens: number;
  readonly budget: {
    readonly currency: string;
    readonly hard: boolean;
    readonly allowUnknownPricing?: boolean;
  };
}

/**
 * The durable logical item whose attachments are being prepared. This is
 * deliberately earlier than a knowledge revision or final case snapshot: both
 * are allowed to pin the completed evidence later, but neither can exist as a
 * prerequisite for preparation.
 */
export type AttachmentPreparationSubjectKind = "sourceDocument" | "caseCapture";

export interface AttachmentPreparationSubject {
  readonly workspaceId: string;
  readonly kind: AttachmentPreparationSubjectKind;
  /** A stable CaseWeaver-owned identifier, never an external locator or URL. */
  readonly id: string;
}

/**
 * Public-safe, immutable information about one attachment appearance. Multiple
 * occurrences may safely point at the same binary and derivative cache entry.
 */
export interface AttachmentOccurrenceDescriptor {
  readonly identity: string;
  /**
   * Opaque hash of the normalized owner. It keeps case/document/message
   * provenance distinct without retaining an external ID or locator.
   */
  readonly ownerIdentity?: string;
  /**
   * The connector-normalized ordinal within that owner. `ordinal` below is a
   * preparation-local sequence because a case description and each comment
   * legitimately all start at zero.
   */
  readonly sourceOrdinal?: number;
  readonly ordinal: number;
  /**
   * Opaque server-private attachment identity. It pins ready derivative
   * evidence to this occurrence without carrying a locator, URL, path,
   * filename, byte content, or browser/API-readable metadata.
   */
  readonly attachmentId: string;
  readonly relation: string;
  readonly required: boolean;
}

/**
 * Server-only reopening material. `openIdentity.locator` is opaque connector
 * data and must never be serialized to API responses, audit records, logs,
 * traces, diagnostics, or browser state.
 */
export interface ServerPrivateAttachmentOccurrence {
  readonly occurrence: AttachmentOccurrenceDescriptor;
  readonly source: AttachmentSource;
  readonly reference: ExternalReference;
  readonly openIdentity?: AttachmentOpenIdentity;
  readonly declaredMimeType?: string;
}

/**
 * A derivative linked to its distinct occurrence for durable evidence. This is
 * a server persistence contract: its storage handle is not an API DTO.
 */
export interface ServerPrivateAttachmentOccurrenceEvidence {
  readonly occurrence: AttachmentOccurrenceDescriptor;
  readonly derivative: AttachmentDerivative;
}

/**
 * Trusted persistence hook for live occurrence preparation. It records only
 * the accepted blob metadata and its immutable derivative association; the
 * locator, source bytes, output text, and storage handle remain private to
 * the surrounding worker composition.
 */
export interface AttachmentOccurrencePersistence {
  recordAccepted(input: {
    readonly subject: AttachmentPreparationSubject;
    readonly occurrence: AttachmentOccurrenceDescriptor;
    readonly attachment: AcceptedAttachment;
    readonly signal: AbortSignal;
  }): Promise<void>;
  recordDerivativeSource(input: {
    readonly subject: AttachmentPreparationSubject;
    readonly occurrence: AttachmentOccurrenceDescriptor;
    readonly derivative: AttachmentDerivative;
    readonly signal: AbortSignal;
  }): Promise<void>;
}

/**
 * A fence-bearing attempt created for one stable subject and exact preparation
 * plan. Implementations must reject finalization after lease expiry or reclaim
 * and must create a new immutable attempt when retrying a terminal outcome.
 */
export interface AttachmentPreparationAttempt {
  readonly id: string;
  readonly fence: string;
  readonly planIdentity: string;
  readonly retryOfAttemptId?: string;
}

/**
 * A completed attempt's immutable identity. It intentionally omits the
 * short-lived fence, so downstream revision/snapshot persistence can pin the
 * terminal work without gaining authority to finalize or reclaim it.
 */
export interface AttachmentPreparationAttemptReference {
  readonly id: string;
  readonly planIdentity: string;
}

export type AttachmentPreparationAttemptClaim =
  | Readonly<{
      readonly kind: "claimed";
      readonly attempt: AttachmentPreparationAttempt;
    }>
  | Readonly<{
      readonly kind: "completed";
      readonly attempt: AttachmentPreparationAttemptReference;
      readonly result: AttachmentPreparationResult;
    }>;

/**
 * Durable boundary for immutable attachment evidence. Its `finalize` operation
 * persists every occurrence evidence record and its safe preparation result in
 * one transaction under the supplied fence. It intentionally exposes no SQL,
 * ORM, connector vendor, or storage implementation detail.
 */
export interface AttachmentPreparationAttemptStore {
  claim(input: {
    readonly subject: AttachmentPreparationSubject;
    readonly policy: AttachmentPreparationPolicy;
    readonly planIdentity: string;
    readonly occurrences: readonly AttachmentOccurrenceDescriptor[];
    readonly signal: AbortSignal;
  }): Promise<AttachmentPreparationAttemptClaim>;
  finalize(input: {
    readonly attempt: AttachmentPreparationAttempt;
    readonly result: AttachmentPreparationResult;
    readonly evidence: readonly ServerPrivateAttachmentOccurrenceEvidence[];
    readonly signal: AbortSignal;
  }): Promise<void>;
}
