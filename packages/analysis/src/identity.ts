import { createHash } from "node:crypto";

import {
  type AnalysisRequestIdentityInput,
  analysisProfileSchema,
  type CapturedAnalysisRequest,
  type CaseSnapshotCapturePort,
  immutableCaseSnapshotSchema,
  type PreparedAttachmentEvidenceResolver,
  type PreparedAttachmentEvidenceSet,
  preparedAttachmentEvidenceSetSchema,
  type RepositoryRunPin,
  type RepositoryRunPinResolver,
  repositoryRunPinSchema,
} from "./contracts.js";

function canonicalize(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(
    "Canonical analysis identity contains an unsupported value.",
  );
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function createAnalysisRequestIdentity(
  input: AnalysisRequestIdentityInput,
): { readonly identityHash: string; readonly requestHash: string } {
  const canonical = {
    ...input,
    collectionIds: [...new Set(input.collectionIds)].sort(),
  };
  const identityHash = sha256(canonical);
  return Object.freeze({
    identityHash,
    requestHash: sha256({ operation: "analysis.request.v1", identityHash }),
  });
}

export function identityInputFor(
  snapshot: { readonly id: string; readonly revision: string },
  profile: unknown,
  repositoryRun?: RepositoryRunPin,
  preparedAttachments?: PreparedAttachmentEvidenceSet,
): AnalysisRequestIdentityInput {
  const parsed = analysisProfileSchema.parse(profile);
  const resolvedRepositoryRun =
    parsed.repository.policy === "disabled"
      ? undefined
      : validateRepositoryRun(parsed, repositoryRun);
  const prepared =
    parsed.attachments.policy === "disabled"
      ? undefined
      : validatePreparedAttachmentEvidence(preparedAttachments);
  return Object.freeze({
    caseSnapshotId: snapshot.id,
    caseRevision: snapshot.revision,
    analysisProfileVersion: parsed.version,
    analysisBindingVersionId: parsed.analysisBindingVersionId,
    retrievalProfileVersion: parsed.retrieval.profileVersion,
    collectionIds: Object.freeze([...parsed.retrieval.collectionIds]),
    promptTemplateVersion: parsed.prompt.template.version,
    outputSchemaVersion: parsed.prompt.schemaVersion,
    ...(prepared === undefined
      ? {}
      : { preparedAttachmentEvidenceHash: prepared.identityHash }),
    ...(resolvedRepositoryRun === undefined
      ? {}
      : {
          repositoryCommit: resolvedRepositoryRun.pinnedCommit,
          repositoryAgentBindingVersionId:
            resolvedRepositoryRun.repositoryAgentBindingVersionId,
          repositoryVersionId: resolvedRepositoryRun.repositoryVersionId,
          repositoryRuntimePinId: resolvedRepositoryRun.runtimePinId,
          repositoryExecutionPolicyVersionId:
            resolvedRepositoryRun.executionPolicyVersionId,
        }),
  });
}

export async function captureAnalysisRequest(
  capture: CaseSnapshotCapturePort,
  input: {
    readonly workspaceId: string;
    readonly caseReference: string;
    readonly profile: unknown;
    readonly repositories?: RepositoryRunPinResolver;
    readonly attachments?: PreparedAttachmentEvidenceResolver;
    readonly signal: AbortSignal;
  },
): Promise<CapturedAnalysisRequest> {
  const snapshot = immutableCaseSnapshotSchema.parse(
    await capture.capture({
      workspaceId: input.workspaceId,
      caseReference: input.caseReference,
      signal: input.signal,
    }),
  );
  const parsedProfile = analysisProfileSchema.parse(input.profile);
  const repositoryRun =
    parsedProfile.repository.policy === "disabled"
      ? undefined
      : await resolveRepositoryRun(input.repositories, {
          workspaceId: input.workspaceId,
          profile: parsedProfile,
          signal: input.signal,
        });
  const preparedAttachments =
    parsedProfile.attachments.policy === "disabled"
      ? undefined
      : await resolvePreparedAttachments(input.attachments, {
          workspaceId: input.workspaceId,
          snapshot,
          profile: parsedProfile,
          signal: input.signal,
        });
  return Object.freeze({
    snapshot,
    identity: identityInputFor(
      snapshot,
      parsedProfile,
      repositoryRun,
      preparedAttachments,
    ),
    ...(repositoryRun === undefined ? {} : { repositoryRun }),
    ...(preparedAttachments === undefined ? {} : { preparedAttachments }),
  });
}

/** Canonical hash excludes derivative content while retaining all selected outcomes. */
export function createPreparedAttachmentEvidenceIdentity(
  input: Omit<PreparedAttachmentEvidenceSet, "identityHash">,
): string {
  return sha256({
    evidence: [...input.evidence]
      .map((item) => ({
        ...(item.occurrenceIdentity === undefined
          ? {}
          : { occurrenceIdentity: item.occurrenceIdentity }),
        attachmentId: item.attachmentId,
        outcome: item.outcome,
        required: item.required,
        ...(item.derivativeId === undefined
          ? {}
          : { derivativeId: item.derivativeId }),
        ...(item.outputContentHash === undefined
          ? {}
          : { outputContentHash: item.outputContentHash }),
        ...(item.warningCode === undefined
          ? {}
          : { warningCode: item.warningCode }),
      }))
      .sort((left, right) =>
        (left.occurrenceIdentity ?? left.attachmentId).localeCompare(
          right.occurrenceIdentity ?? right.attachmentId,
        ),
      ),
  });
}

export function validatePreparedAttachmentEvidence(
  preparedAttachments: PreparedAttachmentEvidenceSet | undefined,
): PreparedAttachmentEvidenceSet {
  if (preparedAttachments === undefined) {
    throw new TypeError(
      "Attachment preparation is required before creating an enabled analysis request.",
    );
  }
  if (
    preparedAttachments.evidence.some(
      (item) => item.required && item.outcome !== "ready",
    )
  ) {
    throw new TypeError("Required attachment preparation is not ready.");
  }
  let parsed: PreparedAttachmentEvidenceSet;
  try {
    parsed = preparedAttachmentEvidenceSetSchema.parse(preparedAttachments);
  } catch {
    throw new TypeError(
      "Attachment preparation is not immutable and complete.",
    );
  }
  const expected = createPreparedAttachmentEvidenceIdentity({
    evidence: parsed.evidence,
  });
  if (parsed.identityHash.toLowerCase() !== expected) {
    throw new TypeError(
      "Prepared attachment evidence identity does not match its immutable outcomes.",
    );
  }
  return Object.freeze({
    identityHash: parsed.identityHash.toLowerCase(),
    evidence: Object.freeze(
      parsed.evidence.map((item) => Object.freeze({ ...item })),
    ),
  });
}

function validateRepositoryRun(
  profile: ReturnType<typeof analysisProfileSchema.parse>,
  repositoryRun: RepositoryRunPin | undefined,
): RepositoryRunPin {
  if (repositoryRun === undefined) {
    throw new TypeError(
      "An enabled repository stage requires a resolved immutable repository run pin.",
    );
  }
  const pin = repositoryRunPinSchema.parse(repositoryRun);
  if (
    pin.repositoryId !== profile.repository.repositoryId ||
    pin.repositoryVersionId !== profile.repository.repositoryVersionId ||
    pin.executionPolicyId !== profile.repository.executionPolicyId ||
    pin.executionPolicyVersionId !==
      profile.repository.executionPolicyVersionId ||
    pin.repositoryAgentBindingVersionId !==
      profile.repository.repositoryAgentBindingVersionId
  ) {
    throw new TypeError(
      "Resolved repository material does not match the immutable analysis profile.",
    );
  }
  return pin;
}

async function resolveRepositoryRun(
  resolver: RepositoryRunPinResolver | undefined,
  input: Parameters<RepositoryRunPinResolver["resolve"]>[0],
): Promise<RepositoryRunPin> {
  if (resolver === undefined) {
    throw new TypeError(
      "Repository resolution is required before creating an enabled analysis request.",
    );
  }
  return validateRepositoryRun(input.profile, await resolver.resolve(input));
}

async function resolvePreparedAttachments(
  resolver: PreparedAttachmentEvidenceResolver | undefined,
  input: Parameters<PreparedAttachmentEvidenceResolver["resolve"]>[0],
): Promise<PreparedAttachmentEvidenceSet> {
  if (resolver === undefined) {
    throw new TypeError(
      "Attachment preparation is required before creating an enabled analysis request.",
    );
  }
  return validatePreparedAttachmentEvidence(await resolver.resolve(input));
}
