import type { AttachmentDerivativeEvidenceContentReader } from "@caseweaver/analysis";
import {
  AttachmentCancelledError,
  type AttachmentDerivativeEvidenceRecordStore,
  type BlobStore,
  verifyNormalizedAttachmentOutput,
} from "@caseweaver/attachments";

/**
 * Redacted outer-adapter failure. It intentionally carries no object location,
 * storage backend, source reference, or derivative content.
 */
export class AttachmentDerivativeEvidenceReaderError extends Error {
  public readonly code = "analysis.attachmentEvidenceUnavailable";
  public readonly retryable = false;

  public constructor() {
    super("Captured attachment evidence is not available.");
    this.name = "AttachmentDerivativeEvidenceReaderError";
  }
}

function assertMaximumDerivativeBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(
      "Attachment evidence maximum derivative bytes must be a positive safe integer.",
    );
  }
}

/**
 * Server-private adapter that rechecks the persisted identity against actual
 * object bytes before analysis sees normalized derivative text. It deliberately
 * has no URL, download, or arbitrary-object read API.
 */
export class VerifiedAttachmentDerivativeEvidenceReader
  implements AttachmentDerivativeEvidenceContentReader
{
  public constructor(
    private readonly records: AttachmentDerivativeEvidenceRecordStore,
    private readonly blobs: Pick<BlobStore, "open">,
    private readonly maximumDerivativeBytes: number,
  ) {
    assertMaximumDerivativeBytes(maximumDerivativeBytes);
  }

  public async readDerivativeText(input: {
    readonly workspaceId: string;
    readonly attachmentId: string;
    readonly derivativeId: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly content: string; readonly contentHash: string }> {
    if (input.signal.aborted) throw new AttachmentCancelledError();
    let record: Awaited<
      ReturnType<
        AttachmentDerivativeEvidenceRecordStore["findDerivativeEvidenceRecord"]
      >
    >;
    try {
      record = await this.records.findDerivativeEvidenceRecord(input);
    } catch (_error) {
      if (input.signal.aborted) throw new AttachmentCancelledError();
      throw new AttachmentDerivativeEvidenceReaderError();
    }
    if (
      record === undefined ||
      record.workspaceId !== input.workspaceId ||
      record.attachmentId !== input.attachmentId ||
      record.derivativeId !== input.derivativeId ||
      record.output.workspaceId !== input.workspaceId ||
      record.outputByteLength > this.maximumDerivativeBytes
    ) {
      throw new AttachmentDerivativeEvidenceReaderError();
    }

    try {
      const verified = await verifyNormalizedAttachmentOutput({
        blobStore: this.blobs,
        output: record.output,
        workspaceId: input.workspaceId,
        maximumBytes: this.maximumDerivativeBytes,
        expectedByteLength: record.outputByteLength,
        signal: input.signal,
      });
      if (verified.contentHash !== record.outputContentHash) {
        throw new AttachmentDerivativeEvidenceReaderError();
      }
      return Object.freeze({
        content: verified.text,
        contentHash: verified.contentHash,
      });
    } catch (error) {
      if (error instanceof AttachmentDerivativeEvidenceReaderError) throw error;
      if (input.signal.aborted) throw new AttachmentCancelledError();
      throw new AttachmentDerivativeEvidenceReaderError();
    }
  }
}
