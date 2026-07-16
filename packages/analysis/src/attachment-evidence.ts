import { createHash } from "node:crypto";

import {
  type AnalysisEvidence,
  type AnalysisEvidenceStageResult,
  type AnalysisExecution,
  type AttachmentDerivativeEvidenceContentReader,
  type AttachmentEvidencePort,
  type SnapshotAttachmentReference,
  type SnapshotAttachmentReferenceStore,
  analysisEvidenceSchema,
  snapshotAttachmentReferenceSchema,
} from "./contracts.js";

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
    `${execution.workspaceId}:${execution.snapshot.id}:${reference.attachmentId}:${reference.derivativeId}`,
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
    const seenDerivatives = new Set<string>();
    const evidence: AnalysisEvidence[] = [];

    for (const rawReference of references) {
      assertActive(input.signal);
      const reference = snapshotAttachmentReferenceSchema.parse(rawReference);
      if (seenDerivatives.has(reference.derivativeId)) {
        throw new FrozenAttachmentEvidenceError(
          "analysis.attachmentEvidenceIntegrity",
          "A snapshot contains duplicate attachment derivative evidence.",
          false,
        );
      }
      seenDerivatives.add(reference.derivativeId);
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
    return Object.freeze({
      evidence: Object.freeze(evidence),
      operationIds: [],
    });
  }
}
