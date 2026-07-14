import type {
  AiExecutionContext,
  AiExecutionGateway,
  MeteredAiRequest,
  MeteredAiResult,
} from "@caseweaver/ai-execution";
import { describe, expect, it } from "vitest";

import type {
  RetrievalCandidate,
  RetrievalProfile,
  RetrievalRequest,
} from "./contracts.js";
import {
  DeterministicRetrievalSearchPort,
  InMemoryRetrievalSnapshotPort,
  WhitespaceTokenCounter,
} from "./fakes.js";
import { RetrievalService } from "./service.js";

class FakeAiGateway implements AiExecutionGateway {
  public readonly calls: MeteredAiRequest[] = [];

  public async execute<TResult = unknown>(
    request: MeteredAiRequest,
    _context: AiExecutionContext,
  ): Promise<MeteredAiResult<TResult>> {
    this.calls.push(request);
    const value: unknown =
      request.kind === "embedding"
        ? { vectors: [[0.1, 0.2]] }
        : request.kind === "reranker"
          ? {
              scores: request.request.documents.map(
                (_document, index) => index * 10,
              ),
            }
          : undefined;
    return {
      operationId: `operation-${this.calls.length}`,
      value: value as TResult,
      calculatedCost: { status: "unknown", components: [] },
    };
  }
}

const controller = new AbortController();

function profile(overrides: Partial<RetrievalProfile> = {}): RetrievalProfile {
  return {
    id: "retrieval.v1",
    version: "1",
    collections: [
      {
        id: "docs",
        embeddingBindingVersionId: "embedding.v1",
        embeddingProfileVersion: "profile.v1",
        dimensions: 2,
      },
      {
        id: "cases",
        embeddingBindingVersionId: "embedding.v1",
        embeddingProfileVersion: "profile.v1",
        dimensions: 2,
      },
    ],
    policy: {
      rankConstant: 10,
      lexicalWeight: 1,
      vectorWeight: 1,
      maximumFinalResults: 5,
      maximumCharacters: 1_000,
      maximumTokens: 100,
      defaultSourceQuota: {
        maximumCandidates: 5,
        maximumFinalResults: 5,
      },
      sourceQuotas: [],
    },
    queryEmbedding: {
      maximumInputTokens: 10,
      budget: { currency: "USD", hard: false },
    },
    ...overrides,
  };
}

function candidate(
  sourceId: string,
  chunkId: string,
  ranks: Pick<RetrievalCandidate, "lexicalRank" | "vectorRank">,
  options: Partial<RetrievalCandidate> = {},
): RetrievalCandidate {
  return {
    collectionId: sourceId === "cases" ? "cases" : "docs",
    sourceId,
    sourceRevisionId: "revision-1",
    chunkId,
    location: `#${chunkId}`,
    sourceUrl: `https://example.invalid/${chunkId}`,
    content: `${sourceId} ${chunkId}`,
    activeRevision: true,
    accessMetadata: {},
    ...ranks,
    ...options,
  };
}

function request(
  configuredProfile: RetrievalProfile,
  snapshotId = "snapshot-1",
): RetrievalRequest {
  return {
    workspaceId: "workspace-1",
    query: "find an answer",
    profile: configuredProfile,
    access: { authorizedSourceIds: ["docs", "cases", "alpha", "zeta"] },
    snapshot: {
      id: snapshotId,
      analysisId: "analysis-1",
      capturedAt: "2026-07-14T14:00:00.000Z",
    },
    signal: controller.signal,
  };
}

function serviceFor(candidates: readonly RetrievalCandidate[]) {
  const search = new DeterministicRetrievalSearchPort(candidates);
  const snapshots = new InMemoryRetrievalSnapshotPort();
  const ai = new FakeAiGateway();
  return {
    search,
    snapshots,
    ai,
    service: new RetrievalService({
      search,
      snapshots,
      ai,
      tokens: new WhitespaceTokenCounter(),
    }),
  };
}

