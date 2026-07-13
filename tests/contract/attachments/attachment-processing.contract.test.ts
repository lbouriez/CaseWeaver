import { describe, expect, it } from "vitest";
import { AttestedAttachmentRuntime } from "../../../infrastructure/attachment-runtime/dist/index.js";
import { InMemoryBlobStore } from "../../../infrastructure/object-storage/dist/index.js";
import {
  type AttachmentDerivative,
  type AttachmentRepository,
  type BlobHandle,
  derivativeCacheIdentity,
  processAttachment,
} from "../../../packages/attachments/dist/index.js";

const workspaceId = "workspace-a";
const quotas = {
  timeoutMs: 100,
  maximumMemoryBytes: 1_024,
  maximumOutputBytes: 10,
  maximumFiles: 1,
  maximumExpandedBytes: 1_024,
  maximumExtractedFileBytes: 1_024,
  maximumArchiveDepth: 1,
  maximumCompressionRatio: 10,
};

async function createInput(store: InMemoryBlobStore): Promise<BlobHandle> {
  const signal = new AbortController().signal;
  const staging = await store.beginStaging({
    workspaceId,
    maximumBytes: 100,
    signal,
  });
  await store.append(staging, new TextEncoder().encode("input"), signal);
  return store.commit(
    staging,
    { sha256: "a".repeat(64), byteLength: 5 },
    signal,
  );
}

describe("attachment storage and runtime contract", () => {
  it("allocates an output only for an owned claim, then removes it when the runtime rejects over-quota output", async () => {
    const store = new InMemoryBlobStore();
    const input = await createInput(store);
    const identity = derivativeCacheIdentity({
      workspaceId,
      accessPolicyHash: "access-policy-a",
      contentSha256: "a".repeat(64),
      processor: "text",
      processorVersion: "text.v1",
      securityPolicyVersion: "policy.v1",
      normalizationVersion: "normalization.v1",
    });
    const outputs: BlobHandle[] = [];
    const outputStore = {
      createOutput: async (
        outputWorkspaceId: string,
        signal: AbortSignal,
      ): Promise<BlobHandle> => {
        const output = await store.createOutput(outputWorkspaceId, signal);
        outputs.push(output);
        return output;
      },
    };
    const runtime = new AttestedAttachmentRuntime(
      {
        attestation: {
          networkDisabled: true,
          credentialsUnavailable: true,
          disposableFilesystem: true,
          quotasEnforced: true,
        },
        execute: async () => ({
          outputByteLength: quotas.maximumOutputBytes + 1,
        }),
        cleanup: async () => {},
      },
      store,
    );
    const failures: string[] = [];
    const repository = (kind: "completed" | "inProgress" | "claimed") =>
      ({
        claimDerivative: async () => {
          if (kind === "completed") {
            return {
              kind,
              derivative: {
                id: "cached",
                identity,
                status: "completed",
                output: { workspaceId, key: "cached" },
                mimeType: "text/plain",
              } satisfies AttachmentDerivative,
            };
          }
          return kind === "inProgress"
            ? { kind }
            : { kind, claimId: "claim-1" };
        },
        completeDerivative: async () => {},
        failDerivative: async (failure) => {
          failures.push(failure.code);
        },
      }) satisfies AttachmentRepository;
    const request = (repositoryForClaim: AttachmentRepository) => ({
      attachment: {
        workspaceId,
        sourceReference: {
          connectorInstanceId: "connector-1",
          resourceType: "attachment",
          externalId: "attachment-1",
        },
        blob: input,
        byteLength: 5,
        sha256: "a".repeat(64),
        detectedMimeType: "text/plain",
      },
      accessPolicyHash: "access-policy-a",
      identity,
      processing: {
        processor: "text",
        processorVersion: "text.v1",
        securityPolicyVersion: "policy.v1",
        normalizationVersion: "normalization.v1",
      },
      repository: repositoryForClaim,
      blobStore: store,
      outputStore,
      runtime,
      quotas,
      signal: new AbortController().signal,
    });

    await expect(
      processAttachment(request(repository("completed"))),
    ).resolves.toMatchObject({
      id: "cached",
    });
    await expect(
      processAttachment(request(repository("inProgress"))),
    ).resolves.toBeUndefined();
    expect(outputs).toEqual([]);

    await expect(
      processAttachment(request(repository("claimed"))),
    ).rejects.toMatchObject({
      code: "attachment.outputTooLarge",
    });
    expect(failures).toEqual(["attachment.outputTooLarge"]);
    expect(outputs).toHaveLength(1);
    const output = outputs.at(0);
    if (output === undefined) throw new Error("Expected a claimed output.");
    await expect(
      store.open(output, workspaceId, new AbortController().signal),
    ).rejects.toThrow("blob was not found");
  });
});
