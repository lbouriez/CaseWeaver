import { createHash } from "node:crypto";

import type { BlobHandle, BlobStore } from "./contracts.js";
import { AttachmentCancelledError, AttachmentError } from "./errors.js";
import { normalizeText } from "./text.js";

export interface VerifiedNormalizedAttachmentOutput {
  readonly contentHash: string;
  readonly byteLength: number;
  readonly text: string;
}

function assertMaximumBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(
      "Attachment normalized output maximum must be a positive safe integer.",
    );
  }
}

function join(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const content = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * Independently seals an already-written derivative before its metadata is
 * committed. It refuses to repair a processor's output after the fact: the
 * stored bytes themselves must be canonical normalized UTF-8.
 */
export async function verifyNormalizedAttachmentOutput(input: {
  readonly blobStore: Pick<BlobStore, "open">;
  readonly output: BlobHandle;
  readonly workspaceId: string;
  readonly maximumBytes: number;
  readonly signal: AbortSignal;
  /** A sandbox-reported count is useful only as an additional integrity check. */
  readonly expectedByteLength?: number;
}): Promise<VerifiedNormalizedAttachmentOutput> {
  assertMaximumBytes(input.maximumBytes);
  if (
    input.expectedByteLength !== undefined &&
    (!Number.isSafeInteger(input.expectedByteLength) ||
      input.expectedByteLength < 0)
  ) {
    throw new AttachmentError(
      "attachment.storageLengthMismatch",
      "Attachment output did not match the isolated runtime result.",
      false,
    );
  }

  const stream = await input.blobStore.open(
    input.output,
    input.workspaceId,
    input.signal,
  );
  const chunks: Uint8Array[] = [];
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const rawChunk of stream) {
    if (input.signal.aborted) throw new AttachmentCancelledError();
    const chunk = rawChunk.slice();
    byteLength += chunk.byteLength;
    if (byteLength > input.maximumBytes) {
      throw new AttachmentError(
        "attachment.outputTooLarge",
        "Attachment output exceeded its configured byte limit.",
        false,
      );
    }
    hash.update(chunk);
    chunks.push(chunk);
  }
  if (input.signal.aborted) throw new AttachmentCancelledError();
  if (
    input.expectedByteLength !== undefined &&
    byteLength !== input.expectedByteLength
  ) {
    throw new AttachmentError(
      "attachment.storageLengthMismatch",
      "Attachment output did not match the isolated runtime result.",
      false,
    );
  }

  const content = join(chunks, byteLength);
  const normalized = normalizeText(content, input.maximumBytes);
  const canonical = new TextEncoder().encode(normalized.text);
  if (normalized.truncated || !sameBytes(content, canonical)) {
    throw new AttachmentError(
      "attachment.outputNotNormalized",
      "Attachment output was not canonical normalized text.",
      false,
    );
  }
  return Object.freeze({
    contentHash: hash.digest("hex"),
    byteLength,
    text: normalized.text,
  });
}
