import { describe, expect, it } from "vitest";

import { AttestedAttachmentRuntime } from "./index.js";

const attestation = {
  networkDisabled: true,
  credentialsUnavailable: true,
  disposableFilesystem: true,
  quotasEnforced: true,
} as const;

const request = (signal = new AbortController().signal) => ({
  workspaceId: "workspace-1",
  processor: "text" as const,
  input: { workspaceId: "workspace-1", key: "input" },
  output: { workspaceId: "workspace-1", key: "output" },
  quotas: {
    timeoutMs: 10,
    maximumMemoryBytes: 100,
    maximumInputBytes: 100,
    maximumOutputBytes: 100,
    maximumFiles: 1,
    maximumExpandedBytes: 100,
    maximumExtractedFileBytes: 100,
    maximumArchiveDepth: 1,
    maximumCompressionRatio: 10,
  },
  signal,
});

describe("AttestedAttachmentRuntime", () => {
  it("cleans isolated artifacts after success and enforces attested isolation", async () => {
    const cleaned: string[] = [];
    const runtime = new AttestedAttachmentRuntime(
      {
        attestation,
        execute: async () => ({ outputByteLength: 2 }),
        cleanup: async (workspaceId) => {
          cleaned.push(workspaceId);
        },
      },
      { delete: async () => {} },
    );

    await expect(runtime.execute(request())).resolves.toMatchObject({
      outputByteLength: 2,
      attestation,
    });
    expect(cleaned).toEqual(["workspace-1"]);
  });

  it("cleans after cancellation and deletes output artifacts on failure cleanup", async () => {
    const controller = new AbortController();
    const cleaned: string[] = [];
    const deleted: string[] = [];
    const runtime = new AttestedAttachmentRuntime(
      {
        attestation,
        execute: async () => new Promise(() => {}),
        cleanup: async () => {
          cleaned.push("runtime");
        },
      },
      {
        delete: async (handle, workspaceId) => {
          deleted.push(`${workspaceId}:${handle.key}`);
        },
      },
    );
    const pending = runtime.execute(request(controller.signal));
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "attachment.aborted",
    });
    await runtime.cleanup({
      workspaceId: "workspace-1",
      handles: [{ workspaceId: "workspace-1", key: "output" }],
    });
    expect(cleaned).toEqual(["runtime"]);
    expect(deleted).toEqual(["workspace-1:output"]);
  });

  it("reports a timeout and cleans isolated artifacts when an executor ignores abort", async () => {
    const cleaned: string[] = [];
    const runtime = new AttestedAttachmentRuntime(
      {
        attestation,
        execute: async () => new Promise(() => {}),
        cleanup: async () => {
          cleaned.push("runtime");
        },
      },
      { delete: async () => {} },
    );

    await expect(runtime.execute(request())).rejects.toMatchObject({
      code: "attachment.runtimeTimeout",
    });
    expect(cleaned).toEqual(["runtime"]);
  });

  it("rejects executor-reported output beyond the quota and cleans artifacts", async () => {
    const cleaned: string[] = [];
    const runtime = new AttestedAttachmentRuntime(
      {
        attestation,
        execute: async () => ({ outputByteLength: 101 }),
        cleanup: async () => {
          cleaned.push("runtime");
        },
      },
      { delete: async () => {} },
    );

    await expect(runtime.execute(request())).rejects.toMatchObject({
      code: "attachment.outputTooLarge",
      retryable: false,
    });
    expect(cleaned).toEqual(["runtime"]);
  });

  it("permits a zero archive depth while retaining positive resource limits", async () => {
    const runtime = new AttestedAttachmentRuntime(
      {
        attestation,
        execute: async () => ({ outputByteLength: 0 }),
        cleanup: async () => undefined,
      },
      { delete: async () => undefined },
    );
    await expect(
      runtime.execute({
        ...request(),
        quotas: { ...request().quotas, maximumArchiveDepth: 0 },
      }),
    ).resolves.toMatchObject({ outputByteLength: 0 });
  });
});
