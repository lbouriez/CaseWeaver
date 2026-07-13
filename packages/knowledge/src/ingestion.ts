import type { EmbeddingResult } from "@caseweaver/ai-sdk";
import type {
  DeltaDiscoveryPage,
  DiscoveredKnowledgeItem,
  DiscoveryPage,
  ExternalReference,
  SnapshotDiscoveryPage,
  VersionedOpaqueValue,
} from "@caseweaver/connector-sdk";

import {
  chunkContentHash,
  deterministicChunkId,
  embeddingCacheIdentityKey,
  normalizedContentHash,
  sameOpaqueValue,
  sameReference,
} from "./hashing.js";
import type {
  ActivatedRevision,
  ActiveEmbeddingSpace,
  EmbeddingCacheIdentity,
  FailedRevisionDiagnostic,
  KnowledgeChunkDraft,
  KnowledgeIngestionDependencies,
  KnowledgeMutation,
  KnowledgeSynchronizationRequest,
  KnowledgeSynchronizationResult,
  NewCachedEmbedding,
  NormalizedKnowledgeDocument,
} from "./types.js";

export class KnowledgeIngestionError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "KnowledgeIngestionError";
  }
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new KnowledgeIngestionError(
      "Knowledge synchronization was cancelled.",
      "knowledge.cancelled",
      false,
    );
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new KnowledgeIngestionError(
      `Knowledge ${field} must not be empty.`,
      "knowledge.invalidConfiguration",
      false,
    );
  }
}

function validateConfiguration(request: KnowledgeSynchronizationRequest): void {
  const { configuration } = request;
  requireNonEmpty(configuration.id, "source ID");
  requireNonEmpty(configuration.workspaceId, "workspace ID");
  requireNonEmpty(configuration.connectorInstanceId, "connector instance ID");
  requireNonEmpty(
    configuration.normalizationProfileVersion,
    "normalization profile version",
  );
  requireNonEmpty(
    configuration.chunkingProfileVersion,
    "chunking profile version",
  );
  requireNonEmpty(configuration.collection.id, "collection ID");
  requireNonEmpty(
    configuration.collection.embeddingBindingVersionId,
    "embedding binding version ID",
  );
  requireNonEmpty(
    configuration.collection.embeddingProfileVersion,
    "embedding profile version",
  );
  if (
    !Number.isInteger(configuration.collection.dimensions) ||
    configuration.collection.dimensions < 1
  ) {
    throw new KnowledgeIngestionError(
      "Knowledge collection dimensions must be a positive integer.",
      "knowledge.invalidConfiguration",
      false,
    );
  }
  if (
    !Number.isInteger(configuration.collection.maximumInputTokens) ||
    configuration.collection.maximumInputTokens < 1
  ) {
    throw new KnowledgeIngestionError(
      "Knowledge embedding maximum input tokens must be a positive integer.",
      "knowledge.invalidConfiguration",
      false,
    );
  }
  if (
    !Number.isInteger(configuration.embeddingBatchSize) ||
    configuration.embeddingBatchSize < 1
  ) {
    throw new KnowledgeIngestionError(
      "Knowledge embedding batch size must be a positive integer.",
      "knowledge.invalidConfiguration",
      false,
    );
  }
}

function ensureReferenceBelongsToSource(
  configuration: KnowledgeSynchronizationRequest["configuration"],
  reference: ExternalReference,
): void {
  if (reference.connectorInstanceId !== configuration.connectorInstanceId) {
    throw new KnowledgeIngestionError(
      "Discovered knowledge item belongs to a different connector instance.",
      "knowledge.referenceMismatch",
      false,
    );
  }
}

function validateNormalizedDocument(
  document: NormalizedKnowledgeDocument,
): void {
  if (typeof document.normalizedText !== "string") {
    throw new KnowledgeIngestionError(
      "Knowledge normalizer returned invalid text.",
      "knowledge.invalidNormalization",
      false,
    );
  }
}

