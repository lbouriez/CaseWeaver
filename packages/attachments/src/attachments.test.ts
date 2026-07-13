import type {
  AiExecutionGateway,
  MeteredAiRequest,
} from "@caseweaver/ai-execution";
import type { AttachmentSource } from "@caseweaver/connector-sdk";
import { describe, expect, it } from "vitest";

import type {
  AttachmentDerivative,
  AttachmentOutputStore,
  AttachmentRepository,
  BlobHandle,
  BlobStagingHandle,
  BlobStore,
} from "./contracts.js";
import { derivativeCacheIdentity } from "./identity.js";
import { intakeAttachment } from "./intake.js";
import { processAttachment } from "./processing.js";
import { normalizeText } from "./text.js";
import { inspectZipArchive, validateArchiveEntries } from "./zip.js";

class TestBlobStore implements BlobStore, AttachmentOutputStore {
  public readonly chunks: Uint8Array[] = [];
  public readonly createdOutputs: BlobHandle[] = [];
  public aborted = 0;
  public written = "";

  public async beginStaging(input: {
    readonly workspaceId: string;
  }): Promise<BlobStagingHandle> {
    return { workspaceId: input.workspaceId, id: "stage-1" };
  }

  public async append(
    _staging: BlobStagingHandle,
    content: Uint8Array,
  ): Promise<void> {
    this.chunks.push(content.slice());
  }

  public async commit(staging: BlobStagingHandle): Promise<BlobHandle> {
    return { workspaceId: staging.workspaceId, key: "input" };
  }

  public async abort(): Promise<void> {
    this.aborted += 1;
  }

  public async privateUrl(): Promise<string> {
    return "caseweaver-blob://private/workspace-1/input";
  }

  public async open(): Promise<AsyncIterable<Uint8Array>> {
    return (async function* () {})();
  }

  public async writeText(
    _handle: BlobHandle,
    _workspaceId: string,
    text: string,
  ): Promise<void> {
    this.written = text;
  }

  public async delete(): Promise<void> {}