describe("RetrievalService", () => {
  it("creates one query embedding per binding and reuses it for compatible collections", async () => {
    const base = profile();
    const configured = profile({
      collections: [
        ...base.collections,
        {
          id: "operations",
          embeddingBindingVersionId: "embedding.v2",
          embeddingProfileVersion: "profile.v2",
          dimensions: 2,
        },
      ],
    });
    const harness = serviceFor([
      candidate("docs", "one", { lexicalRank: 1 }),
      candidate("cases", "two", { vectorRank: 1 }),
    ]);

    await harness.service.retrieve(request(configured));

    expect(harness.ai.calls).toHaveLength(2);
    expect(harness.ai.calls[0]).toMatchObject({
      kind: "embedding",
      bindingVersionId: "embedding.v1",
      request: { input: ["find an answer"], dimensions: 2 },
    });
    expect(harness.ai.calls[1]).toMatchObject({
      kind: "embedding",
      bindingVersionId: "embedding.v2",
    });
    const searchRequest = harness.search.requests[0];
    expect(searchRequest).toBeDefined();
    expect(searchRequest?.vectorQueries).toEqual([
      expect.objectContaining({ collectionIds: ["cases", "docs"] }),
      expect.objectContaining({ collectionIds: ["operations"] }),
    ]);
    expect(searchRequest?.maximumCandidatesPerSource).toBe(5);
  });

  it("fuses ranks, deduplicates, breaks ties, filters access, and applies source quotas", async () => {
    const configured = profile({
      policy: {
        ...profile().policy,
        maximumFinalResults: 3,
        sourceQuotas: [
          {
            sourceId: "docs",
            maximumCandidates: 1,
            maximumFinalResults: 1,
          },
        ],
      },
    });
    const harness = serviceFor([
      candidate("docs", "first", { lexicalRank: 1 }),
      candidate("docs", "second", { lexicalRank: 2 }),
      candidate("cases", "both", { lexicalRank: 2 }),
      candidate("cases", "both", { vectorRank: 1 }),
      candidate("zeta", "tied", { lexicalRank: 3 }),
      candidate("alpha", "tied", { lexicalRank: 3 }),
      candidate("denied", "hidden", { lexicalRank: 1 }),
      candidate(
        "cases",
        "inactive",
        { lexicalRank: 1 },
        { activeRevision: false },
      ),
    ]);

    const snapshot = await harness.service.retrieve(request(configured));

    expect(snapshot.evidence.map((entry) => entry.chunkId)).toEqual([
      "both",
      "first",
      "tied",
    ]);
    expect(snapshot.evidence[0]?.scores).toMatchObject({
      lexicalRrf: 1 / 12,
      vectorRrf: 1 / 11,
    });
    expect(
      snapshot.evidence.filter((entry) => entry.sourceId === "docs"),
    ).toHaveLength(1);
    expect(snapshot.evidence[2]?.sourceId).toBe("alpha");
    expect(snapshot.evidence.some((entry) => entry.chunkId === "hidden")).toBe(
      false,
    );
    expect(
      snapshot.evidence.some((entry) => entry.chunkId === "inactive"),
    ).toBe(false);
  });

  it("reranks only a token- and count-bounded RRF candidate set", async () => {
    const configured = profile({
      reranker: {
        bindingVersionId: "reranker.v1",
        maximumCandidates: 2,
        maximumInputTokens: 10,
        budget: { currency: "USD", hard: false },
      },
    });
    const harness = serviceFor([
      candidate("docs", "first", { lexicalRank: 1 }),
      candidate("cases", "second", { lexicalRank: 2 }),
      candidate("alpha", "third", { lexicalRank: 3 }),
    ]);

    const snapshot = await harness.service.retrieve(request(configured));

    const reranker = harness.ai.calls.find((call) => call.kind === "reranker");
    expect(reranker).toBeDefined();
    if (reranker?.kind !== "reranker")
      throw new Error("Expected reranker call.");
    expect(reranker.request.documents).toHaveLength(2);
    expect(snapshot.rerankerOperationId).toBe("operation-2");
    expect(snapshot.evidence.map((entry) => entry.chunkId)).toEqual([
      "second",
      "first",
    ]);
  });

  it("deterministically skips evidence that exceeds character or token context budgets", async () => {
    const configured = profile({
      policy: {
        ...profile().policy,
        maximumCharacters: 8,
        maximumTokens: 2,
      },
    });
    const harness = serviceFor([
      candidate("docs", "first", { lexicalRank: 1 }, { content: "one two" }),
      candidate(
        "cases",
        "second",
        { lexicalRank: 2 },
        { content: "three four" },
      ),
    ]);

    const snapshot = await harness.service.retrieve(request(configured));

    expect(snapshot.evidence.map((entry) => entry.content)).toEqual([
      "one two",
    ]);
    expect(snapshot.evidence[0]?.characterCount).toBe(7);
    expect(snapshot.evidence[0]?.tokenCount).toBe(2);
  });

  it("persists a frozen immutable snapshot and rejects a repeated snapshot ID", async () => {
    const harness = serviceFor([candidate("docs", "one", { lexicalRank: 1 })]);
    const configured = profile();

    const snapshot = await harness.service.retrieve(request(configured));

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.evidence)).toBe(true);
    expect(Object.isFrozen(snapshot.evidence[0] ?? {})).toBe(true);
    await expect(harness.service.retrieve(request(configured))).rejects.toThrow(
      'Retrieval snapshot "snapshot-1" already exists.',
    );
  });
});
