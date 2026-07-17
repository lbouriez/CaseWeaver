import type {
  AiExecutionContext,
  AiExecutionGateway,
  MeteredAiRequest,
  MeteredAiResult,
} from "@caseweaver/ai-execution";
import {
  type DiscoveredKnowledgeItem,
  type DiscoveryPage,
  type ExternalReference,
  type KnowledgeDocument,
  type KnowledgeSource,
  type LoadKnowledgeRequest,
  versionedOpaqueValue,
} from "@caseweaver/connector-sdk";
import { describe, expect, it } from "vitest";

import {
  type AttachmentPreparationPolicy,
  type AttachmentPreparationPort,
  type AttachmentPreparationResult,
  attachmentPreparationIdentityHash,
  attachmentPreparationPolicyIdentityHash,
  type CachedEmbedding,
  type EmbeddingCacheIdentity,
  embeddingCacheIdentityKey,
  type FailedRevisionDiagnostic,
  ImmutableKnowledgeTextProfileRegistry,
  KnowledgeIngestionError,
  KnowledgeIngestionService,
  type KnowledgeIngestionStore,
  type KnowledgeMutation,
  type KnowledgeSynchronizationRequest,
  type NewCachedEmbedding,
  type NormalizedKnowledgeDocument,
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
  public readonly loadRequests: LoadKnowledgeRequest[] = [];

  public constructor(
    private readonly pages: readonly DiscoveryPage<DiscoveredKnowledgeItem>[],
    private readonly loaded: KnowledgeDocument,
  ) {}

  public async *discover(): AsyncIterable<
    DiscoveryPage<DiscoveredKnowledgeItem>
  > {
    yield* this.pages;
  }

  public async load(request: LoadKnowledgeRequest): Promise<KnowledgeDocument> {
    this.loads += 1;
    this.loadRequests.push(request);
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
          activeAttachmentPreparationPolicyIdentity:
            mutation.attachmentPreparationPolicyIdentity,
          activeAttachmentPreparationRetryRequired:
            mutation.attachmentPreparation?.retryRequired,
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
  public pricingStatus: "known" | "unknown" = "known";

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
      calculatedCost:
        this.pricingStatus === "known"
          ? {
              status: "known",
              amount: "0.001",
              currency: "USD",
              components: [],
            }
          : { status: "unknown", components: [] },
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
      normalizationProfileId: "normalization",
      normalizationProfileVersion: "normalization.v1",
      chunkingProfileId: "chunking",
      chunkingProfileVersion: "chunking.v1",
      embeddingBatchSize: 10,
      attachmentPreparationPins: {
        sourceConfigurationVersionId: "source-config-v1",
        connectorRegistrationId: reference.connectorInstanceId,
        connectorConfigurationVersionId: "connector-config-v1",
      },
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
    discovery: {
      mode: "incremental",
      reset: false,
      cursor: fingerprint,
      signal: new AbortController().signal,
    },
    fence: { value: "1" },
  };
}

function snapshot(
  fingerprint = versionedOpaqueValue("etag.v1", "1"),
  complete = true,
  item: Omit<DiscoveredKnowledgeItem, "reference" | "fingerprint"> = {},
): readonly DiscoveryPage<DiscoveredKnowledgeItem>[] {
  return [
    {
      mode: "snapshot",
      scanEpoch: versionedOpaqueValue("scan.v1", "epoch-1"),
      items: [{ reference, fingerprint, ...item }],
      complete,
    },
  ];
}

function attachmentPreparationResult(input: {
  readonly policy: AttachmentPreparationPolicy;
  readonly derivatives?: AttachmentPreparationResult["derivatives"];
  readonly warnings?: AttachmentPreparationResult["outcome"]["warnings"];
}): AttachmentPreparationResult {
  const derivatives = input.derivatives ?? [];
  const warnings = input.warnings ?? [];
  const selectedDerivatives = derivatives.map((derivative) => ({
    occurrenceIdentity: derivative.occurrenceIdentity,
    derivativeIdentity: derivative.derivativeIdentity,
    derivativeContentHash: derivative.derivativeContentHash,
  }));
  const retryRequired = warnings.some((warning) => warning.retryable);
  return {
    outcome: {
      status:
        input.policy.mode === "required" && warnings.length > 0
          ? "terminal"
          : "prepared",
      identityHash: attachmentPreparationIdentityHash({
        policy: input.policy,
        selectedDerivatives,
        warnings,
      }),
      policy: input.policy,
      selectedDerivatives,
      warnings,
      retryRequired,
    },
    derivatives,
  };
}

