import { createHash } from "node:crypto";

import type { AttachmentSource } from "@caseweaver/connector-sdk";
import { describe, expect, it } from "vitest";

import type {
  AttachmentDerivative,
  AttachmentPreparationAttemptStore,
  AttachmentRepository,
  AttachmentRuntime,
  BlobHandle,
  BlobStagingHandle,
  BlobStore,
  ServerPrivateAttachmentOccurrence,
} from "./contracts.js";
import { AttachmentCancelledError } from "./errors.js";
import {
  type AttachmentOccurrencePreparationDependencies,
  attachmentOccurrencePreparationPlanIdentity,
  type PrepareAttachmentOccurrencesRequest,
  prepareAttachmentOccurrences,
} from "./occurrence-preparation.js";
import type { AttachmentPreparationResult } from "./preparation.js";

const workspaceId = "workspace-1";
const normalizedText = "cached searchable attachment evidence";
const normalizedBytes = new TextEncoder().encode(normalizedText);
const normalizedHash = createHash("sha256")
  .update(normalizedBytes)
  .digest("hex");

class TestBlobStore implements BlobStore {
  public readonly outputs = new Map<string, Uint8Array>([
    ["cached-output", normalizedBytes],
  ]);
  public opened = 0;

  public async beginStaging(input: {
    readonly workspaceId: string;
  }): Promise<BlobStagingHandle> {
    return {
      workspaceId: input.workspaceId,
      storageBackendId: "memory",
      id: "staging-1",
    };
  }

  public async append(): Promise<void> {}

  public async commit(staging: BlobStagingHandle): Promise<BlobHandle> {
    return {
      workspaceId: staging.workspaceId,
      storageBackendId: "memory",
      key: "input",
    };
  }

  public async abort(): Promise<void> {}

  public async open(handle: BlobHandle): Promise<AsyncIterable<Uint8Array>> {
    this.opened += 1;
    const content = this.outputs.get(handle.key);
    if (content === undefined) throw new Error("Unexpected blob open.");
    return (async function* () {
      yield content.slice();
    })();
  }

  public async writeText(): Promise<void> {}

  public async delete(): Promise<void> {}
}

class CompletedDerivativeRepository implements AttachmentRepository {
  public claimCalls = 0;

  public async claimDerivative(identity: AttachmentDerivative["identity"]) {
    this.claimCalls += 1;
    return {
      kind: "completed" as const,
      derivative: {
        id: "attachment-derivative:cached",
        identity,
        status: "completed" as const,
        output: {
          workspaceId,
          storageBackendId: "memory",
          key: "cached-output",
        },
        mimeType: "text/plain" as const,
        outputContentHash: normalizedHash,
        outputByteLength: normalizedBytes.byteLength,
      },
    };
  }

  public async completeDerivative(): Promise<void> {}

  public async failDerivative(): Promise<void> {}
}

const runtime: AttachmentRuntime = {
  execute: async () => {
    throw new Error("A completed derivative must not enter the runtime.");
  },
  cleanup: async () => {},
};

function source(
  input: {
    readonly failure?: Error;
    readonly observedIdentities?: unknown[];
  } = {},
): AttachmentSource {
  return {
    openAttachment: async (request) => {
      input.observedIdentities?.push(request.identity);
      if (input.failure !== undefined) throw input.failure;
      return {
        content: (async function* () {
          yield new TextEncoder().encode("attachment input");
        })(),
        mediaType: "text/plain",
      };
    },
  };
}

function occurrence(
  input: {
    readonly identity?: string;
    readonly ordinal?: number;
    readonly source?: AttachmentSource;
    readonly locator?: string;
  } = {},
): ServerPrivateAttachmentOccurrence {
  const reference = {
    connectorInstanceId: "connector-1",
    resourceType: "case",
    externalId: "case-1",
  };
  return {
    occurrence: {
      identity: input.identity ?? "case-1:attachment:0",
      ordinal: input.ordinal ?? 0,
      attachmentId: "attachment-1",
      relation: "inlineImage",
      required: false,
    },
    source: input.source ?? source(),
    reference,
    ...(input.locator === undefined
      ? {}
      : {
          openIdentity: {
            owner: { kind: "case", case: reference },
            ordinal: input.ordinal ?? 0,
            relation: "inlineImage",
            reference,
            locator: input.locator,
          },
        }),
  };
}

