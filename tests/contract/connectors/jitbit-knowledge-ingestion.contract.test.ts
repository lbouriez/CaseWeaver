import type {
  AiExecutionContext,
  AiExecutionGateway,
  MeteredAiRequest,
  MeteredAiResult,
} from "../../../packages/ai-execution/src/index.js";
import {
  type CachedEmbedding,
  type EmbeddingCacheIdentity,
  type FailedRevisionDiagnostic,
  KnowledgeIngestionService,
  type KnowledgeIngestionStore,
  type KnowledgeMutation,
  type NewCachedEmbedding,
  normalizedContentHash,
  type StoredKnowledgeItem,
} from "../../../packages/knowledge/src/index.js";
import { describe, expect, it } from "vitest";

import {
  createJitbitConfiguration,
  createJitbitSecretResolver,
  JitbitAnalysisDestination,
  JitbitClient,
  JitbitKnowledgeSource,
  jsonResponse,
} from "../../../connectors/jitbit/src/index.js";

const reference = {
  connectorInstanceId: "jitbit-helpdesk",
  resourceType: "resolved-case",
  externalId: "7",
} as const;

const activeEmbeddingSpace = {
  embeddingBindingVersionId: "binding.v1",
  embeddingProfileVersion: "embedding.v1",
  dimensions: 3,
  normalizationProfileVersion: "normalization.v1",
} as const;

class Store implements KnowledgeIngestionStore {
  public readonly commits: {
    readonly mutations: readonly KnowledgeMutation[];
    readonly newEmbeddings: readonly NewCachedEmbedding[];
  }[] = [];

  public constructor(private readonly item: StoredKnowledgeItem) {}

  public async findItem(): Promise<StoredKnowledgeItem> {
    return this.item;
  }

  public async findReusableEmbeddings(_input: {
    readonly identities: readonly EmbeddingCacheIdentity[];
  }): Promise<readonly CachedEmbedding[]> {
    throw new Error("A no-op must not look up embeddings.");
  }

  public async commit(input: {
    readonly mutations: readonly KnowledgeMutation[];
    readonly newEmbeddings: readonly NewCachedEmbedding[];
  }): Promise<void> {
    this.commits.push(input);
  }

  public async recordFailedRevision(
    _diagnostic: FailedRevisionDiagnostic,
  ): Promise<void> {
    throw new Error("A no-op must not record a failed revision.");
  }
}

class ForbiddenAiGateway implements AiExecutionGateway {
  public calls = 0;

  public async execute<TResult = unknown>(
    _request: MeteredAiRequest,
    _context: AiExecutionContext,
  ): Promise<MeteredAiResult<TResult>> {
    this.calls += 1;
    throw new Error("A no-op must not invoke AI.");
  }
}

function sourceFor(
  responder: (url: URL, init: RequestInit) => Response | Promise<Response>,
): JitbitKnowledgeSource {
  const configuration = createJitbitConfiguration();
  return new JitbitKnowledgeSource({
    configuration,
    client: new JitbitClient({
      configuration,
      secrets: createJitbitSecretResolver(),
      fetch: async (url, init) => responder(new URL(String(url)), init),
    }),
    now: () => new Date("2026-07-13T20:00:00.000Z"),
  });
}

function destinationFor(
  responder: (url: URL, init: RequestInit) => Response | Promise<Response>,
): JitbitAnalysisDestination {
  const configuration = createJitbitConfiguration();
  return new JitbitAnalysisDestination({
    configuration,
    client: new JitbitClient({
      configuration,
      secrets: createJitbitSecretResolver(),
      fetch: async (url, init) => responder(new URL(String(url)), init),
    }),
  });
}

function synchronization(
  store: Store,
  ai: ForbiddenAiGateway,
): KnowledgeIngestionService {
  return new KnowledgeIngestionService({
    store,
    ai,
    ids: { next: () => "unused-revision" },
    clock: { now: () => "2026-07-13T20:00:00.000Z" },
    normalizer: {
      normalize: async () => ({ normalizedText: "same searchable content" }),
    },
    chunker: {
      chunk: async () => {
        throw new Error("A no-op must not chunk content.");
      },
    },
  });
}

function request(source: JitbitKnowledgeSource) {
  return {
    source,
    signal: new AbortController().signal,
    configuration: {
      id: "jitbit-knowledge",
      workspaceId: "workspace-1",
      connectorInstanceId: "jitbit-helpdesk",
      normalizationProfileVersion: "normalization.v1",
      chunkingProfileVersion: "chunking.v1",
      embeddingBatchSize: 10,
      synchronization: { triggers: [{ mode: "manual" as const }] },
      collection: {
        id: "collection-1",
        ...activeEmbeddingSpace,
        maximumInputTokens: 100,
        budget: { currency: "USD", hard: false },
      },
    },
  };
}

