import type {
  AiExecutionContext,
  AiExecutionGateway,
  MeteredAiRequest,
  MeteredAiResult,
} from "@caseweaver/ai-execution";
import {
  type DiscoveryPage,
  type ExternalReference,
  type KnowledgeDocument,
  type KnowledgeSource,
  versionedOpaqueValue,
} from "@caseweaver/connector-sdk";
import { describe, expect, it } from "vitest";

import {
  type CachedEmbedding,
  type EmbeddingCacheIdentity,
  embeddingCacheIdentityKey,
  type FailedRevisionDiagnostic,
  KnowledgeIngestionError,
  KnowledgeIngestionService,
  type KnowledgeIngestionStore,
  type KnowledgeMutation,
  type KnowledgeSynchronizationRequest,
  type NewCachedEmbedding,
  normalizedContentHash,
  type StoredKnowledgeItem,
} from "./index.js";

const reference: ExternalReference = {
  connectorInstanceId: "connector-1",
  resourceType: "document",
  externalId: "guide-1",
};

const activeEmbeddingSpace = {
  embeddingBindingVersionId: "binding.v1",
  embeddingProfileVersion: "embedding.v1",
  dimensions: 3,
  normalizationProfileVersion: "normalization.v1",
} as const;

function document(body: string): KnowledgeDocument {
  return {
    reference,
    body: { format: "markdown", normalizedText: body },
    attachments: [],
  };
}

class Source implements KnowledgeSource {
  public loads = 0;

  public constructor(
    private readonly pages: readonly DiscoveryPage<
      Readonly<{
        reference: ExternalReference;
        fingerprint?: ReturnType<typeof versionedOpaqueValue>;
      }>
    >[],
    private readonly loaded: KnowledgeDocument,
  ) {}

  public async *discover(): AsyncIterable<
    DiscoveryPage<
      Readonly<{
        reference: ExternalReference;
        fingerprint?: ReturnType<typeof versionedOpaqueValue>;
      }>
    >
  > {
    yield* this.pages;
  }

  public async load(): Promise<KnowledgeDocument> {
    this.loads += 1;
    return this.loaded;
  }
}

class Store implements KnowledgeIngestionStore {
  public readonly items = new Map<string, StoredKnowledgeItem>();
  public readonly cache = new Map<string, CachedEmbedding>();
  public readonly commits: {
    mutations: readonly KnowledgeMutation[];
    newEmbeddings: readonly NewCachedEmbedding[];
  }[] = [];
  public readonly failures: FailedRevisionDiagnostic[] = [];

  public async findItem(input: {
    readonly reference: ExternalReference;
  }): Promise<StoredKnowledgeItem | undefined> {
    return this.items.get(input.reference.externalId);
  }

  public async findReusableEmbeddings(input: {
    readonly identities: readonly EmbeddingCacheIdentity[];
  }): Promise<readonly CachedEmbedding[]> {
    return input.identities.flatMap((identity) => {
      const entry = this.cache.get(embeddingCacheIdentityKey(identity));
      return entry === undefined ? [] : [entry];
    });
  }

  public async commit(input: {
    readonly mutations: readonly KnowledgeMutation[];
    readonly newEmbeddings: readonly NewCachedEmbedding[];
  }): Promise<void> {
    this.commits.push(input);
    for (const embedding of input.newEmbeddings) {
      this.cache.set(embeddingCacheIdentityKey(embedding.identity), embedding);
    }
    for (const mutation of input.mutations) {
      if (mutation.kind === "tombstone") {
        const prior = this.items.get(mutation.reference.externalId);
        if (prior !== undefined) {
          this.items.set(mutation.reference.externalId, {
            ...prior,
            activeRevisionId: undefined,
          });
        }
      } else if (mutation.kind === "activate") {
        this.items.set(mutation.reference.externalId, {
          documentId: `document:${mutation.reference.externalId}`,
          activeRevisionId: mutation.revisionId,
          activeContentHash: mutation.contentHash,
          activeEmbeddingSpace: mutation.embeddingSpace,
          lastSuccessfulFingerprint: mutation.fingerprint,
        });
      } else {
        const prior = this.items.get(mutation.reference.externalId);
        if (prior !== undefined) {
          this.items.set(mutation.reference.externalId, {
            ...prior,
            activeContentHash: mutation.contentHash ?? prior.activeContentHash,
            lastSuccessfulFingerprint: mutation.fingerprint,
          });
        }
      }
    }
  }

  public async recordFailedRevision(
    diagnostic: FailedRevisionDiagnostic,
  ): Promise<void> {
    this.failures.push(diagnostic);
  }
}

class Gateway implements AiExecutionGateway {
  public readonly inputs: string[][] = [];
  public fail = false;