function request(
  input: {
    readonly mode?: "optional" | "required";
    readonly occurrences?: readonly ServerPrivateAttachmentOccurrence[];
    readonly signal?: AbortSignal;
  } = {},
): PrepareAttachmentOccurrencesRequest {
  return {
    subject: {
      workspaceId,
      kind: "caseCapture",
      id: "case-capture-1",
    },
    policy: {
      mode: input.mode ?? "optional",
      policyVersion: "attachment-policy.v1",
      accessPolicyHash: "access-policy.v1",
    },
    occurrences: input.occurrences ?? [occurrence()],
    processing: {
      intake: {
        maximumAttachmentBytes: 4096,
        allowedMimeTypes: new Set(["text/plain"]),
      },
      processors: {
        text: {
          processor: "text",
          processorVersion: "text.v1",
          securityPolicyVersion: "security.v1",
          normalizationVersion: "normalization.v1",
        },
        zip: {
          processor: "zip",
          processorVersion: "zip.v1",
          securityPolicyVersion: "security.v1",
          normalizationVersion: "normalization.v1",
        },
        vision: {
          processor: "vision",
          processorVersion: "vision.v1",
          securityPolicyVersion: "security.v1",
          normalizationVersion: "normalization.v1",
        },
      },
      quotas: {
        timeoutMs: 1000,
        maximumMemoryBytes: 1024,
        maximumInputBytes: 4096,
        maximumOutputBytes: 4096,
        maximumFiles: 10,
        maximumExpandedBytes: 4096,
        maximumExtractedFileBytes: 4096,
        maximumArchiveDepth: 1,
        maximumCompressionRatio: 10,
      },
    },
    signal: input.signal ?? new AbortController().signal,
  };
}

function dependencies(
  input: {
    readonly attempts?: AttachmentPreparationAttemptStore;
    readonly repository?: AttachmentRepository;
  } = {},
): AttachmentOccurrencePreparationDependencies {
  const blobStore = new TestBlobStore();
  return {
    blobStore,
    outputStore: {
      createOutput: async () => {
        throw new Error("A completed derivative must not create an output.");
      },
    },
    repository: input.repository ?? new CompletedDerivativeRepository(),
    runtime,
    ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
  };
}

class FencedAttemptStore implements AttachmentPreparationAttemptStore {
  public claimCount = 0;
  public finalizeInput:
    | {
        readonly result: AttachmentPreparationResult;
        readonly evidenceCount: number;
      }
    | undefined;

  public async claim(input: { readonly planIdentity: string }) {
    this.claimCount += 1;
    return {
      kind: "claimed" as const,
      attempt: {
        id: "attempt-1",
        fence: "fence-1",
        planIdentity: input.planIdentity,
      },
    };
  }

  public async finalize(input: {
    readonly result: AttachmentPreparationResult;
    readonly evidence: readonly unknown[];
  }): Promise<void> {
    this.finalizeInput = {
      result: input.result,
      evidenceCount: input.evidence.length,
    };
  }
}

