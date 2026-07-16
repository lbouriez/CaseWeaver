import { createHash } from "node:crypto";

import type { AnalysisExecution } from "@caseweaver/analysis";
import type {
  RetrievalProfile,
  RetrievalRequest,
  RetrievalSnapshot,
} from "@caseweaver/retrieval";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  type PostgresAnalysisEvidenceAdapterError,
  PostgresAnalysisRetrievalEvidencePort,
  PostgresSnapshotAttachmentReferenceStore,
} from "./evidence-adapters.js";

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const retrievalProfile: RetrievalProfile = {
  id: "retrieval-profile-1",
  version: "1",
  contextTokenBindingVersionId: "analysis-binding-1",
  collections: [
    {
      id: "collection-1",
      embeddingBindingVersionId: "embedding-binding-1",
      embeddingProfileVersion: "1",
      dimensions: 3,
    },
  ],
  policy: {
    rankConstant: 60,
    lexicalWeight: 1,
    vectorWeight: 1,
    maximumFinalResults: 5,
    maximumCharacters: 1_000,
    maximumTokens: 1_000,
    defaultSourceQuota: { maximumCandidates: 5, maximumFinalResults: 5 },
    sourceQuotas: [],
  },
  queryEmbedding: {
    maximumInputTokens: 100,
    budget: { currency: "USD", hard: true },
  },
};

const execution = {
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
    id: "analysis-profile-1",
    version: "1",
    analysisBindingVersionId: "analysis-binding-1",
    prompt: {
      template: {
        id: "template-1",
        version: "1",
        systemInstruction: "Analyze.",
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
      policy: "required" as const,
      profileId: "retrieval-profile-1",
      profileVersion: "1",
      collectionIds: ["collection-1"],
      maximumQueryCharacters: 1_000,
    },
    attachments: { policy: "disabled" as const },
    repository: {
      policy: "disabled" as const,
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
} satisfies AnalysisExecution;

function retrievalSnapshot(request: RetrievalRequest): RetrievalSnapshot {
  return {
    id: request.snapshot.id,
    workspaceId: request.workspaceId,
    analysisId: request.snapshot.analysisId,
    capturedAt: request.snapshot.capturedAt,
    query: request.query,
    profileId: request.profile.id,
    profileVersion: request.profile.version,
    queryEmbeddingOperationIds: {
      "embedding-binding-z": "operation-z",
      "embedding-binding-a": "operation-a",
    },
    rerankerOperationId: "operation-2",
    evidence: [
      {
        collectionId: "collection-1",
        sourceId: "source-1",
        sourceRevisionId: "revision-1",
        chunkId: "chunk-1",
        location: "section:1",
        sourceUrl:
          "https://user:credential@example.invalid/private?signature=secret",
        content: "Knowledge evidence.",
        accessMetadata: {},
        scores: { fusedRrf: 0.2, lexicalRrf: 0.1, vectorRrf: 0.1 },
        characterCount: 19,
        tokenCount: 3,
      },
    ],
  };
}

describe("Postgres analysis evidence adapters", () => {
  it("selects attachment references only by immutable snapshot identity", async () => {
    const query = vi.fn(async () => [
      {
        attachment_id: "attachment-1",
        attachment_derivative_id: "derivative-1",
        processor_version: "processor-v1",
        output_content_hash: "a".repeat(64),
        attachment_lifecycle: "accepted",
        attachment_retention_state: "active",
        derivative_status: "completed",
        derivative_retention_state: "active",
      },
    ]);
    const store = new PostgresSnapshotAttachmentReferenceStore({
      $queryRaw: query,
    } as unknown as PrismaClient);

    await expect(
      store.listSnapshotAttachmentReferences({
        workspaceId: "workspace-1",
        caseSnapshotId: "snapshot-1",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual([
      {
        attachmentId: "attachment-1",
        derivativeId: "derivative-1",
        processorVersion: "processor-v1",
        outputContentHash: "a".repeat(64),
      },
    ]);
    const [strings, workspaceId, snapshotId] = query.mock.calls[0] ?? [];
    expect(String.raw({ raw: strings } as TemplateStringsArray)).toContain(
      "case_snapshot_attachment_references",
    );
    expect(String.raw({ raw: strings } as TemplateStringsArray)).not.toContain(
      "external_reference_id",
    );
    expect([workspaceId, snapshotId]).toEqual(["workspace-1", "snapshot-1"]);
  });

  it("fails closed rather than dropping a retention-expired captured derivative", async () => {
    const store = new PostgresSnapshotAttachmentReferenceStore({
      $queryRaw: vi.fn(async () => [
        {
          attachment_id: "attachment-1",
          attachment_derivative_id: "derivative-1",
          processor_version: "processor-v1",
          output_content_hash: "a".repeat(64),
          attachment_lifecycle: "accepted",
          attachment_retention_state: "active",
          derivative_status: "completed",
          derivative_retention_state: "deleted",
        },
      ]),
    } as unknown as PrismaClient);

    await expect(
      store.listSnapshotAttachmentReferences({
        workspaceId: "workspace-1",
        caseSnapshotId: "snapshot-1",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "analysis.attachmentEvidenceUnavailable",
      retryable: false,
    });
  });

  it("persists a retrieval selection through the injected durable service and redacts source URLs", async () => {
    const retrieve = vi.fn(async (request: RetrievalRequest) =>
      retrievalSnapshot(request),
    );
    const adapter = new PostgresAnalysisRetrievalEvidencePort({
      retrieval: { create: async () => ({ retrieve }) },
      runtime: {
        async resolve() {
          return {
            profile: retrievalProfile,
            access: { authorizedSourceIds: ["source-1"] },
          };
        },
      },
      clock: { now: () => "2026-07-15T12:01:00.000Z" },
    });

    const result = await adapter.retrieve({
      execution,
      query: "Case title\nCase summary",
      profileId: "retrieval-profile-1",
      profileVersion: "1",
      collectionIds: ["collection-1"],
      signal: new AbortController().signal,
    });

    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        attribution: { analysisJobId: "analysis-job-1" },
        snapshot: expect.objectContaining({
          analysisId: "analysis-identity-1",
          capturedAt: "2026-07-15T12:01:00.000Z",
        }),
      }),
    );
    expect(result.operationIds).toEqual([
      "operation-a",
      "operation-z",
      "operation-2",
    ]);
    expect(result.evidence[0]).toMatchObject({
      kind: "knowledge",
      itemId: "source-1",
      revisionId: "revision-1",
      chunkId: "chunk-1",
      contentHash: sha256("Knowledge evidence."),
      sourceUrl: expect.stringMatching(/^https:\/\/caseweaver\.invalid\//u),
    });
    expect(JSON.stringify(result)).not.toContain("credential");
    expect(JSON.stringify(result)).not.toContain("signature");
  });

  it("fails closed if a resolver returns a current runtime that does not match the pinned profile", async () => {
    const adapter = new PostgresAnalysisRetrievalEvidencePort({
      retrieval: { create: async () => ({ retrieve: vi.fn() }) },
      runtime: {
        async resolve() {
          return {
            profile: { ...retrievalProfile, version: "2" },
            access: { authorizedSourceIds: [] },
          };
        },
      },
      clock: { now: () => "2026-07-15T12:01:00.000Z" },
    });

    await expect(
      adapter.retrieve({
        execution,
        query: "Case title",
        profileId: "retrieval-profile-1",
        profileVersion: "1",
        collectionIds: ["collection-1"],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject<PostgresAnalysisEvidenceAdapterError>({
      code: "analysis.retrievalRuntimeMismatch",
      retryable: false,
    });
  });
});