  public async execute<TResult = unknown>(
    request: MeteredAiRequest,
    _context: AiExecutionContext,
  ): Promise<MeteredAiResult<TResult>> {
    if (this.fail) {
      throw new Error("embedding failed");
    }
    if (request.kind !== "embedding") {
      throw new Error("Unexpected AI operation.");
    }
    this.inputs.push([...request.request.input]);
    const vectors = request.request.input.map((text) => [
      text.length,
      text.length + 1,
      text.length + 2,
    ]);
    return {
      operationId: `operation-${this.inputs.length}`,
      value: { vectors } as TResult,
      usage: { inputTokens: request.request.input.length * 10 },
      calculatedCost: {
        status: "known",
        amount: "0.001",
        currency: "USD",
        components: [],
      },
    };
  }
}

function request(
  source: KnowledgeSource,
  fingerprint = versionedOpaqueValue("etag.v1", "1"),
): KnowledgeSynchronizationRequest {
  return {
    source,
    signal: new AbortController().signal,
    configuration: {
      id: "source-1",
      workspaceId: "workspace-1",
      connectorInstanceId: reference.connectorInstanceId,
      normalizationProfileVersion: "normalization.v1",
      chunkingProfileVersion: "chunking.v1",
      embeddingBatchSize: 10,
      synchronization: { triggers: [{ mode: "manual" }] },
      collection: {
        id: "collection-1",
        embeddingBindingVersionId: "binding.v1",
        embeddingProfileVersion: "embedding.v1",
        dimensions: 3,
        maximumInputTokens: 100,
        budget: { currency: "USD", hard: false },
      },
    },
    cursor: fingerprint,
  };
}

function snapshot(
  fingerprint = versionedOpaqueValue("etag.v1", "1"),
  complete = true,
): readonly DiscoveryPage<
  Readonly<{
    reference: ExternalReference;
    fingerprint?: ReturnType<typeof versionedOpaqueValue>;
  }>
>[] {
  return [
    {
      mode: "snapshot",
      scanEpoch: versionedOpaqueValue("scan.v1", "epoch-1"),
      items: [{ reference, fingerprint }],
      complete,
    },
  ];
}

function service(store: Store, gateway: Gateway): KnowledgeIngestionService {
  let revision = 0;
  return new KnowledgeIngestionService({
    store,
    ai: gateway,
    ids: { next: () => `revision-${++revision}` },
    clock: { now: () => "2026-07-13T20:00:00.000Z" },
    normalizer: {
      normalize: async ({ document: loaded }) => ({
        normalizedText: loaded.body.normalizedText,
      }),
    },
    chunker: {
      chunk: async ({ document: normalized }) =>
        normalized.normalizedText.split("|").map((content) => ({ content })),
    },
  });
}