class AttachmentPreparation implements AttachmentPreparationPort {
  public calls = 0;

  public constructor(private readonly results: AttachmentPreparationResult[]) {}

  public async prepare(): Promise<AttachmentPreparationResult> {
    this.calls += 1;
    const result = this.results.shift();
    if (result === undefined)
      throw new Error("No attachment result configured.");
    return result;
  }
}

function service(
  store: Store,
  gateway: Gateway,
  onChunkDocument?: (document: NormalizedKnowledgeDocument) => void,
  attachments?: AttachmentPreparationPort,
): KnowledgeIngestionService {
  let revision = 0;
  return new KnowledgeIngestionService({
    store,
    ai: gateway,
    ids: { next: () => `revision-${++revision}` },
    clock: { now: () => "2026-07-13T20:00:00.000Z" },
    ...(attachments === undefined ? {} : { attachments }),
    profiles: new ImmutableKnowledgeTextProfileRegistry({
      normalization: [
        {
          id: "normalization",
          version: "normalization.v1",
          normalizer: {
            normalize: async ({ document: loaded }) => ({
              normalizedText: loaded.body.normalizedText,
            }),
          },
        },
      ],
      chunking: [
        {
          id: "chunking",
          version: "chunking.v1",
          chunker: {
            chunk: async ({ document: normalized }) => {
              onChunkDocument?.(normalized);
              return normalized.normalizedText
                .split("|")
                .map((content, index) => ({
                  content,
                  sourceAnchor: normalized.sourceAnchors?.[index]?.anchor,
                }));
            },
          },
        },
      ],
    }),
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

  it("does not hide a newly pinned attachment policy behind an unchanged fingerprint", async () => {
    const store = new Store();
    const gateway = new Gateway();
    const policy: AttachmentPreparationPolicy = {
      mode: "required",
      policyVersion: "attachment-policy.v1",
      accessPolicyHash: "access.v1",
    };
    const attachments = new AttachmentPreparation([
      attachmentPreparationResult({
        policy,
        derivatives: [
          {
            occurrenceIdentity: "occurrence-1",
            derivativeIdentity: "derivative-1",
            derivativeContentHash: "derivative-content-1",
            searchableText: "attachment-derived evidence",
          },
        ],
      }),
    ]);
    store.items.set(reference.externalId, {
      documentId: "document-1",
      activeRevisionId: "revision-legacy",
      activeContentHash: normalizedContentHash("normalization.v1", {
        normalizedText: "source text",
      }),
      activeEmbeddingSpace,
      lastSuccessfulFingerprint: versionedOpaqueValue("etag.v1", "1"),
    });
    const source = new Source(snapshot(), document("source text"));
    const input = request(source);

    await service(store, gateway, undefined, attachments).synchronize({
      ...input,
      configuration: { ...input.configuration, attachmentPreparation: policy },
    });

    expect(source.loads).toBe(1);
    expect(attachments.calls).toBe(1);
    const activation = store.commits[0]?.mutations[0];
    expect(activation).toMatchObject({
      kind: "activate",
      attachmentPreparationPolicyIdentity:
        attachmentPreparationPolicyIdentityHash(policy),
      attachmentPreparation: {
        status: "prepared",
        identityHash: attachmentPreparationIdentityHash({
          policy,
          selectedDerivatives: [
            {
              occurrenceIdentity: "occurrence-1",
              derivativeIdentity: "derivative-1",
              derivativeContentHash: "derivative-content-1",
            },
          ],
          warnings: [],
        }),
        selectedDerivatives: [
          {
            occurrenceIdentity: "occurrence-1",
            derivativeIdentity: "derivative-1",
            derivativeContentHash: "derivative-content-1",
          },
        ],
        warnings: [],
        retryRequired: false,
      },
    });
    expect(activation).not.toHaveProperty("attachmentPreparation.policy");
    expect(JSON.stringify(activation)).not.toContain("attachment-policy.v1");
    expect(JSON.stringify(activation)).not.toContain("access.v1");
  });

  it("re-prepares an unchanged fingerprint when the pinned attachment policy changes", async () => {
    const store = new Store();
    const gateway = new Gateway();
    const firstPolicy: AttachmentPreparationPolicy = {
      mode: "optional",
      policyVersion: "attachment-policy.v1",
      accessPolicyHash: "access.v1",
    };
    const changedPolicy: AttachmentPreparationPolicy = {
      mode: "optional",
      policyVersion: "attachment-policy.v2",
      accessPolicyHash: "access.v2",
    };
    const attachments = new AttachmentPreparation([
      attachmentPreparationResult({ policy: firstPolicy }),
      attachmentPreparationResult({ policy: changedPolicy }),
    ]);
    const ingestion = service(store, gateway, undefined, attachments);
    const firstSource = new Source(snapshot(), document("source text"));
    const first = request(firstSource);

    await ingestion.synchronize({
      ...first,
      configuration: {
        ...first.configuration,
        attachmentPreparation: firstPolicy,
      },
    });

    const changedSource = new Source(snapshot(), document("source text"));
    const changed = request(changedSource);
    await ingestion.synchronize({
      ...changed,
      configuration: {
        ...changed.configuration,
        attachmentPreparation: changedPolicy,
      },
    });

    expect(firstSource.loads).toBe(1);
    expect(changedSource.loads).toBe(1);
    expect(attachments.calls).toBe(2);
    expect(store.commits[1]?.mutations[0]).toMatchObject({
      kind: "activate",
      attachmentPreparationPolicyIdentity:
        attachmentPreparationPolicyIdentityHash(changedPolicy),
    });
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

  it("passes discovery pins to load and preserves generic provenance and anchors", async () => {
    const store = new Store();
    const gateway = new Gateway();
    const externalRevision = versionedOpaqueValue("revision.v1", "commit-1");
    const loadToken = versionedOpaqueValue("load.v1", "pin-1");
    const loaded: KnowledgeDocument = {
      reference,
      externalRevision,
      body: { format: "markdown", normalizedText: "First|Second" },
      attachments: [],
      provenance: {
        sourceUrl: "https://docs.example.invalid/guides/install",
        sourceLocator: "guides/install.md",
        contentIdentity: versionedOpaqueValue("content.v1", "blob-1"),
      },
      sourceAnchors: [
        { anchor: "first", label: "First", position: 1 },
        { anchor: "second", label: "Second", position: 4 },
      ],
    };
    const source = new Source(
      snapshot(versionedOpaqueValue("etag.v1", "2"), true, {
        externalRevision,
        loadToken,
      }),
      loaded,
    );
    const chunkDocuments: NormalizedKnowledgeDocument[] = [];

    await service(store, gateway, (normalized) => {
      chunkDocuments.push(normalized);
    }).synchronize(request(source, versionedOpaqueValue("etag.v1", "2")));

    expect(source.loadRequests).toEqual([
      expect.objectContaining({ reference, externalRevision, loadToken }),
    ]);
    expect(chunkDocuments).toEqual([
      expect.objectContaining({
        externalRevision,
        sourceUrl: "https://docs.example.invalid/guides/install",
        provenance: loaded.provenance,
        sourceAnchors: loaded.sourceAnchors,
      }),
    ]);
    expect(store.commits[0]?.mutations).toEqual([
      expect.objectContaining({
        kind: "activate",
        normalized: expect.objectContaining({
          externalRevision,
          provenance: loaded.provenance,
          sourceAnchors: loaded.sourceAnchors,
        }),
        chunks: [
          expect.objectContaining({ sourceAnchor: "first" }),
          expect.objectContaining({ sourceAnchor: "second" }),
        ],
      }),
    ]);
  });

  it("rejects a loaded document from a revision other than discovery", async () => {
    const store = new Store();
    const gateway = new Gateway();
    const source = new Source(
      snapshot(versionedOpaqueValue("etag.v1", "2"), true, {
        externalRevision: versionedOpaqueValue("revision.v1", "commit-1"),
      }),
      {
        ...document("content"),
        externalRevision: versionedOpaqueValue("revision.v1", "commit-2"),
      },
    );

    await expect(
      service(store, gateway).synchronize(
        request(source, versionedOpaqueValue("etag.v1", "2")),
      ),
    ).rejects.toMatchObject({ code: "knowledge.revisionMismatch" });
    expect(store.failures[0]).toMatchObject({ stage: "load" });
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

    const delta: readonly DiscoveryPage<DiscoveredKnowledgeItem>[] = [
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
    const pages: readonly DiscoveryPage<DiscoveredKnowledgeItem>[] = [
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

  it("keeps original normalized text untouched while retrying optional attachment evidence", async () => {
    const store = new Store();
    const gateway = new Gateway();
    const policy: AttachmentPreparationPolicy = {
      mode: "optional",
      policyVersion: "attachment-policy.v1",
      accessPolicyHash: "access.v1",
    };
    const attachments = new AttachmentPreparation([
      attachmentPreparationResult({
        policy,
        warnings: [
          {
            kind: "attachmentPreparationWarning",
            code: "attachment.in-progress",
            retryable: true,
            occurrenceIdentity: "occurrence-1",
          },
        ],
      }),
      attachmentPreparationResult({
        policy,
        derivatives: [
          {
            occurrenceIdentity: "occurrence-1",
            derivativeIdentity: "derivative-1",
            derivativeContentHash: "derivative-content-1",
            searchableText: "translated screenshot text",
          },
        ],
      }),
    ]);
    const seenDocuments: NormalizedKnowledgeDocument[] = [];
    const ingestion = service(
      store,
      gateway,
      (normalized) => seenDocuments.push(normalized),
      attachments,
    );
    const firstSource = new Source(
      snapshot(),
      document("original source text"),
    );
    const firstRequest = request(firstSource);

    await ingestion.synchronize({
      ...firstRequest,
      configuration: {
        ...firstRequest.configuration,
        attachmentPreparation: policy,
      },
    });

    const firstActivation = store.commits[0]?.mutations[0];
    expect(firstActivation).toMatchObject({
      kind: "activate",
      normalized: { normalizedText: "original source text" },
      attachmentPreparation: {
        status: "prepared",
        retryRequired: true,
      },
      chunks: [
        expect.objectContaining({
          kind: "source",
          content: "original source text",
        }),
      ],
    });
    expect(seenDocuments[0]?.normalizedText).toBe("original source text");
    expect(seenDocuments[0]?.normalizedText).not.toContain("translated");

    const retrySource = new Source(
      snapshot(),
      document("original source text"),
    );
    const retryRequest = request(retrySource);
    await ingestion.synchronize({
      ...retryRequest,
      configuration: {
        ...retryRequest.configuration,
        attachmentPreparation: policy,
      },
    });

    expect(attachments.calls).toBe(2);
    expect(retrySource.loads).toBe(1);
    const retryActivation = store.commits[1]?.mutations[0];
    expect(retryActivation).toMatchObject({
      kind: "activate",
      normalized: { normalizedText: "original source text" },
      attachmentPreparation: {
        status: "prepared",
        retryRequired: false,
      },
    });
    expect(retryActivation).toMatchObject({
      chunks: [
        expect.objectContaining({
          kind: "source",
          content: "original source text",
        }),
        expect.objectContaining({
          kind: "attachmentEvidence",
          content:
            "[CaseWeaver attachment evidence: occurrence=occurrence-1; derivative=derivative-1; hash=derivative-content-1]\ntranslated screenshot text",
          attachmentEvidence: {
            occurrenceIdentity: "occurrence-1",
            derivativeIdentity: "derivative-1",
            derivativeContentHash: "derivative-content-1",
          },
        }),
      ],
    });
  });

  it("fails closed for required attachment warnings and records retryability", async () => {
    const store = new Store();
    const gateway = new Gateway();
    const policy: AttachmentPreparationPolicy = {
      mode: "required",
      policyVersion: "attachment-policy.v1",
      accessPolicyHash: "access.v1",
    };
    const attachments = new AttachmentPreparation([
      attachmentPreparationResult({
        policy,
        warnings: [
          {
            kind: "attachmentPreparationWarning",
            code: "attachment.in-progress",
            retryable: true,
          },
        ],
      }),
    ]);
    const source = new Source(snapshot(), document("source text"));
    const input = request(source);

    await expect(
      service(store, gateway, undefined, attachments).synchronize({
        ...input,
        configuration: {
          ...input.configuration,
          attachmentPreparation: policy,
        },
      }),
    ).rejects.toMatchObject({
      code: "knowledge.attachmentPreparationRequired",
      retryable: true,
    });
    expect(store.commits).toEqual([]);
    expect(store.failures[0]).toMatchObject({
      stage: "attachments",
      code: "knowledge.attachmentPreparationRequired",
      retryable: true,
    });
  });

  it("reduces optional attachment adapter failures to a safe retryable warning", async () => {
    const store = new Store();
    const gateway = new Gateway();
    const policy: AttachmentPreparationPolicy = {
      mode: "optional",
      policyVersion: "attachment-policy.v1",
      accessPolicyHash: "access.v1",
    };
    const attachments: AttachmentPreparationPort = {
      prepare: async () => {
        throw new Error(
          "https://connector.example.invalid/private/source.txt should not persist",
        );
      },
    };
    const source = new Source(snapshot(), document("source text"));
    const input = request(source);

    await service(store, gateway, undefined, attachments).synchronize({
      ...input,
      configuration: { ...input.configuration, attachmentPreparation: policy },
    });

    const activation = store.commits[0]?.mutations[0];
    expect(activation).toMatchObject({
      kind: "activate",
      attachmentPreparation: {
        status: "prepared",
        retryRequired: true,
        warnings: [
          {
            code: "attachment.preparation-unavailable",
            retryable: true,
          },
        ],
      },
    });
    expect(JSON.stringify(activation)).not.toContain(
      "connector.example.invalid",
    );
  });

  it("creates a new immutable revision when a completed derivative changes", async () => {
    const store = new Store();
    const gateway = new Gateway();
    const policy: AttachmentPreparationPolicy = {
      mode: "optional",
      policyVersion: "attachment-policy.v1",
      accessPolicyHash: "access.v1",
    };
    const attachments = new AttachmentPreparation([
      attachmentPreparationResult({
        policy,
        derivatives: [
          {
            occurrenceIdentity: "occurrence-1",
            derivativeIdentity: "derivative-1",
            derivativeContentHash: "output-v1",
            searchableText: "first derivative",
          },
        ],
      }),
      attachmentPreparationResult({
        policy,
        derivatives: [
          {
            occurrenceIdentity: "occurrence-1",
            derivativeIdentity: "derivative-1",
            derivativeContentHash: "output-v2",
            searchableText: "second derivative",
          },
        ],
      }),
    ]);
    const ingestion = service(store, gateway, undefined, attachments);
    const first = request(new Source(snapshot(), document("stable source")));
    await ingestion.synchronize({
      ...first,
      configuration: { ...first.configuration, attachmentPreparation: policy },
    });
    const firstActivation = store.commits[0]?.mutations[0];
    const second = request(
      new Source(
        snapshot(versionedOpaqueValue("etag.v1", "2")),
        document("stable source"),
      ),
      versionedOpaqueValue("etag.v1", "2"),
    );
    await ingestion.synchronize({
      ...second,
      configuration: { ...second.configuration, attachmentPreparation: policy },
    });
    const secondActivation = store.commits[1]?.mutations[0];

    expect(firstActivation).toMatchObject({ kind: "activate" });
    expect(secondActivation).toMatchObject({ kind: "activate" });
    expect(
      (secondActivation as Extract<KnowledgeMutation, { kind: "activate" }>)
        .contentHash,
    ).not.toBe(
      (firstActivation as Extract<KnowledgeMutation, { kind: "activate" }>)
        .contentHash,
    );
    expect(gateway.inputs).toEqual([
      [
        "stable source",
        "[CaseWeaver attachment evidence: occurrence=occurrence-1; derivative=derivative-1; hash=output-v1]\nfirst derivative",
      ],
      [
        "[CaseWeaver attachment evidence: occurrence=occurrence-1; derivative=derivative-1; hash=output-v2]\nsecond derivative",
      ],
    ]);
  });

  it("rejects unknown embedding pricing for a hard collection budget", async () => {
    const store = new Store();
    const gateway = new Gateway();
    gateway.pricingStatus = "unknown";
    const source = new Source(snapshot(), document("priced content"));
    const input = request(source);

    await expect(
      service(store, gateway).synchronize({
        ...input,
        configuration: {
          ...input.configuration,
          collection: {
            ...input.configuration.collection,
            budget: { currency: "USD", hard: true },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "knowledge.unknownPricing",
      retryable: false,
    });
    expect(store.commits).toEqual([]);
  });
});
