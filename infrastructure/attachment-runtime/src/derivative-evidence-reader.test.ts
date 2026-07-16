import { createHash } from "node:crypto";

import type {
  AttachmentDerivativeEvidenceRecordStore,
  BlobStore,
} from "@caseweaver/attachments";
import { describe, expect, it } from "vitest";

import {
  AttachmentDerivativeEvidenceReaderError,
  VerifiedAttachmentDerivativeEvidenceReader,
} from "./derivative-evidence-reader.js";

const workspaceId = "workspace-1";
const attachmentId = "attachment-1";
const derivativeId = "derivative-1";
const text = "canonical\ntext";
const content = new TextEncoder().encode(text);
const contentHash = createHash("sha256").update(content).digest("hex");

function records(
  value: Awaited<
    ReturnType<
      AttachmentDerivativeEvidenceRecordStore["findDerivativeEvidenceRecord"]
    >
  >,
): AttachmentDerivativeEvidenceRecordStore {
  return {
    findDerivativeEvidenceRecord: async () => value,
  };
}

function blobs(bytes: Uint8Array): Pick<BlobStore, "open"> {
  return {
    open: async () =>
      (async function* (): AsyncIterable<Uint8Array> {
        yield bytes.slice(0, 4);
        yield bytes.slice(4);
      })(),
  };
}

function record() {
  return {
    workspaceId,
    attachmentId,
    derivativeId,
    output: {
      workspaceId,
      storageBackendId: "storage-test",
      key: "opaque-derivative-key",
    },
    outputContentHash: contentHash,
    outputByteLength: content.byteLength,
  } as const;
}

describe("VerifiedAttachmentDerivativeEvidenceReader", () => {
  it("returns only verified normalized text and its exact hash", async () => {
    const reader = new VerifiedAttachmentDerivativeEvidenceReader(
      records(record()),
      blobs(content),
      100,
    );

    await expect(
      reader.readDerivativeText({
        workspaceId,
        attachmentId,
        derivativeId,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ content: text, contentHash });
  });

  it("fails closed for an unlinked record or mutated object bytes", async () => {
    const missing = new VerifiedAttachmentDerivativeEvidenceReader(
      records(undefined),
      blobs(content),
      100,
    );
    await expect(
      missing.readDerivativeText({
        workspaceId,
        attachmentId,
        derivativeId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(AttachmentDerivativeEvidenceReaderError);

    const tampered = new VerifiedAttachmentDerivativeEvidenceReader(
      records(record()),
      blobs(new TextEncoder().encode("tampered")),
      100,
    );
    await expect(
      tampered.readDerivativeText({
        workspaceId,
        attachmentId,
        derivativeId,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "analysis.attachmentEvidenceUnavailable",
      message: "Captured attachment evidence is not available.",
    });
  });

  it("refuses oversized records before opening storage", async () => {
    let opened = false;
    const reader = new VerifiedAttachmentDerivativeEvidenceReader(
      records({ ...record(), outputByteLength: 101 }),
      {
        open: async () => {
          opened = true;
          return (async function* (): AsyncIterable<Uint8Array> {
            yield content;
          })();
        },
      },
      100,
    );

    await expect(
      reader.readDerivativeText({
        workspaceId,
        attachmentId,
        derivativeId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(AttachmentDerivativeEvidenceReaderError);
    expect(opened).toBe(false);
  });
});
