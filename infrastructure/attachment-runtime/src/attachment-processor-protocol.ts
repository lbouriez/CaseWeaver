import type {
  AttachmentRuntimeProcessor,
  AttachmentRuntimeQuotas,
} from "@caseweaver/attachments";

/**
 * The socket intentionally transports job identifiers and limits only. Paths,
 * blob handles, attachment bytes, extracted text, errors, and workspace
 * identities stay on their side of the Unix-socket boundary.
 */
export const attachmentProcessorProtocolVersion =
  "caseweaver.attachment-processor.v1" as const;

export interface AttachmentProcessorExecuteRequest {
  readonly kind: "execute";
  readonly jobId: string;
  readonly processor: AttachmentRuntimeProcessor;
  readonly quotas: AttachmentRuntimeQuotas;
}

export interface AttachmentProcessorCancelRequest {
  readonly kind: "cancel";
  readonly jobId: string;
}

export type AttachmentProcessorRequest =
  | AttachmentProcessorExecuteRequest
  | AttachmentProcessorCancelRequest;

export interface AttachmentProcessorResult {
  readonly kind: "result";
  readonly jobId: string;
  readonly outputByteLength: number;
}

export interface AttachmentProcessorFailure {
  readonly kind: "failure";
  readonly jobId: string;
  readonly code: AttachmentProcessorFailureCode;
}

export type AttachmentProcessorResponse =
  | AttachmentProcessorResult
  | AttachmentProcessorFailure;

/** The processor never reflects parser, filesystem, or socket error details. */
export type AttachmentProcessorFailureCode =
  | "attachment.aborted"
  | "attachment.archiveUnsafe"
  | "attachment.contentTooLarge"
  | "attachment.invalidText"
  | "attachment.outputNotNormalized"
  | "attachment.outputTooLarge"
  | "attachment.runtimeTimeout";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const quotaKeys = [
  "timeoutMs",
  "maximumMemoryBytes",
  "maximumInputBytes",
  "maximumOutputBytes",
  "maximumFiles",
  "maximumExpandedBytes",
  "maximumExtractedFileBytes",
  "maximumArchiveDepth",
  "maximumCompressionRatio",
] as const satisfies readonly (keyof AttachmentRuntimeQuotas)[];

const failureCodes = new Set<AttachmentProcessorFailureCode>([
  "attachment.aborted",
  "attachment.archiveUnsafe",
  "attachment.contentTooLarge",
  "attachment.invalidText",
  "attachment.outputNotNormalized",
  "attachment.outputTooLarge",
  "attachment.runtimeTimeout",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validQuota(
  key: keyof AttachmentRuntimeQuotas,
  value: unknown,
): value is number {
  return key === "maximumArchiveDepth"
    ? nonNegativeInteger(value)
    : positiveInteger(value);
}

export function isAttachmentProcessorJobId(value: string): boolean {
  return uuidPattern.test(value);
}

export function validateAttachmentProcessorQuotas(
  quotas: AttachmentRuntimeQuotas,
): void {
  for (const key of quotaKeys) {
    if (!validQuota(key, quotas[key])) {
      throw new RangeError(
        "Attachment processor quotas must be positive integers, except zero archive depth.",
      );
    }
  }
}

function readQuotas(value: unknown): AttachmentRuntimeQuotas | undefined {
  if (!isRecord(value) || !hasExactKeys(value, quotaKeys)) return undefined;
  const timeoutMs = value.timeoutMs;
  const maximumMemoryBytes = value.maximumMemoryBytes;
  const maximumInputBytes = value.maximumInputBytes;
  const maximumOutputBytes = value.maximumOutputBytes;
  const maximumFiles = value.maximumFiles;
  const maximumExpandedBytes = value.maximumExpandedBytes;
  const maximumExtractedFileBytes = value.maximumExtractedFileBytes;
  const maximumArchiveDepth = value.maximumArchiveDepth;
  const maximumCompressionRatio = value.maximumCompressionRatio;
  if (
    !positiveInteger(timeoutMs) ||
    !positiveInteger(maximumMemoryBytes) ||
    !positiveInteger(maximumInputBytes) ||
    !positiveInteger(maximumOutputBytes) ||
    !positiveInteger(maximumFiles) ||
    !positiveInteger(maximumExpandedBytes) ||
    !positiveInteger(maximumExtractedFileBytes) ||
    !nonNegativeInteger(maximumArchiveDepth) ||
    !positiveInteger(maximumCompressionRatio)
  ) {
    return undefined;
  }
  return Object.freeze({
    timeoutMs,
    maximumMemoryBytes,
    maximumInputBytes,
    maximumOutputBytes,
    maximumFiles,
    maximumExpandedBytes,
    maximumExtractedFileBytes,
    maximumArchiveDepth,
    maximumCompressionRatio,
  });
}

/** Parses one bounded line from the worker without retaining the raw line. */
export function parseAttachmentProcessorRequest(
  line: string,
): AttachmentProcessorRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (
    typeof value.jobId !== "string" ||
    !isAttachmentProcessorJobId(value.jobId)
  ) {
    return undefined;
  }
  if (value.kind === "cancel") {
    if (!hasExactKeys(value, ["kind", "jobId"])) return undefined;
    return Object.freeze({ kind: "cancel", jobId: value.jobId });
  }
  if (
    value.kind !== "execute" ||
    (value.processor !== "text" && value.processor !== "zip")
  ) {
    return undefined;
  }
  if (!hasExactKeys(value, ["kind", "jobId", "processor", "quotas"])) {
    return undefined;
  }
  const quotas = readQuotas(value.quotas);
  if (quotas === undefined) return undefined;
  return Object.freeze({
    kind: "execute",
    jobId: value.jobId,
    processor: value.processor,
    quotas: Object.freeze(quotas),
  });
}

/** Parses one bounded line from the processor without retaining the raw line. */
export function parseAttachmentProcessorResponse(
  line: string,
): AttachmentProcessorResponse | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    typeof value.jobId !== "string" ||
    !isAttachmentProcessorJobId(value.jobId)
  ) {
    return undefined;
  }
  if (value.kind === "result" && nonNegativeInteger(value.outputByteLength)) {
    if (!hasExactKeys(value, ["kind", "jobId", "outputByteLength"])) {
      return undefined;
    }
    return Object.freeze({
      kind: "result",
      jobId: value.jobId,
      outputByteLength: value.outputByteLength,
    });
  }
  if (
    value.kind === "failure" &&
    typeof value.code === "string" &&
    failureCodes.has(value.code as AttachmentProcessorFailureCode)
  ) {
    if (!hasExactKeys(value, ["kind", "jobId", "code"])) return undefined;
    return Object.freeze({
      kind: "failure",
      jobId: value.jobId,
      code: value.code as AttachmentProcessorFailureCode,
    });
  }
  return undefined;
}

export function attachmentProcessorLine(
  value: AttachmentProcessorRequest | AttachmentProcessorResponse,
): string {
  return `${JSON.stringify(value)}\n`;
}

export function attachmentProcessorQuotasWithinCeilings(
  requested: AttachmentRuntimeQuotas,
  ceilings: AttachmentRuntimeQuotas,
): boolean {
  for (const key of quotaKeys) {
    if (requested[key] > ceilings[key]) return false;
  }
  return true;
}