function errorDiagnostic(
  error: unknown,
): Pick<FailedRevisionDiagnostic, "code" | "retryable" | "message"> {
  if (error instanceof KnowledgeIngestionError) {
    return {
      code: error.code,
      retryable: error.retryable,
      message: error.message,
    };
  }
  return {
    code: "knowledge.unexpected",
    retryable: false,
    message:
      error instanceof Error ? error.message : "Unexpected knowledge failure.",
  };
}

function sameEpoch(
  left: VersionedOpaqueValue | undefined,
  right: VersionedOpaqueValue,
): boolean {
  return left === undefined || sameOpaqueValue(left, right);
}

function cacheIdentity(
  chunkHash: string,
  request: KnowledgeSynchronizationRequest,
): EmbeddingCacheIdentity {
  return {
    chunkHash,
    embeddingBindingVersionId:
      request.configuration.collection.embeddingBindingVersionId,
    embeddingProfileVersion:
      request.configuration.collection.embeddingProfileVersion,
    dimensions: request.configuration.collection.dimensions,
    normalizationProfileVersion:
      request.configuration.normalizationProfileVersion,
  };
}

function embeddingSpace(
  request: KnowledgeSynchronizationRequest,
): ActiveEmbeddingSpace {
  return {
    embeddingBindingVersionId:
      request.configuration.collection.embeddingBindingVersionId,
    embeddingProfileVersion:
      request.configuration.collection.embeddingProfileVersion,
    dimensions: request.configuration.collection.dimensions,
    normalizationProfileVersion:
      request.configuration.normalizationProfileVersion,
  };
}

function sameEmbeddingSpace(
  left: ActiveEmbeddingSpace | undefined,
  right: ActiveEmbeddingSpace,
): boolean {
  return (
    left !== undefined &&
    left.embeddingBindingVersionId === right.embeddingBindingVersionId &&
    left.embeddingProfileVersion === right.embeddingProfileVersion &&
    left.dimensions === right.dimensions &&
    left.normalizationProfileVersion === right.normalizationProfileVersion
  );
}

function allocateInputTokens(
  total: number | undefined,
  weights: readonly number[],
): readonly (number | undefined)[] {
  if (total === undefined) return weights.map(() => undefined);
  const denominator = weights.reduce((sum, weight) => sum + weight, 0);
  if (denominator < 1) return weights.map(() => 0);
  const raw = weights.map((weight) => (total * weight) / denominator);
  const allocated = raw.map((value) => Math.floor(value));
  let remainder = total - allocated.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort(
      (left, right) =>
        right.remainder - left.remainder || left.index - right.index,
    );
  for (const item of order) {
    if (remainder === 0) break;
    allocated[item.index] = (allocated[item.index] ?? 0) + 1;
    remainder -= 1;
  }
  return allocated;
}

interface ScanState {
  mode?: "snapshot" | "delta";
  snapshotEpoch?: VersionedOpaqueValue;
  cursor?: VersionedOpaqueValue;
  complete: boolean;
  mutations: KnowledgeMutation[];
  newEmbeddings: NewCachedEmbedding[];
  pendingEmbeddingKeys: Set<string>;
  result: {
    processed: number;
    fingerprintNoops: number;
    normalizedNoops: number;
    activatedRevisions: number;
    tombstones: number;
    embeddedChunks: number;
  };
}

export class KnowledgeIngestionService {
  public constructor(
    private readonly dependencies: KnowledgeIngestionDependencies,
  ) {}

