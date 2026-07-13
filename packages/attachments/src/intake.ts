import { createHash } from "node:crypto";

import type {
  AcceptedAttachment,
  AttachmentIntakeRequest,
} from "./contracts.js";
import {
  AttachmentCancelledError,
  AttachmentError,
  throwIfAttachmentAborted,
} from "./errors.js";
import {
  detectMimeType,
  mimeTypesCompatible,
  normalizedMimeType,
} from "./mime.js";

const MIME_SAMPLE_BYTES = 16 * 1024;

export async function intakeAttachment(
  request: AttachmentIntakeRequest,
): Promise<AcceptedAttachment> {
  throwIfAttachmentAborted(request.signal);
  const opened = await request.source.openAttachment({
    reference: request.reference,
    signal: request.signal,
  });
  const declaredMimeType =
    request.declaredMimeType === undefined
      ? opened.mediaType
      : request.declaredMimeType;
  if (
    opened.contentLength !== undefined &&
    opened.contentLength > request.policy.maximumAttachmentBytes
  ) {
    throw new AttachmentError(
      "attachment.contentTooLarge",
      "Attachment exceeds the configured byte limit.",
      false,
    );
  }

  const staging = await request.blobStore.beginStaging({
    workspaceId: request.workspaceId,
    maximumBytes: request.policy.maximumAttachmentBytes,
    signal: request.signal,
  });
  let committed = false;
  try {
    let byteLength = 0;
    const sample: Uint8Array[] = [];
    let sampleLength = 0;
    const hash = createHash("sha256");
    for await (const chunk of opened.content) {
      throwIfAttachmentAborted(request.signal);
      byteLength += chunk.byteLength;
      if (byteLength > request.policy.maximumAttachmentBytes) {
        throw new AttachmentError(
          "attachment.contentTooLarge",
          "Attachment exceeds the configured byte limit.",
          false,
        );
      }
      hash.update(chunk);
      if (sampleLength < MIME_SAMPLE_BYTES) {
        const remaining = MIME_SAMPLE_BYTES - sampleLength;
        const part = chunk.subarray(0, remaining);
        sample.push(part);
        sampleLength += part.byteLength;
      }
      await request.blobStore.append(staging, chunk, request.signal);
    }
    throwIfAttachmentAborted(request.signal);
    const sampled = new Uint8Array(sampleLength);
    let offset = 0;
    for (const chunk of sample) {
      sampled.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const detectedMimeType = detectMimeType(sampled);
    if (!mimeTypesCompatible(declaredMimeType, detectedMimeType)) {
      throw new AttachmentError(
        "attachment.mimeMismatch",
        "Attachment declared MIME type does not match its content.",
        false,
      );
    }
    if (!request.policy.allowedMimeTypes.has(detectedMimeType)) {
      throw new AttachmentError(
        "attachment.unsupportedMime",
        "Attachment content type is not allowed.",
        false,
      );
    }
    const sha256 = hash.digest("hex");
    const blob = await request.blobStore.commit(
      staging,
      { sha256, byteLength },
      request.signal,
    );
    committed = true;
    return Object.freeze({
      workspaceId: request.workspaceId,
      sourceReference: request.reference,
      blob,
      byteLength,
      sha256,
      detectedMimeType,
      ...(declaredMimeType === undefined
        ? {}
        : { declaredMimeType: normalizedMimeType(declaredMimeType) }),
    });
  } catch (error) {
    if (
      request.signal.aborted &&
      !(error instanceof AttachmentCancelledError)
    ) {
      throw new AttachmentCancelledError();
    }
    throw error;
  } finally {
    if (!committed) await request.blobStore.abort(staging);
  }
}
