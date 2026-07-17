import { createHash } from "node:crypto";

import type { AiExecutionGateway } from "@caseweaver/ai-execution";
import type { AttachmentSource } from "@caseweaver/connector-sdk";

import type {
  AttachmentIntakePolicy,
  AttachmentOccurrenceDescriptor,
  AttachmentOccurrencePersistence,
  AttachmentOutputStore,
  AttachmentPreparationAttemptStore,
  AttachmentPreparationAttemptReference,
  AttachmentPreparationSubject,
  AttachmentProcessingParameters,
  AttachmentRepository,
  AttachmentRuntime,
  AttachmentRuntimeQuotas,
  BlobStore,
  ServerPrivateAttachmentOccurrence,
  ServerPrivateAttachmentOccurrenceEvidence,
  VisionPolicy,
} from "./contracts.js";
import {
  AttachmentCancelledError,
  AttachmentError,
  throwIfAttachmentAborted,
} from "./errors.js";
import { derivativeCacheIdentity } from "./identity.js";
import { intakeAttachment } from "./intake.js";
import {
  type AttachmentPreparationPolicy,
  type AttachmentPreparationResult,
  type AttachmentPreparationWarning,
  createAttachmentPreparationResult,
  type PreparedAttachmentDerivative,
} from "./preparation.js";
import { processAttachment, selectAttachmentProcessor } from "./processing.js";
import { verifyNormalizedAttachmentOutput } from "./verified-output.js";

type AttachmentProcessor = "text" | "zip" | "vision";

export interface AttachmentOccurrencePreparationProcessingPolicy {
  readonly intake: AttachmentIntakePolicy;
  /** Every enabled processor has an independently versioned cache identity. */
  readonly processors: Readonly<
    Record<AttachmentProcessor, AttachmentProcessingParameters>
  >;
  readonly quotas: AttachmentRuntimeQuotas;
  /** Required only when an occurrence is detected as an image. */
  readonly vision?: VisionPolicy;
}

export interface AttachmentOccurrencePreparationDependencies {
  readonly blobStore: BlobStore;
  readonly outputStore: AttachmentOutputStore;
  readonly repository: AttachmentRepository;
  readonly runtime: AttachmentRuntime;
  readonly aiExecution?: AiExecutionGateway;
  /** Records accepted blobs and derivative provenance for durable attempts. */
  readonly occurrencePersistence?: AttachmentOccurrencePersistence;
  /**
   * Optional until the owning persistence module supplies the stable-subject
   * schema. When present, this is the sole owner of durable attempt fencing.
   */
  readonly attempts?: AttachmentPreparationAttemptStore;
}

export interface PrepareAttachmentOccurrencesRequest {
  readonly subject: AttachmentPreparationSubject;
  readonly policy: AttachmentPreparationPolicy;
  readonly occurrences: readonly ServerPrivateAttachmentOccurrence[];
  readonly processing: AttachmentOccurrencePreparationProcessingPolicy;
  readonly signal: AbortSignal;
  /** Used only for metered attribution by the existing AI-execution gateway. */
  readonly analysisId?: string;
}

/**
 * Server-side orchestration output. It deliberately contains only the stable
 * subject, plan identity, safe result and private derived text; connector
 * references and encrypted reopening locators do not cross this boundary.
 */
export interface AttachmentOccurrencePreparationExecution {
  readonly subject: AttachmentPreparationSubject;
  readonly planIdentity: string;
  readonly result: AttachmentPreparationResult;
  /** Present only when a durable attempt store owns this preparation. */
  readonly attempt?: AttachmentPreparationAttemptReference;
}

function requireIdentifier(name: string, value: string): string {
  if (value.length === 0 || value.length > 1_024) {
    throw new RangeError(
      `${name} must be a non-empty value up to 1024 characters.`,
    );
  }
  return value;
}

