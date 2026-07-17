import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  parseAttachmentProcessorRequest,
  parseAttachmentProcessorResponse,
} from "./attachment-processor-protocol.js";

const quotas = {
  timeoutMs: 1_000,
  maximumMemoryBytes: 1_024 * 1_024,
  maximumInputBytes: 1_024,
  maximumOutputBytes: 1_024,
  maximumFiles: 5,
  maximumExpandedBytes: 1_024,
  maximumExtractedFileBytes: 512,
  maximumArchiveDepth: 3,
  maximumCompressionRatio: 10,
} as const;

describe("attachment processor protocol", () => {
  it("accepts only the fixed, path-free execute and result message shapes", () => {
    const jobId = randomUUID();

    expect(
      parseAttachmentProcessorRequest(
        JSON.stringify({ kind: "execute", jobId, processor: "text", quotas }),
      ),
    ).toEqual({ kind: "execute", jobId, processor: "text", quotas });
    expect(
      parseAttachmentProcessorResponse(
        JSON.stringify({ kind: "result", jobId, outputByteLength: 12 }),
      ),
    ).toEqual({ kind: "result", jobId, outputByteLength: 12 });
  });

  it("rejects locator, path, text, and non-positive quota fields", () => {
    const jobId = randomUUID();
    expect(
      parseAttachmentProcessorRequest(
        JSON.stringify({
          kind: "execute",
          jobId,
          processor: "zip",
          quotas,
          path: "/private/job/input.bin",
        }),
      ),
    ).toBeUndefined();
    expect(
      parseAttachmentProcessorRequest(
        JSON.stringify({
          kind: "execute",
          jobId,
          processor: "zip",
          quotas: { ...quotas, maximumInputBytes: 0 },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseAttachmentProcessorResponse(
        JSON.stringify({
          kind: "failure",
          jobId,
          code: "attachment.archiveUnsafe",
          error: "untrusted attachment detail",
        }),
      ),
    ).toBeUndefined();
    expect(
      parseAttachmentProcessorResponse(
        JSON.stringify({
          kind: "result",
          jobId,
          outputByteLength: 12,
          output: {
            workspaceId: "workspace-private",
            storageBackendId: "server-only",
            key: "opaque-output-handle",
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("preserves zero as the intentional no-nesting archive-depth limit", () => {
    const jobId = randomUUID();
    expect(
      parseAttachmentProcessorRequest(
        JSON.stringify({
          kind: "execute",
          jobId,
          processor: "zip",
          quotas: { ...quotas, maximumArchiveDepth: 0 },
        }),
      ),
    ).toEqual({
      kind: "execute",
      jobId,
      processor: "zip",
      quotas: { ...quotas, maximumArchiveDepth: 0 },
    });
    expect(
      parseAttachmentProcessorRequest(
        JSON.stringify({
          kind: "execute",
          jobId,
          processor: "zip",
          quotas: { ...quotas, maximumArchiveDepth: -1 },
        }),
      ),
    ).toBeUndefined();
  });

  it("accepts empty canonical output while rejecting negative byte lengths", () => {
    const jobId = randomUUID();
    expect(
      parseAttachmentProcessorResponse(
        JSON.stringify({ kind: "result", jobId, outputByteLength: 0 }),
      ),
    ).toEqual({ kind: "result", jobId, outputByteLength: 0 });
    expect(
      parseAttachmentProcessorResponse(
        JSON.stringify({ kind: "result", jobId, outputByteLength: -1 }),
      ),
    ).toBeUndefined();
  });
});