describe("KnowledgeIngestionService", () => {
  it("stops at an identical opaque fingerprint before load or AI", async () => {
    const store = new Store();
    const gateway = new Gateway();
    store.items.set(reference.externalId, {
      documentId: "document-1",
      activeRevisionId: "revision-1",
      activeContentHash: "unchanged",
      activeEmbeddingSpace,
      lastSuccessfulFingerprint: versionedOpaqueValue("etag.v1", "1"),
    });
    const source = new Source(snapshot(), document("new content"));

    const result = await service(store, gateway).synchronize(request(source));

    expect(result.fingerprintNoops).toBe(1);
    expect(source.loads).toBe(0);
    expect(gateway.inputs).toEqual([]);
    expect(store.commits[0]?.mutations[0]).toMatchObject({ kind: "observe" });
  });

  it("records a changed observation without chunks or embeddings when normalized content is unchanged", async () => {
    const store = new Store();
    const gateway = new Gateway();
    const contentHash = normalizedContentHash("normalization.v1", {
      normalizedText: "same searchable content",
    });
    store.items.set(reference.externalId, {
      documentId: "document-1",
      activeRevisionId: "revision-1",
      activeContentHash: contentHash,
      activeEmbeddingSpace,
      lastSuccessfulFingerprint: versionedOpaqueValue("etag.v1", "1"),
    });
    const source = new Source(
      snapshot(versionedOpaqueValue("etag.v1", "2")),
      document("same searchable content"),
    );

    const result = await service(store, gateway).synchronize(
      request(source, versionedOpaqueValue("etag.v1", "2")),
    );

    expect(source.loads).toBe(1);
    expect(result.normalizedNoops).toBe(1);
    expect(result.activatedRevisions).toBe(0);
    expect(gateway.inputs).toEqual([]);
    expect(store.commits[0]?.newEmbeddings).toEqual([]);
  });

  it("embeds only changed chunks and binds cache entries to the embedding identity", async () => {
    const store = new Store();
    const gateway = new Gateway();
    const initial = new Source(snapshot(), document("stable|changed-one"));
    const ingestion = service(store, gateway);
    await ingestion.synchronize(request(initial));
    const updated = new Source(
      snapshot(versionedOpaqueValue("etag.v1", "2")),
      document("stable|changed-two"),
    );

    const result = await ingestion.synchronize(
      request(updated, versionedOpaqueValue("etag.v1", "2")),
    );

    expect(result.embeddedChunks).toBe(1);
    expect(gateway.inputs).toEqual([
      ["stable", "changed-one"],
      ["changed-two"],
    ]);
    const newEmbedding = store.commits[1]?.newEmbeddings[0];
    expect(newEmbedding?.identity).toMatchObject({
      embeddingBindingVersionId: "binding.v1",
      embeddingProfileVersion: "embedding.v1",
      dimensions: 3,
      normalizationProfileVersion: "normalization.v1",
    });
  });

  it("retains the prior active revision when replacement embedding fails", async () => {
    const store = new Store();
    const gateway = new Gateway();
    const ingestion = service(store, gateway);
    await ingestion.synchronize(
      request(new Source(snapshot(), document("stable|old"))),
    );
    const prior = store.items.get(reference.externalId)?.activeRevisionId;
    gateway.fail = true;

    await expect(
      ingestion.synchronize(
        request(
          new Source(
            snapshot(versionedOpaqueValue("etag.v1", "2")),
            document("stable|new"),
          ),
          versionedOpaqueValue("etag.v1", "2"),
        ),
      ),
    ).rejects.toThrow("embedding failed");

    expect(store.items.get(reference.externalId)?.activeRevisionId).toBe(prior);
    expect(store.failures).toHaveLength(1);
    expect(store.failures[0]).toMatchObject({ stage: "embedding" });
    expect(store.commits).toHaveLength(1);
  });

  it("re-embeds unchanged content when a source targets a new collection binding", async () => {
    const store = new Store();
    const gateway = new Gateway();
    const ingestion = service(store, gateway);
    await ingestion.synchronize(
      request(new Source(snapshot(), document("stable content"))),
    );
    const changedBindingRequest = request(
      new Source(snapshot(), document("stable content")),
    );

    await ingestion.synchronize({
      ...changedBindingRequest,
      configuration: {
        ...changedBindingRequest.configuration,
        collection: {
          ...changedBindingRequest.configuration.collection,
          id: "collection-2",
          embeddingBindingVersionId: "binding.v2",
        },
      },
    });

    expect(gateway.inputs).toEqual([["stable content"], ["stable content"]]);
    expect(store.commits[1]?.newEmbeddings[0]?.identity).toMatchObject({
      embeddingBindingVersionId: "binding.v2",
    });
  });

  it("does not commit an incomplete snapshot, while delta tombstones are explicit mutations", async () => {
    const store = new Store();
    const gateway = new Gateway();
    const incomplete = new Source(
      snapshot(undefined, false),
      document("content"),
    );

    await expect(
      service(store, gateway).synchronize(request(incomplete)),
    ).rejects.toBeInstanceOf(KnowledgeIngestionError);
    expect(store.commits).toHaveLength(0);

    const delta: readonly DiscoveryPage<
      Readonly<{
        reference: ExternalReference;
        fingerprint?: ReturnType<typeof versionedOpaqueValue>;
      }>
    >[] = [
      {
        mode: "delta",
        events: [{ kind: "tombstone", reference }],
        complete: true,
      },
    ];
    const result = await service(store, gateway).synchronize(
      request(new Source(delta, document("unused"))),
    );
    expect(result.tombstones).toBe(1);
    expect(store.commits[0]?.mutations).toEqual([
      expect.objectContaining({ kind: "tombstone", reference }),
    ]);
  });

  it("does not commit any snapshot mutations or cursor state when scan epochs change", async () => {
    const store = new Store();
    const gateway = new Gateway();
    const pages: readonly DiscoveryPage<
      Readonly<{
        reference: ExternalReference;
        fingerprint?: ReturnType<typeof versionedOpaqueValue>;
      }>
    >[] = [
      {
        mode: "snapshot",
        scanEpoch: versionedOpaqueValue("scan.v1", "epoch-1"),
        items: [
          { reference, fingerprint: versionedOpaqueValue("etag.v1", "1") },
        ],
        nextCursor: versionedOpaqueValue("cursor.v1", "cursor-1"),
        complete: false,
      },
      {
        mode: "snapshot",
        scanEpoch: versionedOpaqueValue("scan.v1", "epoch-2"),
        items: [],
        nextCursor: versionedOpaqueValue("cursor.v1", "cursor-2"),
        complete: true,
      },
    ];

    await expect(
      service(store, gateway).synchronize(
        request(new Source(pages, document("content"))),
      ),
    ).rejects.toMatchObject({ code: "knowledge.invalidDiscovery" });

    expect(store.commits).toEqual([]);
  });
});
