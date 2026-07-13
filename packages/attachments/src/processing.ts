import type {
  AiExecutionGateway,
  MeteredAiResult,
} from "@caseweaver/ai-execution";
import type { VisionResult } from "@caseweaver/ai-sdk";

import type {
  AcceptedAttachment,
  AttachmentDerivative,
  AttachmentOutputStore,
  AttachmentProcessingParameters,
  AttachmentRepository,
  AttachmentRuntime,
  AttachmentRuntimeQuotas,
  AttachmentSkip,
  BlobHandle,
  BlobStore,
  DerivativeCacheIdentity,
  VisionPolicy,
} from "./contracts.js";
import { AttachmentError } from "./errors.js";
import { derivativeCacheIdentity } from "./identity.js";
import { normalizeText } from "./text.js";

export interface AttachmentProcessingRequest {
  readonly attachment: AcceptedAttachment;
  readonly accessPolicyHash: string;
  readonly identity: DerivativeCacheIdentity;
  readonly processing: AttachmentProcessingParameters;
  readonly repository: AttachmentRepository;
  readonly blobStore: BlobStore;
  readonly outputStore: AttachmentOutputStore;
  readonly runtime: AttachmentRuntime;
  readonly quotas: AttachmentRuntimeQuotas;
  readonly signal: AbortSignal;
  readonly analysisId?: string;
  readonly vision?: VisionPolicy;
  readonly aiExecution?: AiExecutionGateway;
}

export function selectAttachmentProcessor(
  mimeType: string,
): "text" | "zip" | "vision" | AttachmentSkip {
  if (mimeType === "application/zip") return "zip";
  if (mimeType.startsWith("image/")) return "vision";
  if (
    mimeType === "text/plain" ||
    mimeType === "application/json" ||
    mimeType === "application/xml"
  ) {
    return "text";
  }
  return {
    status: "skipped",
    code: "attachment.unsupportedMime",
    mimeType,
  };
}

function assertCacheIdentityMatchesAttachment(
  request: AttachmentProcessingRequest,
  processor: "text" | "zip" | "vision",
): void {
  const { attachment, identity, processing, vision } = request;
  const visionIdentity = processor === "vision" ? vision : undefined;
  if (
    processing.processor !== processor ||
    (processor === "vision" && visionIdentity === undefined)
  ) {
    throw new AttachmentError(
      "attachment.invalidCacheIdentity",
      "Attachment cache identity does not match current processing.",
      false,
    );
  }

  try {
    const expected = derivativeCacheIdentity({
      workspaceId: attachment.workspaceId,
      accessPolicyHash: request.accessPolicyHash,
      contentSha256: attachment.sha256,
      ...processing,
      ...(visionIdentity === undefined
        ? {}
        : {
            visionPromptVersion: visionIdentity.promptVersion,
            visionBindingVersionId: visionIdentity.bindingVersionId,
          }),
    });
    if (
      identity.workspaceId !== expected.workspaceId ||
      identity.accessPolicyHash !== expected.accessPolicyHash ||
      identity.contentSha256 !== expected.contentSha256 ||
      identity.processor !== expected.processor ||
      identity.processorVersion !== expected.processorVersion ||
      identity.securityPolicyVersion !== expected.securityPolicyVersion ||
      identity.normalizationVersion !== expected.normalizationVersion ||
      identity.visionPromptVersion !== expected.visionPromptVersion ||
      identity.visionBindingVersionId !== expected.visionBindingVersionId ||
      identity.key !== expected.key
    ) {
      throw new AttachmentError(
        "attachment.invalidCacheIdentity",
        "Attachment cache identity does not match current processing.",
        false,
      );
    }
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError(
      "attachment.invalidCacheIdentity",
      "Attachment cache identity does not match current processing.",
      false,
    );
  }
}

function assertAttestation(
  attestation: Awaited<ReturnType<AttachmentRuntime["execute"]>>["attestation"],
): void {
  if (
    !attestation.networkDisabled ||
    !attestation.credentialsUnavailable ||
    !attestation.disposableFilesystem ||
    !attestation.quotasEnforced
  ) {
    throw new AttachmentError(
      "attachment.runtimeAttestation",
      "Attachment runtime did not attest the required isolation.",
      false,
    );
  }
}

async function visionDerivative(
  request: AttachmentProcessingRequest,
): Promise<MeteredAiResult<VisionResult>> {
  if (request.vision === undefined || request.aiExecution === undefined) {
    throw new AttachmentError(
      "attachment.unsupportedMime",
      "Image attachments require configured vision processing.",
      false,
    );
  }
  const url = await request.blobStore.privateUrl(
    request.attachment.blob,
    request.attachment.workspaceId,
  );
  return request.aiExecution.execute<VisionResult>(
    {
      kind: "vision",
      role: "vision",
      bindingVersionId: request.vision.bindingVersionId,
      analysisId: request.analysisId,
      requiredCapabilities: ["vision"],
      maximumInputTokens: request.vision.maximumInputTokens,
      maximumOutputTokens: request.vision.maximumOutputTokens,
      budget: request.vision.budget,
      request: {
        prompt: request.vision.prompt,
        images: [{ url, mediaType: request.attachment.detectedMimeType }],
        maxOutputTokens: request.vision.maximumOutputTokens,
      },
    },
    { workspaceId: request.attachment.workspaceId, signal: request.signal },
  );
}

export async function processAttachment(
  request: AttachmentProcessingRequest,
): Promise<AttachmentDerivative | AttachmentSkip | undefined> {
  const processor = selectAttachmentProcessor(
    request.attachment.detectedMimeType,
  );
  if (typeof processor !== "string") return Object.freeze(processor);
  assertCacheIdentityMatchesAttachment(request, processor);
  const claim = await request.repository.claimDerivative(request.identity);
  if (claim.kind === "completed") return claim.derivative;
  if (claim.kind === "inProgress") return undefined;

  let completed = false;
  let output: BlobHandle | undefined;
  try {
    output = await request.outputStore.createOutput(
      request.attachment.workspaceId,
      request.signal,
    );
    let operationId: string | undefined;
    if (processor === "vision") {
      const result = await visionDerivative(request);
      operationId = result.operationId;
      const normalized = normalizeText(
        new TextEncoder().encode(result.value.text),
        request.quotas.maximumOutputBytes,
      );
      await request.blobStore.writeText(
        output,
        request.attachment.workspaceId,
        normalized.text,
        request.signal,
      );
    } else {
      const result = await request.runtime.execute({
        workspaceId: request.attachment.workspaceId,
        processor,
        input: request.attachment.blob,
        output,
        quotas: request.quotas,
        signal: request.signal,
      });
      assertAttestation(result.attestation);
    }
    const derivative: AttachmentDerivative = Object.freeze({
      id: `attachment-derivative:${request.identity.key}`,
      identity: request.identity,
      status: "completed",
      output,
      mimeType: "text/plain",
      ...(operationId === undefined ? {} : { operationId }),
    });
    await request.repository.completeDerivative({
      claimId: claim.claimId,
      derivative,
    });
    completed = true;
    return derivative;
  } catch (error) {
    await request.repository.failDerivative({
      claimId: claim.claimId,
      code: error instanceof AttachmentError ? error.code : "attachment.failed",
      retryable: error instanceof AttachmentError ? error.retryable : false,
    });
    throw error;
  } finally {
    if (!completed && output !== undefined) {
      await request.runtime.cleanup({
        workspaceId: request.attachment.workspaceId,
        handles: [output],
      });
    }
  }
}
