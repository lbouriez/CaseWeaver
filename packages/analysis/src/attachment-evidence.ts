import { createHash } from "node:crypto";

import {
  type AnalysisEvidence,
  type AnalysisEvidenceStageResult,
  type AnalysisExecution,
  type AttachmentDerivativeEvidenceContentReader,
  type AttachmentEvidencePort,
  analysisEvidenceSchema,
  type PreparedAttachmentEvidenceSet,
  type SnapshotAttachmentReference,
  type SnapshotAttachmentReferenceStore,
  snapshotAttachmentReferenceSchema,
} from "./contracts.js";
import { validatePreparedAttachmentEvidence } from "./identity.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new FrozenAttachmentEvidenceError(
      "analysis.cancelled",
      "Analysis attachment evidence resolution was cancelled.",
      false,
    );
  }
}

function retryable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    error.retryable === true
  );
}

/** A stable, redacted failure emitted by immutable attachment evidence ports. */
export class FrozenAttachmentEvidenceError extends Error {
  public constructor(
    public readonly code:
      | "analysis.cancelled"
      | "analysis.attachmentEvidenceUnavailable"
      | "analysis.attachmentEvidenceIntegrity"
      | "analysis.attachmentEvidenceTooLarge",
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "FrozenAttachmentEvidenceError";
  }
}

export interface FrozenSnapshotAttachmentEvidenceDependencies {
  readonly references: SnapshotAttachmentReferenceStore;
  readonly content: AttachmentDerivativeEvidenceContentReader;
  /**
   * A deployment safety ceiling. The persisted derivative must already be
   * bounded by its immutable processing policy; oversized evidence is rejected
   * instead of silently truncating and invalidating its content hash.
   */
  readonly maximumEvidenceCharacters: number;
}

function validateMaximum(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new RangeError(
      "Frozen attachment evidence maximum characters must be a positive safe integer.",
    );
  }
}

function evidenceId(
  execution: AnalysisExecution,
  reference: SnapshotAttachmentReference,
): string {
  return `attachment-${sha256(
    `${execution.workspaceId}:${execution.snapshot.id}:${reference.occurrenceIdentity ?? reference.attachmentId}:${reference.derivativeId}`,
  )}`;
}

/**
 * Resolves attachment evidence exclusively from immutable snapshot references.
 * It is production-capable once outer composition supplies the Postgres
 * reference store and the PBI-008 server-private derivative reader.
 */
export class FrozenSnapshotAttachmentEvidencePort
  implements AttachmentEvidencePort
{
  public constructor(
    private readonly dependencies: FrozenSnapshotAttachmentEvidenceDependencies,
  ) {
    validateMaximum(dependencies.maximumEvidenceCharacters);
  }

  public async resolve(input: {
    readonly execution: AnalysisExecution;
    readonly signal: AbortSignal;
  }): Promise<AnalysisEvidenceStageResult> {
    assertActive(input.signal);
    let prepared: PreparedAttachmentEvidenceSet;
    try {
      prepared = validatePreparedAttachmentEvidence(
        input.execution.preparedAttachments,
      );
    } catch {
      throw new FrozenAttachmentEvidenceError(
        "analysis.attachmentEvidenceIntegrity",
        "Captured attachment preparation is not immutable and complete.",
        false,
      );
    }
    let references: readonly SnapshotAttachmentReference[];
    try {
      references =
        await this.dependencies.references.listSnapshotAttachmentReferences({
          workspaceId: input.execution.workspaceId,
          caseSnapshotId: input.execution.snapshot.id,
          signal: input.signal,
        });
    } catch (error) {
      if (error instanceof FrozenAttachmentEvidenceError) throw error;
      assertActive(input.signal);
      throw new FrozenAttachmentEvidenceError(
        "analysis.attachmentEvidenceUnavailable",
        "Captured attachment evidence is not available.",
        retryable(error),
      );
    }
    const preparedByAttachment = new Map(
      prepared.evidence
        .filter((item) => item.outcome === "ready")
        .map((item) => [item.occurrenceIdentity ?? item.attachmentId, item]),
    );
    const referencesByAttachment = new Map<
      string,
      SnapshotAttachmentReference
    >();
    const evidence: AnalysisEvidence[] = [];

    for (const rawReference of references) {
      assertActive(input.signal);
      const reference = snapshotAttachmentReferenceSchema.parse(rawReference);
      const occurrenceIdentity =
        reference.occurrenceIdentity ?? reference.attachmentId;
      if (referencesByAttachment.has(occurrenceIdentity)) {
        throw new FrozenAttachmentEvidenceError(
          "analysis.attachmentEvidenceIntegrity",
          "A snapshot contains duplicate attachment occurrence evidence.",
          false,
        );
      }
      referencesByAttachment.set(occurrenceIdentity, reference);
      const preparedReference = preparedByAttachment.get(occurrenceIdentity);
      if (
        preparedReference === undefined ||
        preparedReference.derivativeId !== reference.derivativeId ||
        preparedReference.outputContentHash?.toLowerCase() !==
          reference.outputContentHash.toLowerCase()
      ) {
        throw new FrozenAttachmentEvidenceError(
          "analysis.attachmentEvidenceIntegrity",
          "Snapshot attachment evidence does not match its prepared immutable outcome.",
          false,
        );
      }
      let resolved: { readonly content: string; readonly contentHash: string };
      try {
        resolved = await this.dependencies.content.readDerivativeText({
          workspaceId: input.execution.workspaceId,
          attachmentId: reference.attachmentId,
          derivativeId: reference.derivativeId,
          signal: input.signal,
        });
      } catch (error) {
        if (error instanceof FrozenAttachmentEvidenceError) throw error;
        assertActive(input.signal);
        throw new FrozenAttachmentEvidenceError(
          "analysis.attachmentEvidenceUnavailable",
          "Captured attachment evidence is not available.",
          retryable(error),
        );
      }
      assertActive(input.signal);
      const actualHash = sha256(resolved.content);
      if (
        resolved.contentHash.toLowerCase() !== actualHash ||
        reference.outputContentHash.toLowerCase() !== actualHash
      ) {
        throw new FrozenAttachmentEvidenceError(
          "analysis.attachmentEvidenceIntegrity",
          "Captured attachment evidence no longer matches its immutable content hash.",
          false,
        );
      }
      if (
        resolved.content.length > this.dependencies.maximumEvidenceCharacters
      ) {
        throw new FrozenAttachmentEvidenceError(
          "analysis.attachmentEvidenceTooLarge",
          "Captured attachment evidence exceeds its configured prompt boundary.",
          false,
        );
      }
      try {
        evidence.push(
          analysisEvidenceSchema.parse({
            id: evidenceId(input.execution, reference),
            kind: "attachment",
            content: resolved.content,
            contentHash: actualHash,
            attachmentId: reference.attachmentId,
            derivativeId: reference.derivativeId,
            processorVersion: reference.processorVersion,
          }),
        );
      } catch {
        throw new FrozenAttachmentEvidenceError(
          "analysis.attachmentEvidenceIntegrity",
          "Captured attachment evidence is not valid prompt input.",
          false,
        );
      }
    }
    if (referencesByAttachment.size !== preparedByAttachment.size) {
      throw new FrozenAttachmentEvidenceError(
        "analysis.attachmentEvidenceIntegrity",
        "Prepared attachment evidence is missing from the captured snapshot.",
        false,
      );
    }
    return Object.freeze({
      evidence: Object.freeze(evidence),
      operationIds: [],
    });
  }
}