function normalizedOccurrence(
  occurrence: AttachmentOccurrenceDescriptor,
): AttachmentOccurrenceDescriptor {
  if (!Number.isSafeInteger(occurrence.ordinal) || occurrence.ordinal < 0) {
    throw new RangeError(
      "Attachment occurrence ordinal must be a non-negative integer.",
    );
  }
  const sourceOrdinal = occurrence.sourceOrdinal ?? occurrence.ordinal;
  if (!Number.isSafeInteger(sourceOrdinal) || sourceOrdinal < 0) {
    throw new RangeError(
      "Attachment occurrence source ordinal must be a non-negative integer.",
    );
  }
  return Object.freeze({
    identity: requireIdentifier(
      "Attachment occurrence identity",
      occurrence.identity,
    ),
    ...(occurrence.ownerIdentity === undefined
      ? {}
      : {
          ownerIdentity: requireIdentifier(
            "Attachment occurrence owner identity",
            occurrence.ownerIdentity,
          ),
        }),
    ...(occurrence.sourceOrdinal === undefined ? {} : { sourceOrdinal }),
    ordinal: occurrence.ordinal,
    attachmentId: requireIdentifier(
      "Attachment occurrence attachment",
      occurrence.attachmentId,
    ),
    relation: requireIdentifier(
      "Attachment occurrence relation",
      occurrence.relation,
    ),
    required: requireBoolean(
      "Attachment occurrence required",
      occurrence.required,
    ),
  });
}

function normalizedOccurrences(
  occurrences: readonly ServerPrivateAttachmentOccurrence[],
): readonly AttachmentOccurrenceDescriptor[] {
  const identities = new Set<string>();
  const ordinals = new Set<number>();
  const normalized = occurrences.map(({ occurrence }) => {
    const value = normalizedOccurrence(occurrence);
    if (identities.has(value.identity)) {
      throw new RangeError(
        "Attachment occurrence identities must be unique per preparation.",
      );
    }
    if (ordinals.has(value.ordinal)) {
      throw new RangeError(
        "Attachment occurrence ordinals must be unique per preparation.",
      );
    }
    identities.add(value.identity);
    ordinals.add(value.ordinal);
    return value;
  });
  return Object.freeze(
    [...normalized].sort((left, right) =>
      left.identity.localeCompare(right.identity),
    ),
  );
}

function normalizedSubject(
  subject: AttachmentPreparationSubject,
): AttachmentPreparationSubject {
  if (subject.kind !== "sourceDocument" && subject.kind !== "caseCapture") {
    throw new RangeError("Attachment preparation subject kind is invalid.");
  }
  return Object.freeze({
    workspaceId: requireIdentifier(
      "Attachment preparation workspace",
      subject.workspaceId,
    ),
    kind: subject.kind,
    id: requireIdentifier("Attachment preparation subject", subject.id),
  });
}

function normalizedPolicy(
  policy: AttachmentPreparationPolicy,
): AttachmentPreparationPolicy {
  if (
    policy.mode !== "disabled" &&
    policy.mode !== "optional" &&
    policy.mode !== "required"
  ) {
    throw new RangeError("Attachment preparation policy mode is invalid.");
  }
  return Object.freeze({
    mode: policy.mode,
    policyVersion: requireIdentifier(
      "Attachment preparation policy version",
      policy.policyVersion,
    ),
    accessPolicyHash: requireIdentifier(
      "Attachment preparation access policy hash",
      policy.accessPolicyHash,
    ),
  });
}

function requireBoolean(name: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new RangeError(`${name} must be a boolean.`);
  }
  return value;
}

/**
 * Derives the immutable preparation-plan identity without incorporating
 * connector references, encrypted locators, blob keys, URLs, or source paths.
 */