  public async synchronize(
    request: KnowledgeSynchronizationRequest,
  ): Promise<KnowledgeSynchronizationResult> {
    validateConfiguration(request);
    const state: ScanState = {
      complete: false,
      mutations: [],
      newEmbeddings: [],
      pendingEmbeddingKeys: new Set(),
      result: {
        processed: 0,
        fingerprintNoops: 0,
        normalizedNoops: 0,
        activatedRevisions: 0,
        tombstones: 0,
        embeddedChunks: 0,
      },
    };

    for await (const page of request.source.discover({
      cursor: request.cursor,
      signal: request.signal,
    })) {
      assertActive(request.signal);
      this.validatePage(state, page);
      if (state.complete) {
        throw new KnowledgeIngestionError(
          "Discovery emitted a page after completion.",
          "knowledge.invalidDiscovery",
          false,
        );
      }

      if (page.mode === "snapshot") {
        await this.processSnapshotPage(request, state, page);
      } else {
        await this.processDeltaPage(request, state, page);
      }
      state.cursor = page.nextCursor;
      state.complete = page.complete;
    }

    if (state.mode === undefined || !state.complete) {
      throw new KnowledgeIngestionError(
        "Discovery ended before a complete scan was declared.",
        "knowledge.incompleteDiscovery",
        true,
      );
    }

    await this.dependencies.store.commit({
      workspaceId: request.configuration.workspaceId,
      sourceId: request.configuration.id,
      scan: {
        mode: state.mode,
        cursor: state.cursor,
        scanEpoch: state.snapshotEpoch,
        completedAt: this.dependencies.clock.now(),
      },
      mutations: state.mutations,
      newEmbeddings: state.newEmbeddings,
    });

    return {
      mode: state.mode,
      ...state.result,
    };
  }

  private validatePage(
    state: ScanState,
    page: DiscoveryPage<DiscoveredKnowledgeItem>,
  ): void {
    if (state.mode === undefined) {
      state.mode = page.mode;
    } else if (state.mode !== page.mode) {
      throw new KnowledgeIngestionError(
        "Discovery cannot mix snapshot and delta pages.",
        "knowledge.invalidDiscovery",
        false,
      );
    }
    if (page.mode === "snapshot") {
      if (!sameEpoch(state.snapshotEpoch, page.scanEpoch)) {
        throw new KnowledgeIngestionError(
          "Snapshot discovery pages must share one stable scan epoch.",
          "knowledge.invalidDiscovery",
          false,
        );
      }
      state.snapshotEpoch = page.scanEpoch;
    }
  }

  private async processSnapshotPage(
    request: KnowledgeSynchronizationRequest,
    state: ScanState,
    page: SnapshotDiscoveryPage<DiscoveredKnowledgeItem>,
  ): Promise<void> {
    for (const item of page.items) {
      await this.processUpsert(
        request,
        state,
        item.reference,
        item.fingerprint,
      );
    }
  }

  private async processDeltaPage(
    request: KnowledgeSynchronizationRequest,
    state: ScanState,
    page: DeltaDiscoveryPage<DiscoveredKnowledgeItem>,
  ): Promise<void> {
    for (const event of page.events) {
      if (event.kind === "tombstone") {
        ensureReferenceBelongsToSource(request.configuration, event.reference);
        state.mutations.push({
          kind: "tombstone",
          reference: event.reference,
          observedAt: this.dependencies.clock.now(),
        });
        state.result.tombstones += 1;
        continue;
      }
      await this.processUpsert(
        request,
        state,
        event.item.reference,
        event.item.fingerprint,
      );
    }
  }

