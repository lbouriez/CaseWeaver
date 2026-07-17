import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  type FrozenAttachmentEvidenceError,
  FrozenSnapshotAttachmentEvidencePort,
} from "./attachment-evidence.js";
import type { AnalysisExecution } from "./contracts.js";
import { createPreparedAttachmentEvidenceIdentity } from "./identity.js";

const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const preparedAttachmentEvidence = {
  evidence: [
    {
      attachmentId: "attachment-1",
      derivativeId: "derivative-1",
      outputContentHash: digest("Normalized attachment evidence."),
      outcome: "ready" as const,
      required: true,
    },
  ],
};

const execution: AnalysisExecution = {
  workspaceId: "workspace-1",
  analysisJobId: "analysis-job-1",
  analysisIdentityId: "analysis-identity-1",
  analysisAttemptId: "analysis-attempt-1",
  snapshot: {
    id: "snapshot-1",
    revision: "revision-1",
    capturedAt: "2026-07-15T12:00:00.000Z",
    title: "Case title",
    summary: "Case summary",
    contentHash: "a".repeat(64),
    messages: [],
  },
  profile: {
    id: "profile-1",
    version: "1",
    analysisBindingVersionId: "analysis-binding-1",
    prompt: {
      template: {
        id: "template-1",
        version: "1",
        systemInstruction: "Analyze the case.",
      },
      schemaVersion: "case-analysis.v1",
      budgets: {
        case: { maximumCharacters: 1_000, maximumTokens: 1_000 },
        attachments: { maximumCharacters: 1_000, maximumTokens: 1_000 },
        knowledge: { maximumCharacters: 1_000, maximumTokens: 1_000 },
        repository: { maximumCharacters: 1_000, maximumTokens: 1_000 },
      },
    },
    retrieval: {
      policy: "disabled",
      profileId: "retrieval-1",
      profileVersion: "1",
      collectionIds: ["collection-1"],
      maximumQueryCharacters: 1_000,
    },
    attachments: { policy: "required" },
    repository: {
      policy: "disabled",
      maximumContextCharacters: 1_000,
      maximumEvidenceCharacters: 1_000,
    },
    generation: {
      maximumInputTokens: 1_000,
      maximumOutputTokens: 100,
      budget: { currency: "USD", hard: true },
    },
    repair: { maximumAttempts: 0, maximumInputCharacters: 1_000 },
  },
  preparedAttachments: {
    ...preparedAttachmentEvidence,
    identityHash: createPreparedAttachmentEvidenceIdentity(
      preparedAttachmentEvidence,
    ),
  },
};

function port(input: {
  readonly text: string;
  readonly expectedHash?: string;
  readonly references?: readonly {
    readonly occurrenceIdentity?: string;
    readonly attachmentId: string;
    readonly derivativeId: string;
    readonly processorVersion: string;
    readonly outputContentHash: string;
  }[];
}) {
  const contentHash = digest(input.text);
  return new FrozenSnapshotAttachmentEvidencePort({
    references: {
      async listSnapshotAttachmentReferences() {
        return (
          input.references ?? [
            {
              attachmentId: "attachment-1",
              derivativeId: "derivative-1",
              processorVersion: "processor-v1",
              outputContentHash: input.expectedHash ?? contentHash,
            },
          ]
        );
      },
    },
    content: {
      async readDerivativeText() {
        return { content: input.text, contentHash };
      },
    },
    maximumEvidenceCharacters: 100,
  });
}

describe("FrozenSnapshotAttachmentEvidencePort", () => {
  it("maps only snapshot-pinned derivative content without exposing storage metadata", async () => {
    const result = await port({
      text: "Normalized attachment evidence.",
    }).resolve({
      execution,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      evidence: [
        expect.objectContaining({
          kind: "attachment",
          attachmentId: "attachment-1",
          derivativeId: "derivative-1",
          processorVersion: "processor-v1",
          content: "Normalized attachment evidence.",
          contentHash: digest("Normalized attachment evidence."),
        }),
      ],
      operationIds: [],
    });
    expect(JSON.stringify(result)).not.toContain("storage");
  });

  it("fails closed when a derivative no longer matches its captured hash", async () => {
    await expect(
      port({ text: "Changed output.", expectedHash: "b".repeat(64) }).resolve({
        execution,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject<FrozenAttachmentEvidenceError>({
      code: "analysis.attachmentEvidenceIntegrity",
      retryable: false,
    });
  });

  it("fails closed when the prepared attachment identity is forged", async () => {
    await expect(
      port({ text: "Normalized attachment evidence." }).resolve({
        execution: {
          ...execution,
          preparedAttachments: {
            ...preparedAttachmentEvidence,
            identityHash: "a".repeat(64),
          },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject<FrozenAttachmentEvidenceError>({
      code: "analysis.attachmentEvidenceIntegrity",
      retryable: false,
    });
  });

  it("redacts derivative-reader failures instead of propagating storage details", async () => {
    const hash = digest("Normalized attachment evidence.");
    const evidence = new FrozenSnapshotAttachmentEvidencePort({
      references: {
        async listSnapshotAttachmentReferences() {
          return [
            {
              attachmentId: "attachment-1",
              derivativeId: "derivative-1",
              processorVersion: "processor-v1",
              outputContentHash: hash,
            },
          ];
        },
      },
      content: {
        async readDerivativeText() {
          throw new Error("s3://private-bucket/secret-object-key");
        },
      },
      maximumEvidenceCharacters: 100,
    });

    await expect(
      evidence.resolve({ execution, signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: "analysis.attachmentEvidenceUnavailable",
      retryable: false,
      message: "Captured attachment evidence is not available.",
    });
  });

  it("keeps two occurrences of one binary distinct while reusing its derivative", async () => {
    const hash = digest("Normalized attachment evidence.");
    const occurrences = {
      evidence: [
        {
          occurrenceIdentity: "case-occurrence-1",
          attachmentId: "attachment-1",
          derivativeId: "derivative-1",
          outputContentHash: hash,
          outcome: "ready" as const,
          required: true,
        },
        {
          occurrenceIdentity: "case-occurrence-2",
          attachmentId: "attachment-1",
          derivativeId: "derivative-1",
          outputContentHash: hash,
          outcome: "ready" as const,
          required: true,
        },
      ],
    };
    await expect(
      port({
        text: "Normalized attachment evidence.",
        references: [
          {
            occurrenceIdentity: "case-occurrence-1",
            attachmentId: "attachment-1",
            derivativeId: "derivative-1",
            processorVersion: "processor-v1",
            outputContentHash: hash,
          },
          {
            occurrenceIdentity: "case-occurrence-2",
            attachmentId: "attachment-1",
            derivativeId: "derivative-1",
            processorVersion: "processor-v1",
            outputContentHash: hash,
          },
        ],
      }).resolve({
        execution: {
          ...execution,
          preparedAttachments: {
            ...occurrences,
            identityHash: createPreparedAttachmentEvidenceIdentity(occurrences),
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ evidence: [{}, {}] });
  });
});
