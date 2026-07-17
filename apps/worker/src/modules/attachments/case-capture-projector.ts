import type { CapturedCaseSnapshot } from "@caseweaver/application";
import {
  AttachmentCancelledError,
  type AttachmentPreparationPolicy,
} from "@caseweaver/attachments";
import {
  type NormalizedCase,
  normalizedCaseSchema,
} from "@caseweaver/connector-sdk";

import type { CaseSnapshotProjector } from "../../feature-handlers/analysis-trigger.js";
import type {
  LiveCaseAttachmentPreparation,
  LiveCaseAttachmentPreparationResult,
} from "./live-attachment-preparation.js";

/** A PBI-020 recipe's exact policy/runtime projection, not a current lookup. */
export interface CaseAttachmentPreparationRuntime {
  readonly policy: AttachmentPreparationPolicy;
}

export interface CaseAttachmentPreparationRuntimeResolver {
  resolve(input: {
    readonly workspaceId: string;
    readonly analysisTriggerVersionId: string;
    readonly signal: AbortSignal;
  }): Promise<CaseAttachmentPreparationRuntime | undefined>;
}

/** Factory keeps worker composition responsible for runtime/AI/storage choices. */
export interface CaseAttachmentPreparationFactory {
  create(
    runtime: CaseAttachmentPreparationRuntime,
  ): Pick<LiveCaseAttachmentPreparation, "prepare">;
}

/**
 * The snapshot boundary that binds live attachment work to a case capture.
 * Legacy trigger versions deliberately retain their existing projector path;
 * a PBI-020 recipe always clears mutable legacy references and pins one stable
 * terminal preparation attempt instead.
 */
export class AttachmentPreparingCaseSnapshotProjector
  implements CaseSnapshotProjector
{
  public constructor(
    private readonly projector: CaseSnapshotProjector,
    private readonly runtimes: CaseAttachmentPreparationRuntimeResolver,
    private readonly preparation: CaseAttachmentPreparationFactory,
  ) {}

  public async project(
    input: Parameters<CaseSnapshotProjector["project"]>[0],
  ): Promise<CapturedCaseSnapshot> {
    const runtime = await resolveRuntime(this.runtimes, input);
    if (runtime === undefined) return this.projector.project(input);
    if (input.signal.aborted) throw cancelled();
    const normalized = normalizedCase(input.normalizedCase);
    if (runtime.policy.mode === "disabled") {
      const snapshot = await this.projector.project({
        ...input,
        normalizedCase: normalized,
      });
      return Object.freeze({ ...snapshot, attachmentReferences: undefined });
    }
    const prepared = await this.preparation.create(runtime).prepare({
      caseCaptureId: input.request.id,
      workspaceId: input.request.workspaceId,
      connectorRegistrationId: input.request.connectorRegistrationId,
      connectorConfigurationVersionId:
        input.request.connectorConfigurationVersionId,
      normalizedCase: normalized,
      policy: runtime.policy,
      signal: input.signal,
    });
    const snapshot = await this.projector.project({
      ...input,
      normalizedCase: normalized,
    });
    return preparedSnapshot(snapshot, prepared);
  }
}

function normalizedCase(value: unknown): NormalizedCase {
  try {
    return normalizedCaseSchema.parse(value);
  } catch {
    throw new AttachmentCaseCaptureUnavailableError();
  }
}

async function resolveRuntime(
  runtimes: CaseAttachmentPreparationRuntimeResolver,
  input: Parameters<CaseSnapshotProjector["project"]>[0],
): Promise<CaseAttachmentPreparationRuntime | undefined> {
  try {
    return await runtimes.resolve({
      workspaceId: input.request.workspaceId,
      analysisTriggerVersionId: input.request.triggerVersionId,
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted || error instanceof AttachmentCancelledError) {
      throw cancelled();
    }
    throw new AttachmentCaseCaptureUnavailableError();
  }
}

function preparedSnapshot(
  snapshot: CapturedCaseSnapshot,
  prepared: LiveCaseAttachmentPreparationResult,
): CapturedCaseSnapshot {
  if (
    prepared.attemptId === undefined ||
    !identifier.test(prepared.attemptId)
  ) {
    throw new AttachmentCaseCaptureUnavailableError();
  }
  return Object.freeze({
    ...snapshot,
    // The new immutable attempt is the only PBI-020 evidence authority. A
    // legacy derivative lookup could otherwise replace optional warnings or a
    // completed terminal result during capture.
    attachmentReferences: undefined,
    attachmentPreparationAttemptId: prepared.attemptId,
  });
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

/** Redacted boundary failure; normalized content and attachment data stay private. */
export class AttachmentCaseCaptureUnavailableError extends Error {
  public readonly code = "analysis.trigger.attachmentPreparationUnavailable";
  public readonly retryable = false;

  public constructor() {
    super("Case attachment preparation is unavailable.");
  }
}

function cancelled(): Error {
  return new AttachmentCancelledError();
}