  private async processUpsert(
    request: KnowledgeSynchronizationRequest,
    state: ScanState,
    reference: ExternalReference,
    fingerprint: VersionedOpaqueValue | undefined,
  ): Promise<void> {
    ensureReferenceBelongsToSource(request.configuration, reference);
    assertActive(request.signal);
    const observedAt = this.dependencies.clock.now();
    const stored = await this.dependencies.store.findItem({
      workspaceId: request.configuration.workspaceId,
      sourceId: request.configuration.id,
      reference,
    });
    state.result.processed += 1;
    if (
      sameOpaqueValue(stored?.lastSuccessfulFingerprint, fingerprint) &&
      sameEmbeddingSpace(stored?.activeEmbeddingSpace, embeddingSpace(request))
    ) {
      state.mutations.push({
        kind: "observe",
        reference,
        observedAt,
        fingerprint,
        contentHash: stored?.activeContentHash,
      });
      state.result.fingerprintNoops += 1;
      return;
    }

    let stage: FailedRevisionDiagnostic["stage"] = "load";
    let revisionId: string | undefined;
    let contentHash: string | undefined;
    try {
      const loaded = await request.source.load({
        reference,
        signal: request.signal,
      });
      if (!sameReference(reference, loaded.reference)) {
        throw new KnowledgeIngestionError(
          "Loaded knowledge document does not match its discovered reference.",
          "knowledge.referenceMismatch",
          false,
        );
      }
      stage = "normalize";
      const normalized = await this.dependencies.normalizer.normalize({
        document: loaded,
        normalizationProfileVersion:
          request.configuration.normalizationProfileVersion,
        signal: request.signal,
      });
      validateNormalizedDocument(normalized);
      contentHash = normalizedContentHash(
        request.configuration.normalizationProfileVersion,
        normalized,
      );
      if (
        stored?.activeContentHash === contentHash &&
        sameEmbeddingSpace(stored.activeEmbeddingSpace, embeddingSpace(request))
      ) {
        state.mutations.push({
          kind: "observe",
          reference,
          observedAt,
          fingerprint,
          contentHash,
        });
        state.result.normalizedNoops += 1;
        return;
      }

      revisionId = this.dependencies.ids.next("knowledgeRevision");
      requireNonEmpty(revisionId, "revision ID");
      stage = "attachments";
      const attachments =
        this.dependencies.attachments === undefined
          ? []
          : await this.dependencies.attachments.prepare({
              sourceId: request.configuration.id,
              workspaceId: request.configuration.workspaceId,
              document: loaded,
              signal: request.signal,
            });
      stage = "chunk";
      const candidates = await this.dependencies.chunker.chunk({
        document: normalized,
        attachments,
        chunkingProfileVersion: request.configuration.chunkingProfileVersion,
      });
      const chunks = this.createChunks(request, revisionId, candidates);
      stage = "embedding";
      const embeddings = await this.resolveEmbeddings(request, state, chunks);
      state.newEmbeddings.push(...embeddings.newEntries);
      state.mutations.push({
        kind: "activate",
        reference,
        observedAt,
        fingerprint,
        revisionId,
        contentHash,
        normalized,
        normalizationProfileVersion:
          request.configuration.normalizationProfileVersion,
        chunkingProfileVersion: request.configuration.chunkingProfileVersion,
        embeddingSpace: embeddingSpace(request),
        chunks,
      } satisfies ActivatedRevision);
      state.result.activatedRevisions += 1;
      state.result.embeddedChunks += embeddings.newEntries.length;
    } catch (error) {
      const details = errorDiagnostic(error);
      await this.dependencies.store.recordFailedRevision({
        sourceId: request.configuration.id,
        workspaceId: request.configuration.workspaceId,
        reference,
        observedAt,
        revisionId,
        contentHash,
        stage,
        ...details,
      });
      throw error;
    }
  }

  private createChunks(
    request: KnowledgeSynchronizationRequest,
    revisionId: string,
    candidates: readonly {
      readonly content: string;
      readonly sourceAnchor?: string;
    }[],
  ): readonly KnowledgeChunkDraft[] {
    return candidates.map((candidate, position) => {
      if (candidate.content.length === 0) {
        throw new KnowledgeIngestionError(
          "Chunking profiles must not emit empty chunks.",
          "knowledge.invalidChunk",
          false,
        );
      }
      const contentHash = chunkContentHash(candidate.content);
      return {
        id: deterministicChunkId(
          revisionId,
          request.configuration.chunkingProfileVersion,
          position,
        ),
        position,
        contentHash,
        content: candidate.content,
        sourceAnchor: candidate.sourceAnchor,
        embedding: cacheIdentity(contentHash, request),
      };
    });
  }