describe("attachment occurrence preparation", () => {
  it("uses a stable plan identity independent of occurrence ordering or private locators", () => {
    const first = occurrence({
      identity: "occurrence-a",
      locator: "opaque-locator-a",
    });
    const second = occurrence({
      identity: "occurrence-b",
      ordinal: 1,
      locator: "opaque-locator-b",
    });
    const firstIdentity = attachmentOccurrencePreparationPlanIdentity({
      subject: request().subject,
      policy: request().policy,
      occurrences: [first.occurrence, second.occurrence],
    });
    const secondIdentity = attachmentOccurrencePreparationPlanIdentity({
      subject: request().subject,
      policy: request().policy,
      occurrences: [second.occurrence, first.occurrence],
    });

    expect(secondIdentity).toBe(firstIdentity);
    expect(firstIdentity).not.toContain("opaque-locator-a");
  });

  it("rejects malformed subject or occurrence boundary data before a durable attempt can be claimed", async () => {
    const attempts = new FencedAttemptStore();
    const invalidSubject = request();
    await expect(
      prepareAttachmentOccurrences(
        {
          ...invalidSubject,
          subject: { ...invalidSubject.subject, kind: "unknown" as never },
        },
        dependencies({ attempts }),
      ),
    ).rejects.toThrow("subject kind");
    expect(attempts.claimCount).toBe(0);

    const first = occurrence({ identity: "occurrence-a" });
    const duplicateOrdinal = occurrence({ identity: "occurrence-b" });
    const duplicateIdentity = {
      ...first,
      occurrence: { ...first.occurrence, ordinal: 1 },
    };
    const nonBooleanRequired: ServerPrivateAttachmentOccurrence = {
      ...first,
      occurrence: {
        ...first.occurrence,
        identity: "occurrence-required",
        required: "true" as never,
      },
    };
    expect(() =>
      attachmentOccurrencePreparationPlanIdentity({
        subject: request().subject,
        policy: request().policy,
        occurrences: [first.occurrence, duplicateOrdinal.occurrence],
      }),
    ).toThrow("ordinals");
    expect(() =>
      attachmentOccurrencePreparationPlanIdentity({
        subject: request().subject,
        policy: request().policy,
        occurrences: [nonBooleanRequired.occurrence],
      }),
    ).toThrow("required");

    for (const invalidOccurrences of [
      [first, duplicateIdentity],
      [first, duplicateOrdinal],
      [nonBooleanRequired],
    ]) {
      const invalidAttempts = new FencedAttemptStore();
      await expect(
        prepareAttachmentOccurrences(
          request({ occurrences: invalidOccurrences }),
          dependencies({ attempts: invalidAttempts }),
        ),
      ).rejects.toBeInstanceOf(RangeError);
      expect(invalidAttempts.claimCount).toBe(0);
    }
  });

  it("rejects an invalid policy before it can claim a durable attempt", async () => {
    const attempts = new FencedAttemptStore();
    const valid = request();
    await expect(
      prepareAttachmentOccurrences(
        {
          ...valid,
          policy: { ...valid.policy, mode: "unknown" as never },
        },
        dependencies({ attempts }),
      ),
    ).rejects.toThrow("policy mode");
    expect(attempts.claimCount).toBe(0);
  });

  it("reuses a completed derivative, records occurrence evidence, and never returns a locator", async () => {
    const observedIdentities: unknown[] = [];
    const locator = "opaque-reopen-locator-never-serialized";
    const repository = new CompletedDerivativeRepository();
    const attempts = new FencedAttemptStore();
    const result = await prepareAttachmentOccurrences(
      request({
        occurrences: [
          occurrence({
            source: source({ observedIdentities }),
            locator,
          }),
        ],
      }),
      dependencies({ repository, attempts }),
    );

    expect(repository.claimCalls).toBe(1);
    expect(observedIdentities[0]).toMatchObject({ locator });
    expect(result.result.outcome.selectedDerivatives).toHaveLength(1);
    expect(result.result.derivatives[0]?.searchableText).toBe(normalizedText);
    expect(JSON.stringify(result)).not.toContain(locator);
    expect(attempts.claimCount).toBe(1);
    expect(attempts.finalizeInput?.evidenceCount).toBe(1);
  });

  it("retains two distinct occurrence identities when their bytes reuse one derivative cache entry", async () => {
    const repository = new CompletedDerivativeRepository();
    const attempts = new FencedAttemptStore();
    const first = occurrence({ identity: "case-1:attachment:0" });
    const secondBase = occurrence({ identity: "case-1:attachment:1" });
    const second = {
      ...secondBase,
      occurrence: {
        ...secondBase.occurrence,
        ordinal: 1,
      },
    };

    const result = await prepareAttachmentOccurrences(
      request({ occurrences: [first, second] }),
      dependencies({ repository, attempts }),
    );

    expect(repository.claimCalls).toBe(2);
    expect(result.result.outcome.selectedDerivatives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ occurrenceIdentity: "case-1:attachment:0" }),
        expect.objectContaining({ occurrenceIdentity: "case-1:attachment:1" }),
      ]),
    );
    expect(result.result.derivatives).toHaveLength(2);
    expect(attempts.finalizeInput?.evidenceCount).toBe(2);
  });

  it("keeps optional failures available with a retry warning and makes required failures terminal", async () => {
    const failure = new Error("remote source was temporarily unavailable");
    const optional = await prepareAttachmentOccurrences(
      request({ occurrences: [occurrence({ source: source({ failure }) })] }),
      dependencies(),
    );
    const required = await prepareAttachmentOccurrences(
      request({
        mode: "required",
        occurrences: [occurrence({ source: source({ failure }) })],
      }),
      dependencies(),
    );

    expect(optional.result.outcome).toMatchObject({
      status: "prepared",
      retryRequired: true,
    });
    expect(required.result.outcome).toMatchObject({
      status: "terminal",
      retryRequired: true,
    });
    expect(optional.result.outcome.warnings).toEqual([
      expect.objectContaining({
        code: "attachment.processing-failed",
        retryable: true,
      }),
    ]);
  });

  it("propagates cancellation without opening an attachment or turning it into a warning", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareAttachmentOccurrences(
        request({ signal: controller.signal }),
        dependencies(),
      ),
    ).rejects.toBeInstanceOf(AttachmentCancelledError);
  });
});
