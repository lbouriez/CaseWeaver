import type {
  AttachmentSource,
  ExternalReference,
} from "@caseweaver/connector-sdk";

export interface BlobHandle {
  readonly workspaceId: string;
  readonly key: string;
}

export interface BlobStagingHandle {
  readonly workspaceId: string;
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
  privateUrl(handle: BlobHandle, workspaceId: string): Promise<string>;
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

export interface VisionPolicy {
  readonly prompt: string;
  readonly promptVersion: string;
  readonly bindingVersionId: string;
  readonly maximumInputTokens: number;
  readonly maximumOutputTokens: number;
  readonly budget: {
    readonly currency: string;
    readonly hard: boolean;
    readonly allowUnknownPricing?: boolean;
  };
}