  private async resolveEmbeddings(
    request: KnowledgeSynchronizationRequest,
    state: ScanState,
    chunks: readonly KnowledgeChunkDraft[],
  ): Promise<{ readonly newEntries: readonly NewCachedEmbedding[] }> {
    const identities = new Map<string, EmbeddingCacheIdentity>();
    const contents = new Map<string, string>();
    for (const chunk of chunks) {
      const key = embeddingCacheIdentityKey(chunk.embedding);
      identities.set(key, chunk.embedding);
      contents.set(key, chunk.content);
    }
    const existing = await this.dependencies.store.findReusableEmbeddings({
      workspaceId: request.configuration.workspaceId,
      identities: [...identities.values()],
    });
    const existingKeys = new Set<string>();
    for (const entry of existing) {
      const key = embeddingCacheIdentityKey(entry.identity);
      if (!identities.has(key)) {
        throw new KnowledgeIngestionError(
          "Embedding cache returned an entry outside the requested identity.",
          "knowledge.invalidCache",
          false,
        );
      }
      this.assertVectorDimensions(
        entry.vector,
        request.configuration.collection.dimensions,
      );
      existingKeys.add(key);
    }
    const missing = [...identities.entries()].filter(
      ([key]) => !existingKeys.has(key) && !state.pendingEmbeddingKeys.has(key),
    );
    const newEntries: NewCachedEmbedding[] = [];
    for (
      let offset = 0;
      offset < missing.length;
      offset += request.configuration.embeddingBatchSize
    ) {
      assertActive(request.signal);
      const batch = missing.slice(
        offset,
        offset + request.configuration.embeddingBatchSize,
      );
      const result = await this.dependencies.ai.execute<EmbeddingResult>(
        {
          kind: "embedding",
          role: "embedding",
          bindingVersionId:
            request.configuration.collection.embeddingBindingVersionId,
          request: {
            input: batch.map(([key]) => contents.get(key) ?? ""),
            dimensions: request.configuration.collection.dimensions,
          },
          maximumInputTokens:
            request.configuration.collection.maximumInputTokens,
          budget: request.configuration.collection.budget,
        },
        {
          workspaceId: request.configuration.workspaceId,
          signal: request.signal,
        },
      );
      if (result.value.vectors.length !== batch.length) {
        throw new KnowledgeIngestionError(
          "Embedding provider returned a vector count that does not match its input.",
          "knowledge.invalidEmbedding",
          false,
        );
      }
      const weights = batch.map(([key]) => (contents.get(key) ?? "").length);
      const allocations = allocateInputTokens(
        result.usage?.inputTokens,
        weights,
      );
      const denominator = weights.reduce((sum, weight) => sum + weight, 0);
      for (const [index, [key, identity]] of batch.entries()) {
        const vector = result.value.vectors[index];
        if (vector === undefined) {
          throw new KnowledgeIngestionError(
            "Embedding provider omitted a requested vector.",
            "knowledge.invalidEmbedding",
            false,
          );
        }
        this.assertVectorDimensions(
          vector,
          request.configuration.collection.dimensions,
        );
        newEntries.push({
          identity,
          vector,
          allocation: {
            operationId: result.operationId,
            allocatedInputTokens: allocations[index],
            calculatedCostAmount: result.calculatedCost.amount,
            calculatedCostCurrency: result.calculatedCost.currency,
            calculationStatus: result.calculatedCost.status,
            weightNumerator: weights[index] ?? 0,
            weightDenominator: denominator,
          },
        });
        state.pendingEmbeddingKeys.add(key);
      }
    }
    return { newEntries };
  }

  private assertVectorDimensions(
    vector: readonly number[],
    dimensions: number,
  ): void {
    if (
      vector.length !== dimensions ||
      vector.some((value) => !Number.isFinite(value))
    ) {
      throw new KnowledgeIngestionError(
        "Embedding vector dimensions do not match the collection binding.",
        "knowledge.invalidEmbedding",
        false,
      );
    }
  }
}
