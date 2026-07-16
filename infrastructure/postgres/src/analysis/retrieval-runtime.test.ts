import type { AnalysisExecution } from "@caseweaver/analysis";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import type { PostgresAnalysisEvidenceAdapterError } from "./evidence-adapters.js";
import { PostgresAnalysisRetrievalRuntimeResolver } from "./retrieval-runtime.js";

const signal = new AbortController().signal;

function execution(): AnalysisExecution {
  return {
    workspaceId: "workspace-a",
    analysisJobId: "analysis-job-a",
    analysisIdentityId: "analysis-identity-a",
    analysisAttemptId: "analysis-attempt-a",
    snapshot: {
      id: "snapshot-a",
      revision: "revision-a",
      capturedAt: "2026-07-15T00:00:00.000Z",
      title: "Case",
      summary: "Summary",
      contentHash: "a".repeat(64),
      messages: [],
    },
    profile: {
      id: "analysis-profile-a",
      version: "analysis-version-a",
      analysisBindingVersionId: "analysis-binding-a",
      prompt: {
        template: {
          id: "prompt-a",
          version: "1",
          systemInstruction: "Analyze.",
        },
        schemaVersion: "case-analysis.v1",
        budgets: {
          case: { maximumCharacters: 100, maximumTokens: 100 },
          attachments: { maximumCharacters: 100, maximumTokens: 100 },
          knowledge: { maximumCharacters: 100, maximumTokens: 100 },
          repository: { maximumCharacters: 100, maximumTokens: 100 },
        },
      },
      retrieval: {
        policy: "required",
        profileId: "retrieval-profile-a",
        profileVersion: "retrieval-version-old",
        collectionIds: ["collection-a"],
        maximumQueryCharacters: 100,
      },
      attachments: { policy: "disabled" },
      repository: {
        policy: "disabled",
        maximumContextCharacters: 100,
        maximumEvidenceCharacters: 100,
      },
      generation: {
        maximumInputTokens: 100,
        maximumOutputTokens: 100,
        budget: { currency: "USD", hard: true },
      },
      repair: { maximumAttempts: 0, maximumInputCharacters: 100 },
    },
  };
}

function settings() {
  return {
    collections: [
      {
        id: "collection-a",
        embeddingBindingVersionId: "embedding-binding-a",
        embeddingProfileVersion: "embedding-profile-a",
        dimensions: 3,
      },
    ],
    policy: {
      rankConstant: 10,
      lexicalWeight: 1,
      vectorWeight: 1,
      maximumFinalResults: 5,
      maximumCharacters: 500,
      maximumTokens: 100,
      defaultSourceQuota: {
        maximumCandidates: 5,
        maximumFinalResults: 5,
      },
      sourceQuotas: [],
    },
    queryEmbedding: {
      maximumInputTokens: 20,
      budget: { currency: "USD", hard: true },
    },
    contextTokenBindingVersionId: "analysis-binding-a",
    authorizedSourceIds: ["source-a"],
    metadataFilters: { product: ["caseweaver"] },
  };
}

function clientFor(input: {
  readonly configurationId?: string;
  readonly lifecycle?: string;
  readonly resourceType?: string;
  readonly secretReferences?: readonly unknown[];
  readonly runtimeSettings?: object;
}) {
  const calls: unknown[] = [];
  const client = {
    administrationConfigurationVersion: {
      async findUnique(query: unknown) {
        calls.push(query);
        return {
          id: "retrieval-version-old",
          configurationId: input.configurationId ?? "retrieval-profile-a",
          settings: input.runtimeSettings ?? settings(),
          secretReferences: input.secretReferences ?? [],
          configuration: {
            resourceType: input.resourceType ?? "retrieval-profiles",
            lifecycle: input.lifecycle ?? "active",
          },
        };
      },
    },
  } as unknown as PrismaClient;
  return { client, calls };
}

describe("PostgresAnalysisRetrievalRuntimeResolver", () => {
  it("reads the exact pinned version without following a mutable current-version pointer", async () => {
    const fake = clientFor({});
    const resolver = new PostgresAnalysisRetrievalRuntimeResolver(fake.client);

    await expect(
      resolver.resolve({
        execution: execution(),
        profileId: "retrieval-profile-a",
        profileVersion: "retrieval-version-old",
        collectionIds: ["collection-a"],
        signal,
      }),
    ).resolves.toMatchObject({
      profile: {
        id: "retrieval-profile-a",
        version: "retrieval-version-old",
        contextTokenBindingVersionId: "analysis-binding-a",
      },
      access: { authorizedSourceIds: ["source-a"] },
    });
    expect(fake.calls[0]).toMatchObject({
      where: {
        workspaceId_id: {
          workspaceId: "workspace-a",
          id: "retrieval-version-old",
        },
      },
    });
    expect(JSON.stringify(fake.calls[0])).not.toContain("currentVersionId");
  });

  it("fails closed for a mismatched aggregate, secret metadata, or expanded collection set", async () => {
    const aggregateMismatch = new PostgresAnalysisRetrievalRuntimeResolver(
      clientFor({ configurationId: "other-profile" }).client,
    );
    await expect(
      aggregateMismatch.resolve({
        execution: execution(),
        profileId: "retrieval-profile-a",
        profileVersion: "retrieval-version-old",
        collectionIds: ["collection-a"],
        signal,
      }),
    ).rejects.toMatchObject<PostgresAnalysisEvidenceAdapterError>({
      code: "analysis.retrievalRuntimeUnavailable",
      retryable: false,
    });

    const secrets = new PostgresAnalysisRetrievalRuntimeResolver(
      clientFor({ secretReferences: ["vault:should-not-be-here"] }).client,
    );
    await expect(
      secrets.resolve({
        execution: execution(),
        profileId: "retrieval-profile-a",
        profileVersion: "retrieval-version-old",
        collectionIds: ["collection-a"],
        signal,
      }),
    ).rejects.toMatchObject<PostgresAnalysisEvidenceAdapterError>({
      code: "analysis.retrievalRuntimeUnavailable",
    });

    const resolver = new PostgresAnalysisRetrievalRuntimeResolver(
      clientFor({}).client,
    );
    await expect(
      resolver.resolve({
        execution: execution(),
        profileId: "retrieval-profile-a",
        profileVersion: "retrieval-version-old",
        collectionIds: ["collection-a", "collection-b"],
        signal,
      }),
    ).rejects.toMatchObject<PostgresAnalysisEvidenceAdapterError>({
      code: "analysis.retrievalRuntimeMismatch",
      retryable: false,
    });
  });
});