  public async createOutput(
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<BlobHandle> {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const output = {
      workspaceId,
      key: `output-${this.createdOutputs.length}`,
    };
    this.createdOutputs.push(output);
    return output;
  }
}

function source(
  chunks: readonly Uint8Array[],
  mediaType?: string,
): AttachmentSource {
  return {
    openAttachment: async () => ({
      content: (async function* () {
        yield* chunks;
      })(),
      mediaType,
    }),
  };
}

const policy = {
  maximumAttachmentBytes: 32,
  allowedMimeTypes: new Set(["text/plain", "image/png"]),
};

const reference = {
  connectorInstanceId: "connector-1",
  resourceType: "attachment",
  externalId: "1",
};

describe("attachment intake and policy", () => {
  it("streams bytes, hashes authoritative MIME content, and commits only after validation", async () => {
    const store = new TestBlobStore();
    const accepted = await intakeAttachment({
      workspaceId: "workspace-1",
      source: source(
        [new TextEncoder().encode("hello "), new TextEncoder().encode("world")],
        "text/plain",
      ),
      reference,
      blobStore: store,
      policy,
      signal: new AbortController().signal,
    });

    expect(accepted).toMatchObject({
      byteLength: 11,
      sha256:
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      detectedMimeType: "text/plain",
    });
    expect(store.aborted).toBe(0);
    expect(store.chunks).toHaveLength(2);
  });

  it("rejects oversized and declared-MIME-mismatched streams without commit", async () => {
    const oversized = new TestBlobStore();
    await expect(
      intakeAttachment({
        workspaceId: "workspace-1",
        source: source([new Uint8Array(33)]),
        reference,
        blobStore: oversized,
        policy,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "attachment.contentTooLarge" });
    expect(oversized.aborted).toBe(1);

    const mismatched = new TestBlobStore();
    await expect(
      intakeAttachment({
        workspaceId: "workspace-1",
        source: source(
          [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
          "text/plain",
        ),
        reference,
        blobStore: mismatched,
        policy,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "attachment.mimeMismatch" });
    expect(mismatched.aborted).toBe(1);

    const unsupported = new TestBlobStore();
    await expect(
      intakeAttachment({
        workspaceId: "workspace-1",
        source: source([Uint8Array.of(0, 1, 2, 3)]),
        reference,
        blobStore: unsupported,
        policy,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "attachment.unsupportedMime" });
    expect(unsupported.aborted).toBe(1);
  });
});

describe("attachment derivative identity and processing", () => {
  const base = {
    workspaceId: "workspace-1",
    accessPolicyHash: "access-a",
    contentSha256: "a".repeat(64),
    processor: "vision",
    processorVersion: "vision.v1",
    securityPolicyVersion: "policy.v1",
    normalizationVersion: "normalization.v1",
    visionPromptVersion: "prompt.v1",
    visionBindingVersionId: "binding.v1",
  };
  const processing = {
    processor: base.processor,
    processorVersion: base.processorVersion,
    securityPolicyVersion: base.securityPolicyVersion,
    normalizationVersion: base.normalizationVersion,
  } as const;
  const vision = {
    prompt: "immutable prompt",
    promptVersion: base.visionPromptVersion,
    bindingVersionId: base.visionBindingVersionId,
    maximumInputTokens: 10,
    maximumOutputTokens: 10,
    budget: { currency: "USD", hard: true },
  } as const;

  it("scopes cache reuse and invalidates policy, prompt, and binding changes", () => {
    const original = derivativeCacheIdentity(base);
    expect(derivativeCacheIdentity({ ...base })).toEqual(original);
    expect(
      derivativeCacheIdentity({ ...base, workspaceId: "workspace-2" }).key,
    ).not.toBe(original.key);
    expect(
      derivativeCacheIdentity({ ...base, accessPolicyHash: "access-b" }).key,
    ).not.toBe(original.key);
    expect(
      derivativeCacheIdentity({ ...base, securityPolicyVersion: "policy.v2" })
        .key,
    ).not.toBe(original.key);
    expect(
      derivativeCacheIdentity({ ...base, visionPromptVersion: "prompt.v2" })
        .key,
    ).not.toBe(original.key);
    expect(
      derivativeCacheIdentity({ ...base, visionBindingVersionId: "binding.v2" })
        .key,
    ).not.toBe(original.key);
  });

  it("uses only the metered gateway for vision and records its operation ID", async () => {
    const store = new TestBlobStore();
    const identity = derivativeCacheIdentity(base);
    let completed: AttachmentDerivative | undefined;
    const repository: AttachmentRepository = {
      claimDerivative: async () => ({ kind: "claimed", claimId: "claim-1" }),
      completeDerivative: async (input) => {
        completed = input.derivative;
      },
      failDerivative: async () => {},
    };
    const calls: MeteredAiRequest[] = [];
    const gateway: AiExecutionGateway = {
      execute: async (request) => {
        calls.push(request);
        return {
          operationId: "vision-operation-1",
          value: { text: "visible error 42" },
          calculatedCost: { status: "unknown", components: [] },
        };
      },
    };
    const input = {
      workspaceId: "workspace-1",
      sourceReference: reference,
      blob: { workspaceId: "workspace-1", key: "input" },
      byteLength: 8,
      sha256: "a".repeat(64),
      detectedMimeType: "image/png",
    } as const;

    const derivative = await processAttachment({
      attachment: input,
      accessPolicyHash: "access-a",
      identity,
      processing,
      repository,
      blobStore: store,
      outputStore: store,
      runtime: {
        execute: async () => {
          throw new Error("vision must not invoke the attachment runtime");
        },
        cleanup: async () => {},
      },
      quotas: {
        timeoutMs: 100,
        maximumMemoryBytes: 1_024,
        maximumOutputBytes: 100,
        maximumFiles: 1,
        maximumExpandedBytes: 1_024,
        maximumExtractedFileBytes: 1_024,
        maximumArchiveDepth: 1,
        maximumCompressionRatio: 10,
      },
      vision,
      aiExecution: gateway,
      analysisId: "analysis-1",
      signal: new AbortController().signal,
    });

    expect(calls).toMatchObject([
      {
        kind: "vision",
        role: "vision",
        analysisId: "analysis-1",
        bindingVersionId: "binding.v1",
        request: {
          prompt: "immutable prompt",
          images: [{ url: "caseweaver-blob://private/workspace-1/input" }],
        },
      },
    ]);
    expect(store.written).toBe("visible error 42");
    expect(derivative?.operationId).toBe("vision-operation-1");
    expect(completed?.operationId).toBe("vision-operation-1");
  });

  it("does not allocate or clean output for cache hits and active claims", async () => {
    const identity = derivativeCacheIdentity(base);
    const store = new TestBlobStore();
    const cached: AttachmentDerivative = {
      id: "cached",
      identity,
      status: "completed",
      output: { workspaceId: "workspace-1", key: "cached-output" },
      mimeType: "text/plain",
    };
    const noRuntime = {
      execute: async () => {
        throw new Error("cache paths must not execute");
      },
      cleanup: async () => {
        throw new Error("cache paths must not clean outputs");
      },
    };
    const common = {
      attachment: {
        workspaceId: "workspace-1",
        sourceReference: reference,
        blob: { workspaceId: "workspace-1", key: "input" },
        byteLength: 1,
        sha256: "a".repeat(64),
        detectedMimeType: "image/png",
      },
      accessPolicyHash: "access-a",
      identity,
      processing,
      blobStore: store,
      outputStore: store,
      runtime: noRuntime,
      quotas: {
        timeoutMs: 100,
        maximumMemoryBytes: 100,
        maximumOutputBytes: 100,
        maximumFiles: 1,
        maximumExpandedBytes: 100,
        maximumExtractedFileBytes: 100,
        maximumArchiveDepth: 1,
        maximumCompressionRatio: 10,
      },
      vision,
      signal: new AbortController().signal,
    } as const;

    const reuse = await processAttachment({
      ...common,
      repository: {
        claimDerivative: async () => ({
          kind: "completed",
          derivative: cached,
        }),
        completeDerivative: async () => {},
        failDerivative: async () => {},
      },
    });
    const concurrent = await processAttachment({
      ...common,
      repository: {
        claimDerivative: async () => ({ kind: "inProgress" }),
        completeDerivative: async () => {},
        failDerivative: async () => {},
      },
    });

    expect(reuse).toBe(cached);
    expect(concurrent).toBeUndefined();
    expect(store.createdOutputs).toEqual([]);
  });

  it.each([
    ["workspace", { workspaceId: "workspace-2" }],
    ["content", { contentSha256: "b".repeat(64) }],
    ["empty access policy", { accessPolicyHash: "" }],
    ["oversized access policy", { accessPolicyHash: "a".repeat(1_025) }],
    ["cache key", { key: "tampered" }],
  ])("rejects a supplied identity with mismatched %s before claiming or allocating output", async (_boundary, identityOverride) => {
    const store = new TestBlobStore();
    const identity = {
      ...derivativeCacheIdentity(base),
      ...identityOverride,
    };
    let claims = 0;
    const repository: AttachmentRepository = {
      claimDerivative: async () => {
        claims += 1;
        return { kind: "claimed", claimId: "claim-1" };
      },
      completeDerivative: async () => {},
      failDerivative: async () => {},
    };

    await expect(
      processAttachment({
        attachment: {
          workspaceId: "workspace-1",
          sourceReference: reference,
          blob: { workspaceId: "workspace-1", key: "input" },
          byteLength: 1,
          sha256: "a".repeat(64),
          detectedMimeType: "image/png",
        },
        accessPolicyHash: "access-a",
        identity,
        processing,
        repository,
        blobStore: store,
        outputStore: store,
        runtime: {
          execute: async () => {
            throw new Error("invalid cache identities must not execute");
          },
          cleanup: async () => {
            throw new Error("invalid cache identities must not clean outputs");
          },
        },
        quotas: {
          timeoutMs: 100,
          maximumMemoryBytes: 100,
          maximumOutputBytes: 100,
          maximumFiles: 1,
          maximumExpandedBytes: 100,
          maximumExtractedFileBytes: 100,
          maximumArchiveDepth: 1,
          maximumCompressionRatio: 10,
        },
        vision,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "attachment.invalidCacheIdentity",
      retryable: false,
    });

    expect(claims).toBe(0);
    expect(store.createdOutputs).toEqual([]);
  });

  it.each([
    ["access policy", { accessPolicyHash: "access-b" }],
    ["processor", { processing: { ...processing, processor: "text" } }],
    [
      "processor version",
      { processing: { ...processing, processorVersion: "vision.v2" } },
    ],
    [
      "security policy",
      { processing: { ...processing, securityPolicyVersion: "policy.v2" } },
    ],
    [
      "normalization",
      {
        processing: {
          ...processing,
          normalizationVersion: "normalization.v2",
        },
      },
    ],
    ["vision prompt", { vision: { ...vision, promptVersion: "prompt.v2" } }],
    [
      "vision binding",
      { vision: { ...vision, bindingVersionId: "binding.v2" } },
    ],
  ] as const)("rejects stale current %s parameters before claiming or allocating output", async (_parameter, current) => {
    const store = new TestBlobStore();
    let claims = 0;
    const repository: AttachmentRepository = {
      claimDerivative: async () => {
        claims += 1;
        return { kind: "claimed", claimId: "claim-1" };
      },
      completeDerivative: async () => {},
      failDerivative: async () => {},
    };

    await expect(
      processAttachment({
        attachment: {
          workspaceId: "workspace-1",
          sourceReference: reference,
          blob: { workspaceId: "workspace-1", key: "input" },
          byteLength: 1,
          sha256: "a".repeat(64),
          detectedMimeType: "image/png",
        },
        accessPolicyHash: "access-a",
        identity: derivativeCacheIdentity(base),
        processing,
        repository,
        blobStore: store,
        outputStore: store,
        runtime: {
          execute: async () => {
            throw new Error("stale cache identities must not execute");
          },
          cleanup: async () => {
            throw new Error("stale cache identities must not clean outputs");
          },
        },
        quotas: {
          timeoutMs: 100,
          maximumMemoryBytes: 100,
          maximumOutputBytes: 100,
          maximumFiles: 1,
          maximumExpandedBytes: 100,
          maximumExtractedFileBytes: 100,
          maximumArchiveDepth: 1,
          maximumCompressionRatio: 10,
        },
        vision,
        signal: new AbortController().signal,
        ...current,
      }),
    ).rejects.toMatchObject({
      code: "attachment.invalidCacheIdentity",
      retryable: false,
    });

    expect(claims).toBe(0);
    expect(store.createdOutputs).toEqual([]);
  });
});

describe("safe text and archive boundaries", () => {
  it("rejects malformed UTF-8 and bounds normalized output without breaking characters", () => {
    expect(() => normalizeText(Uint8Array.of(0xc3, 0x28), 100)).toThrow(
      "valid UTF-8",
    );
    expect(normalizeText(new TextEncoder().encode("éé"), 3)).toEqual({
      text: "é",
      truncated: true,
    });
  });

  it("rejects zip-slip, symlink, bomb, and deep archive entries", () => {
    const limits = {
      maximumFiles: 2,
      maximumExpandedBytes: 100,
      maximumExtractedFileBytes: 100,
      maximumDepth: 1,
      maximumCompressionRatio: 10,
    };
    for (const entry of [
      {
        path: "../escape.txt",
        kind: "file",
        compressedBytes: 1,
        expandedBytes: 1,
        encrypted: false,
        depth: 1,
      },
      {
        path: "link",
        kind: "symlink",
        compressedBytes: 1,
        expandedBytes: 1,
        encrypted: false,
        depth: 1,
      },
      {
        path: "bomb.txt",
        kind: "file",
        compressedBytes: 1,
        expandedBytes: 99,
        encrypted: false,
        depth: 1,
      },
      {
        path: "deep.txt",
        kind: "file",
        compressedBytes: 1,
        expandedBytes: 1,
        encrypted: false,
        depth: 2,
      },
    ] as const) {
      expect(() => validateArchiveEntries([entry], limits)).toThrow("Archive");
    }
  });

  it("parses ZIP metadata before extraction and rejects malicious ZIP fixtures", () => {
    const limits = {
      maximumFiles: 2,
      maximumExpandedBytes: 100,
      maximumExtractedFileBytes: 100,
      maximumDepth: 2,
      maximumCompressionRatio: 10,
    };
    const zip = (path: string, flags = 0, externalAttributes = 0) => {
      const name = new TextEncoder().encode(path);
      const central = new Uint8Array(46 + name.byteLength);
      const view = new DataView(central.buffer);
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(8, flags, true);
      view.setUint32(20, 1, true);
      view.setUint32(24, 1, true);
      view.setUint16(28, name.byteLength, true);
      view.setUint32(38, externalAttributes, true);
      central.set(name, 46);
      const end = new Uint8Array(22);
      const ending = new DataView(end.buffer);
      ending.setUint32(0, 0x06054b50, true);
      ending.setUint16(8, 1, true);
      ending.setUint16(10, 1, true);
      ending.setUint32(12, central.byteLength, true);
      ending.setUint32(16, 0, true);
      return new Uint8Array([...central, ...end]);
    };

    expect(inspectZipArchive(zip("safe.txt"), limits)).toMatchObject([
      { path: "safe.txt", kind: "file" },
    ]);
    expect(() => inspectZipArchive(zip("../escape.txt"), limits)).toThrow(
      "unsafe path",
    );
    expect(() => inspectZipArchive(zip("secret.txt", 1), limits)).toThrow(
      "forbidden entry",
    );
    expect(() =>
      inspectZipArchive(zip("link", 0, 0o120000 << 16), limits),
    ).toThrow("forbidden entry");
  });
});
