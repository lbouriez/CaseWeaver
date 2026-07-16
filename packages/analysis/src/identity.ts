import { createHash } from "node:crypto";

import {
  type AnalysisRequestIdentityInput,
  analysisProfileSchema,
  type CapturedAnalysisRequest,
  type CaseSnapshotCapturePort,
  immutableCaseSnapshotSchema,
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
): AnalysisRequestIdentityInput {
  const parsed = analysisProfileSchema.parse(profile);
  return Object.freeze({
    caseSnapshotId: snapshot.id,
    caseRevision: snapshot.revision,
    analysisProfileVersion: parsed.version,
    analysisBindingVersionId: parsed.analysisBindingVersionId,
    retrievalProfileVersion: parsed.retrieval.profileVersion,
    collectionIds: Object.freeze([...parsed.retrieval.collectionIds]),
    promptTemplateVersion: parsed.prompt.template.version,
    outputSchemaVersion: parsed.prompt.schemaVersion,
    ...(parsed.repository.policy === "disabled"
      ? {}
      : {
          repositoryCommit: parsed.repository.pinnedCommit,
          repositoryBindingVersionId: parsed.repository.bindingVersionId,
          repositoryRuntimeVersionId: parsed.repository.runtimeVersionId,
        }),
  });
}

export async function captureAnalysisRequest(
  capture: CaseSnapshotCapturePort,
  input: {
    readonly workspaceId: string;
    readonly caseReference: string;
    readonly profile: unknown;
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
  return Object.freeze({
    snapshot,
    identity: identityInputFor(snapshot, input.profile),
  });
}