export function attachmentOccurrencePreparationPlanIdentity(input: {
  readonly subject: AttachmentPreparationSubject;
  readonly policy: AttachmentPreparationPolicy;
  readonly occurrences: readonly AttachmentOccurrenceDescriptor[];
}): string {
  const subject = normalizedSubject(input.subject);
  const policy = normalizedPolicy(input.policy);
  const occurrences = [...input.occurrences]
    .map(normalizedOccurrence)
    .sort((left, right) => left.identity.localeCompare(right.identity));
  const unique = new Set(occurrences.map((occurrence) => occurrence.identity));
  if (unique.size !== occurrences.length) {
    throw new RangeError(
      "Attachment occurrence identities must be unique per preparation.",
    );
  }
  const uniqueOrdinals = new Set(
    occurrences.map((occurrence) => occurrence.ordinal),
  );
  if (uniqueOrdinals.size !== occurrences.length) {
    throw new RangeError(
      "Attachment occurrence ordinals must be unique per preparation.",
    );
  }
  const canonical = {
    subject,
    policy,
    occurrences,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function sourceForOccurrence(
  occurrence: ServerPrivateAttachmentOccurrence,
): AttachmentSource {
  if (occurrence.openIdentity === undefined) return occurrence.source;
  return Object.freeze({
    openAttachment: (
      request: Parameters<AttachmentSource["openAttachment"]>[0],
    ) =>
      occurrence.source.openAttachment({
        ...request,
        identity: occurrence.openIdentity,
      }),
  });
}

function assertProcessorPolicy(
  processor: AttachmentProcessor,
  parameters: AttachmentProcessingParameters,
): void {
  if (parameters.processor !== processor) {
    throw new RangeError(
      `Attachment ${processor} processor policy must declare processor "${processor}".`,
    );
  }
}

function warning(
  occurrenceIdentity: string,
  code: string,
  retryable: boolean,
): AttachmentPreparationWarning {
  return Object.freeze({
    kind: "attachmentPreparationWarning",
    code,
    retryable,
    occurrenceIdentity,
  });
}

function failureWarning(
  occurrenceIdentity: string,
  error: unknown,
): AttachmentPreparationWarning {
  return warning(
    occurrenceIdentity,
    "attachment.processing-failed",
    error instanceof AttachmentError ? error.retryable : true,
  );
}

function isCancelled(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || error instanceof AttachmentCancelledError;
}

async function readPreparedDerivative(input: {
  readonly occurrence: AttachmentOccurrenceDescriptor;
  readonly derivative: Awaited<ReturnType<typeof processAttachment>>;
  readonly dependencies: AttachmentOccurrencePreparationDependencies;
  readonly workspaceId: string;
  readonly maximumOutputBytes: number;
  readonly signal: AbortSignal;
}): Promise<
  | Readonly<{
      readonly prepared: PreparedAttachmentDerivative;
      readonly evidence: ServerPrivateAttachmentOccurrenceEvidence;
    }>
  | undefined
> {
  const derivative = input.derivative;
  if (derivative === undefined || derivative.status === "skipped")
    return undefined;
  const verified = await verifyNormalizedAttachmentOutput({
    blobStore: input.dependencies.blobStore,
    output: derivative.output,
    workspaceId: input.workspaceId,
    maximumBytes: input.maximumOutputBytes,
    expectedByteLength: derivative.outputByteLength,
    signal: input.signal,
  });
  if (verified.contentHash !== derivative.outputContentHash) {
    throw new AttachmentError(
      "attachment.storageLengthMismatch",
      "Attachment derivative did not match its committed content hash.",
      false,
    );
  }
  return Object.freeze({
    prepared: Object.freeze({
      occurrenceIdentity: input.occurrence.identity,
      derivativeIdentity: derivative.identity.key,
      derivativeContentHash: derivative.outputContentHash,
      searchableText: verified.text,
    }),
    evidence: Object.freeze({
      occurrence: input.occurrence,
      derivative,
    }),
  });
}

async function prepareClaimedOccurrences(
  request: PrepareAttachmentOccurrencesRequest,
  dependencies: AttachmentOccurrencePreparationDependencies,
): Promise<{
  readonly result: AttachmentPreparationResult;
  readonly evidence: readonly ServerPrivateAttachmentOccurrenceEvidence[];
}> {
  if (request.policy.mode === "disabled") {
    return Object.freeze({
      result: createAttachmentPreparationResult({ policy: request.policy }),
      evidence: Object.freeze([]),
    });
  }

  const derivatives: PreparedAttachmentDerivative[] = [];
  const evidence: ServerPrivateAttachmentOccurrenceEvidence[] = [];
  const warnings: AttachmentPreparationWarning[] = [];

  for (const occurrence of request.occurrences) {
    throwIfAttachmentAborted(request.signal);
    const descriptor = normalizedOccurrence(occurrence.occurrence);
    try {
      const attachment = await intakeAttachment({
        workspaceId: request.subject.workspaceId,
        source: sourceForOccurrence(occurrence),
        reference: occurrence.reference,
        blobStore: dependencies.blobStore,
        ...(occurrence.declaredMimeType === undefined
          ? {}
          : { declaredMimeType: occurrence.declaredMimeType }),
        policy: request.processing.intake,
        signal: request.signal,
      });
      await dependencies.occurrencePersistence?.recordAccepted({
        subject: request.subject,
        occurrence: descriptor,
        attachment,
        signal: request.signal,
      });
      const processor = selectAttachmentProcessor(attachment.detectedMimeType);
      if (typeof processor !== "string") {
        warnings.push(
          warning(descriptor.identity, "attachment.unsupported-mime", false),
        );
        continue;
      }
      const vision = request.processing.vision;
      if (processor === "vision" && vision === undefined) {
        warnings.push(
          warning(descriptor.identity, "attachment.processing-failed", false),
        );
        continue;
      }
      const parameters = request.processing.processors[processor];
      assertProcessorPolicy(processor, parameters);
      const identity = derivativeCacheIdentity({
        workspaceId: attachment.workspaceId,
        accessPolicyHash: request.policy.accessPolicyHash,
        contentSha256: attachment.sha256,
        ...parameters,
        ...(processor === "vision" && vision !== undefined
          ? {
              visionPromptVersion: vision.promptVersion,
              visionBindingVersionId: vision.bindingVersionId,
            }
          : {}),
      });
      const processed = await processAttachment({
        attachment,
        accessPolicyHash: request.policy.accessPolicyHash,
        identity,
        processing: parameters,
        repository: dependencies.repository,
        blobStore: dependencies.blobStore,
        outputStore: dependencies.outputStore,
        runtime: dependencies.runtime,
        quotas: request.processing.quotas,
        signal: request.signal,
        ...(request.analysisId === undefined
          ? {}
          : { analysisId: request.analysisId }),
        ...(request.processing.vision === undefined
          ? {}
          : { vision: request.processing.vision }),
        ...(dependencies.aiExecution === undefined
          ? {}
          : { aiExecution: dependencies.aiExecution }),
      });
      if (processed === undefined) {
        warnings.push(
          warning(
            descriptor.identity,
            "attachment.processing-in-progress",
            true,
          ),
        );
        continue;
      }
      if (processed.status === "skipped") {
        warnings.push(
          warning(descriptor.identity, "attachment.unsupported-mime", false),
        );
        continue;
      }
      await dependencies.occurrencePersistence?.recordDerivativeSource({
        subject: request.subject,
        occurrence: descriptor,
        derivative: processed,
        signal: request.signal,
      });
      const prepared = await readPreparedDerivative({
        occurrence: descriptor,
        derivative: processed,
        dependencies,
        workspaceId: request.subject.workspaceId,
        maximumOutputBytes: request.processing.quotas.maximumOutputBytes,
        signal: request.signal,
      });
      if (prepared !== undefined) {
        derivatives.push(prepared.prepared);
        evidence.push(prepared.evidence);
      }
    } catch (error) {
      if (isCancelled(error, request.signal)) {
        throw new AttachmentCancelledError();
      }
      warnings.push(failureWarning(descriptor.identity, error));
    }
  }

  return Object.freeze({
    result: createAttachmentPreparationResult({
      policy: request.policy,
      derivatives,
      warnings,
    }),
    evidence: Object.freeze(
      [...evidence].sort((left, right) =>
        left.occurrence.identity.localeCompare(right.occurrence.identity),
      ),
    ),
  });
}

/**
 * Prepares each immutable attachment occurrence through the existing streaming
 * intake, cache-aware processor, isolated runtime and metered AI-execution
 * boundaries. The coordinator contains no connector, provider, storage, or
 * persistence implementation branch.
 */
export async function prepareAttachmentOccurrences(
  request: PrepareAttachmentOccurrencesRequest,
  dependencies: AttachmentOccurrencePreparationDependencies,
): Promise<AttachmentOccurrencePreparationExecution> {
  throwIfAttachmentAborted(request.signal);
  const subject = normalizedSubject(request.subject);
  const policy = normalizedPolicy(request.policy);
  const occurrenceDescriptors = normalizedOccurrences(request.occurrences);
  const planIdentity = attachmentOccurrencePreparationPlanIdentity({
    subject,
    policy,
    occurrences: occurrenceDescriptors,
  });

  const claim =
    dependencies.attempts === undefined
      ? undefined
      : await dependencies.attempts.claim({
          subject,
          policy,
          planIdentity,
          occurrences: occurrenceDescriptors,
          signal: request.signal,
        });
  if (claim?.kind === "completed") {
    return Object.freeze({
      subject,
      planIdentity,
      result: claim.result,
      attempt: claim.attempt,
    });
  }

  const prepared = await prepareClaimedOccurrences(
    { ...request, subject, policy },
    dependencies,
  );
  if (claim?.kind === "claimed") {
    await dependencies.attempts?.finalize({
      attempt: claim.attempt,
      result: prepared.result,
      evidence: prepared.evidence,
      signal: request.signal,
    });
  }
  return Object.freeze({
    subject,
    planIdentity,
    result: prepared.result,
    ...(claim?.kind === "claimed"
      ? {
          attempt: Object.freeze({
            id: claim.attempt.id,
            planIdentity: claim.attempt.planIdentity,
          }),
        }
      : {}),
  });
}