describe("Jitbit knowledge ingestion contract", () => {
  it("authenticates discovery with the resolved secret", async () => {
    const authorizations: (string | null)[] = [];
    const source = sourceFor((_url, init) => {
      authorizations.push(new Headers(init.headers).get("authorization"));
      return jsonResponse([]);
    });

    for await (const _page of source.discover({
      signal: new AbortController().signal,
    })) {
      // Fully consume the source request.
    }

    expect(authorizations).toEqual(["Bearer test-token"]);
  });

  it("reconciles a publication marker only on its requested target case", async () => {
    const requests: URL[] = [];
    const destination = destinationFor((url) => {
      requests.push(url);
      return jsonResponse([
        {
          CommentID: 44,
          Body: "Published <!-- caseweaver-publication:analysis-7 -->",
        },
      ]);
    });

    await expect(
      destination.findPublication({
        target: {
          connectorInstanceId: "jitbit-helpdesk",
          resourceType: "case",
          externalId: "target-case-7",
        },
        marker: { value: "analysis-7" },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      reference: {
        connectorInstanceId: "jitbit-helpdesk",
        resourceType: "comment",
        externalId: "44",
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe("/api/comments");
    expect(requests[0]?.searchParams.get("id")).toBe("target-case-7");
  });

  it("observes an unchanged Jitbit fingerprint without loading or invoking AI", async () => {
    const requests: string[] = [];
    const source = sourceFor((url) => {
      requests.push(url.pathname);
      return jsonResponse([
        {
          IssueID: 7,
          Status: "Resolved",
          LastUpdated: "2026-07-13T12:00:00Z",
        },
      ]);
    });
    const store = new Store({
      documentId: "document:7",
      activeRevisionId: "revision:7",
      activeContentHash: "existing-content",
      activeEmbeddingSpace,
      lastSuccessfulFingerprint: {
        version: "jitbit.last-updated.v1",
        value: "2026-07-13T12:00:00.000Z",
      },
    });
    const ai = new ForbiddenAiGateway();

    const result = await synchronization(store, ai).synchronize(
      request(source),
    );

    expect(result).toMatchObject({
      mode: "delta",
      processed: 1,
      fingerprintNoops: 1,
      normalizedNoops: 0,
      embeddedChunks: 0,
    });
    expect(requests).toEqual(["/api/Tickets"]);
    expect(ai.calls).toBe(0);
    expect(store.commits[0]?.mutations).toEqual([
      expect.objectContaining({ kind: "observe", reference }),
    ]);
  });

  it("records a changed Jitbit observation without AI when normalized content is unchanged", async () => {
    const requests: string[] = [];
    const source = sourceFor((url) => {
      requests.push(url.pathname);
      if (url.pathname === "/api/Tickets") {
        return jsonResponse([
          {
            IssueID: 7,
            Status: "Resolved",
            LastUpdated: "2026-07-13T13:00:00Z",
          },
        ]);
      }
      if (url.pathname === "/api/ticket") {
        return jsonResponse({
          IssueID: 7,
          Status: "Resolved",
          Body: "<p>same searchable content</p>",
        });
      }
      return jsonResponse([]);
    });
    const store = new Store({
      documentId: "document:7",
      activeRevisionId: "revision:7",
      activeContentHash: normalizedContentHash("normalization.v1", {
        normalizedText: "same searchable content",
      }),
      activeEmbeddingSpace,
      lastSuccessfulFingerprint: {
        version: "jitbit.last-updated.v1",
        value: "2026-07-13T12:00:00.000Z",
      },
    });
    const ai = new ForbiddenAiGateway();

    const result = await synchronization(store, ai).synchronize(
      request(source),
    );

    expect(result).toMatchObject({
      processed: 1,
      fingerprintNoops: 0,
      normalizedNoops: 1,
      embeddedChunks: 0,
    });
    expect(requests).toEqual(["/api/Tickets", "/api/ticket", "/api/comments"]);
    expect(ai.calls).toBe(0);
    expect(store.commits[0]?.mutations).toEqual([
      expect.objectContaining({
        kind: "observe",
        reference,
        fingerprint: {
          version: "jitbit.last-updated.v1",
          value: "2026-07-13T13:00:00.000Z",
        },
      }),
    ]);
  });
});
