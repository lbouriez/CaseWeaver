import type { AiExecutionGateway } from "@caseweaver/ai-execution";
import type { EmbeddingResult, RerankerResult } from "@caseweaver/ai-sdk";

import type {
  QueryEmbedding,
  RetrievalCandidate,
  RetrievalCollection,
  RetrievalDependencies,
  RetrievalEvidence,
  RetrievalEvidenceScores,
  RetrievalProfile,
  RetrievalRequest,
  RetrievalSnapshot,
} from "./contracts.js";

export class RetrievalError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "retrieval.cancelled"
      | "retrieval.invalidConfiguration"
      | "retrieval.invalidCandidate"
      | "retrieval.invalidAiResult",
  ) {
    super(message);
    this.name = "RetrievalError";
  }
}

export interface RetrievalServiceDependencies extends RetrievalDependencies {
  readonly ai: AiExecutionGateway;
}

interface EmbeddingGroup {
  readonly bindingVersionId: string;
  readonly embeddingProfileVersion: string;
  readonly dimensions: number;
  readonly collections: readonly RetrievalCollection[];
}

interface FusedCandidate {
  readonly candidate: RetrievalCandidate;
  readonly lexicalRank?: number;
  readonly vectorRank?: number;
  readonly lexicalRrf: number;
  readonly vectorRrf: number;
  readonly fusedRrf: number;
  readonly rerankerScore?: number;
}

function requireNonEmpty(value: string, description: string): void {
  if (value.length === 0) {
    throw new RetrievalError(
      `${description} must not be empty.`,
      "retrieval.invalidConfiguration",
    );
  }
}

function requirePositiveInteger(value: number, description: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RetrievalError(
      `${description} must be a positive safe integer.`,
      "retrieval.invalidConfiguration",
    );
  }
}

function requireNonNegativeInteger(value: number, description: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RetrievalError(
      `${description} must be a non-negative safe integer.`,
      "retrieval.invalidConfiguration",
    );
  }
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new RetrievalError("Retrieval was cancelled.", "retrieval.cancelled");
  }
}

function candidateKey(candidate: RetrievalCandidate): string {
  return [
    candidate.collectionId,
    candidate.sourceId,
    candidate.sourceRevisionId,
    candidate.chunkId,
  ].join("\u0000");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareFused(left: FusedCandidate, right: FusedCandidate): number {
  const score = right.fusedRrf - left.fusedRrf;
  if (score !== 0) return score;
  const collection = compareText(
    left.candidate.collectionId,
    right.candidate.collectionId,
  );
  if (collection !== 0) return collection;
  const source = compareText(left.candidate.sourceId, right.candidate.sourceId);
  if (source !== 0) return source;
  const revision = compareText(
    left.candidate.sourceRevisionId,
    right.candidate.sourceRevisionId,
  );
  if (revision !== 0) return revision;
  return compareText(left.candidate.chunkId, right.candidate.chunkId);
}

function compareRanked(left: FusedCandidate, right: FusedCandidate): number {
  const reranker = (right.rerankerScore ?? 0) - (left.rerankerScore ?? 0);
  if (reranker !== 0) return reranker;
  return compareFused(left, right);
}

function validateCandidate(candidate: RetrievalCandidate): void {
  requireNonEmpty(candidate.collectionId, "Candidate collection ID");
  requireNonEmpty(candidate.sourceId, "Candidate source ID");
  requireNonEmpty(candidate.sourceRevisionId, "Candidate source revision ID");
  requireNonEmpty(candidate.chunkId, "Candidate chunk ID");
  requireNonEmpty(candidate.location, "Candidate location");
  if (candidate.content.length === 0) {
    throw new RetrievalError(
      "Candidate content must not be empty.",
      "retrieval.invalidCandidate",
    );
  }
  if (
    candidate.lexicalRank === undefined &&
    candidate.vectorRank === undefined
  ) {
    throw new RetrievalError(
      "A candidate must have a lexical or vector rank.",
      "retrieval.invalidCandidate",
    );
  }
  if (candidate.lexicalRank !== undefined) {
    requirePositiveInteger(candidate.lexicalRank, "Candidate lexical rank");
  }
  if (candidate.vectorRank !== undefined) {
    requirePositiveInteger(candidate.vectorRank, "Candidate vector rank");
  }
}

function groupsFor(profile: RetrievalProfile): readonly EmbeddingGroup[] {
  const grouped = new Map<string, EmbeddingGroup>();
  for (const collection of profile.collections) {
    const current = grouped.get(collection.embeddingBindingVersionId);
    if (current === undefined) {
      grouped.set(collection.embeddingBindingVersionId, {
        bindingVersionId: collection.embeddingBindingVersionId,
        embeddingProfileVersion: collection.embeddingProfileVersion,
        dimensions: collection.dimensions,
        collections: [collection],
      });
      continue;
    }
    if (
      current.embeddingProfileVersion !== collection.embeddingProfileVersion ||
      current.dimensions !== collection.dimensions
    ) {
      throw new RetrievalError(
        "Collections sharing an embedding binding must have a compatible profile and dimensions.",
        "retrieval.invalidConfiguration",
      );
    }
    grouped.set(collection.embeddingBindingVersionId, {
      ...current,
      collections: [...current.collections, collection],
    });
  }
  return [...grouped.values()].sort((left, right) =>
    compareText(left.bindingVersionId, right.bindingVersionId),
  );
}

function validateProfile(profile: RetrievalProfile): void {
  requireNonEmpty(profile.id, "Retrieval profile ID");
  requireNonEmpty(profile.version, "Retrieval profile version");
  if (profile.collections.length === 0) {
    throw new RetrievalError(
      "A retrieval profile must select at least one collection.",
      "retrieval.invalidConfiguration",
    );
  }
  const collectionIds = new Set<string>();
  for (const collection of profile.collections) {
    requireNonEmpty(collection.id, "Collection ID");
    requireNonEmpty(
      collection.embeddingBindingVersionId,
      "Embedding binding version ID",
    );
    requireNonEmpty(
      collection.embeddingProfileVersion,
      "Embedding profile version",
    );
    requirePositiveInteger(collection.dimensions, "Embedding dimensions");
    if (collectionIds.has(collection.id)) {
      throw new RetrievalError(
        "A retrieval profile cannot select a collection more than once.",
        "retrieval.invalidConfiguration",
      );
    }
    collectionIds.add(collection.id);
  }
  requirePositiveInteger(profile.policy.rankConstant, "RRF rank constant");
  if (
    !Number.isFinite(profile.policy.lexicalWeight) ||
    profile.policy.lexicalWeight < 0 ||
    !Number.isFinite(profile.policy.vectorWeight) ||
    profile.policy.vectorWeight < 0 ||
    (profile.policy.lexicalWeight === 0 && profile.policy.vectorWeight === 0)
  ) {
    throw new RetrievalError(
      "At least one non-negative RRF weight must be positive.",
      "retrieval.invalidConfiguration",
    );
  }
  requirePositiveInteger(
    profile.policy.maximumFinalResults,
    "Maximum final results",
  );
  requireNonNegativeInteger(
    profile.policy.maximumCharacters,
    "Maximum characters",
  );
  requireNonNegativeInteger(profile.policy.maximumTokens, "Maximum tokens");
  requirePositiveInteger(
    profile.policy.defaultSourceQuota.maximumCandidates,
    "Default source candidate quota",
  );
  requirePositiveInteger(
    profile.policy.defaultSourceQuota.maximumFinalResults,
    "Default source final-result quota",
  );
  const quotaSources = new Set<string>();
  for (const quota of profile.policy.sourceQuotas) {
    requireNonEmpty(quota.sourceId, "Source quota source ID");
    requirePositiveInteger(quota.maximumCandidates, "Source candidate quota");
    requirePositiveInteger(
      quota.maximumFinalResults,
      "Source final-result quota",
    );
    if (quotaSources.has(quota.sourceId)) {
      throw new RetrievalError(
        "A source may only have one retrieval quota override.",
        "retrieval.invalidConfiguration",
      );
    }
    quotaSources.add(quota.sourceId);
  }
  requirePositiveInteger(
    profile.queryEmbedding.maximumInputTokens,
    "Query embedding maximum input tokens",
  );
  requireNonEmpty(profile.queryEmbedding.budget.currency, "Embedding currency");
  if (profile.reranker !== undefined) {
    requireNonEmpty(
      profile.reranker.bindingVersionId,
      "Reranker binding version ID",
    );
    requirePositiveInteger(
      profile.reranker.maximumCandidates,
      "Reranker maximum candidates",
    );
    requirePositiveInteger(
      profile.reranker.maximumInputTokens,
      "Reranker maximum input tokens",
    );
    if (
      profile.reranker.timeoutMs !== undefined &&
      (!Number.isSafeInteger(profile.reranker.timeoutMs) ||
        profile.reranker.timeoutMs < 1)
    ) {
      throw new RetrievalError(
        "Reranker timeout must be a positive safe integer.",
        "retrieval.invalidConfiguration",
      );
    }
    requireNonEmpty(profile.reranker.budget.currency, "Reranker currency");
  }
}

function quotaFor(profile: RetrievalProfile, sourceId: string) {
  return (
    profile.policy.sourceQuotas.find((quota) => quota.sourceId === sourceId) ??
    profile.policy.defaultSourceQuota
  );
}

function immutableEvidence(
  candidate: FusedCandidate,
  tokenCount: number,
): RetrievalEvidence {
  const scores: RetrievalEvidenceScores = Object.freeze({
    fusedRrf: candidate.fusedRrf,
    lexicalRrf: candidate.lexicalRrf,
    vectorRrf: candidate.vectorRrf,
    ...(candidate.rerankerScore === undefined
      ? {}
      : { reranker: candidate.rerankerScore }),
  });
  return Object.freeze({
    collectionId: candidate.candidate.collectionId,
    sourceId: candidate.candidate.sourceId,
    sourceRevisionId: candidate.candidate.sourceRevisionId,
    chunkId: candidate.candidate.chunkId,
    location: candidate.candidate.location,
    ...(candidate.candidate.sourceUrl === undefined
      ? {}
      : { sourceUrl: candidate.candidate.sourceUrl }),
    content: candidate.candidate.content,
    accessMetadata: Object.freeze({ ...candidate.candidate.accessMetadata }),
    scores,
    characterCount: candidate.candidate.content.length,
    tokenCount,
  });
}

export class RetrievalService {
  public constructor(
    private readonly dependencies: RetrievalServiceDependencies,
  ) {}

  public async retrieve(request: RetrievalRequest): Promise<RetrievalSnapshot> {
    assertActive(request.signal);
    requireNonEmpty(request.workspaceId, "Workspace ID");
    requireNonEmpty(request.query, "Retrieval query");
    requireNonEmpty(request.snapshot.id, "Retrieval snapshot ID");
    requireNonEmpty(
      request.snapshot.capturedAt,
      "Retrieval snapshot timestamp",
    );
    validateProfile(request.profile);

    const authorizedSources = new Set(request.access.authorizedSourceIds);
    if (authorizedSources.size === 0) {
      return this.persistSnapshot(request, [], {}, undefined);
    }

    const groups = groupsFor(request.profile);
    const queryEmbeddings = await this.embedQuery(request, groups);
    assertActive(request.signal);
    const candidates = await this.dependencies.search.search({
      workspaceId: request.workspaceId,
      query: request.query,
      collections: [...request.profile.collections].sort((left, right) =>
        compareText(left.id, right.id),
      ),
      vectorQueries: queryEmbeddings.map((embedding) => embedding.query),
      access: request.access,
      ...(request.metadataFilters === undefined
        ? {}
        : { metadataFilters: request.metadataFilters }),
      maximumCandidatesPerSource: Math.max(
        request.profile.policy.defaultSourceQuota.maximumCandidates,
        ...request.profile.policy.sourceQuotas.map(
          (quota) => quota.maximumCandidates,
        ),
      ),
      signal: request.signal,
    });
    assertActive(request.signal);

    const fused = this.fuse(
      candidates,
      request.profile,
      authorizedSources,
      new Set(request.profile.collections.map((collection) => collection.id)),
    );
    const candidateBounded = this.applyCandidateQuotas(fused, request.profile);
    const reranked = await this.rerank(
      candidateBounded,
      request,
      this.dependencies.tokens.count(request.query),
    );
    const evidence = this.applyFinalBudgets(
      reranked.candidates,
      request.profile,
    );
    const operationIds = Object.fromEntries(
      queryEmbeddings.map((embedding) => [
        embedding.query.embeddingBindingVersionId,
        embedding.operationId,
      ]),
    );
    return this.persistSnapshot(
      request,
      evidence,
      operationIds,
      reranked.operationId,
    );
  }

  private async embedQuery(
    request: RetrievalRequest,
    groups: readonly EmbeddingGroup[],
  ): Promise<
    readonly {
      readonly query: QueryEmbedding;
      readonly operationId: string;
    }[]
  > {
    const queryTokens = this.dependencies.tokens.count(request.query);
    requireNonNegativeInteger(queryTokens, "Query token count");
    if (queryTokens > request.profile.queryEmbedding.maximumInputTokens) {
      throw new RetrievalError(
        "The retrieval query exceeds the configured embedding token limit.",
        "retrieval.invalidConfiguration",
      );
    }
    const embedded = await Promise.all(
      groups.map(async (group) => {
        const result = await this.dependencies.ai.execute<EmbeddingResult>(
          {
            kind: "embedding",
            role: "embedding",
            bindingVersionId: group.bindingVersionId,
            maximumInputTokens:
              request.profile.queryEmbedding.maximumInputTokens,
            budget: request.profile.queryEmbedding.budget,
            request: {
              input: [request.query],
              dimensions: group.dimensions,
            },
          },
          { workspaceId: request.workspaceId, signal: request.signal },
        );
        const vector = result.value.vectors[0];
        if (
          result.value.vectors.length !== 1 ||
          vector === undefined ||
          vector.length !== group.dimensions ||
          vector.some((value) => !Number.isFinite(value))
        ) {
          throw new RetrievalError(
            "The embedding gateway returned an incompatible query vector.",
            "retrieval.invalidAiResult",
          );
        }
        return {
          operationId: result.operationId,
          query: Object.freeze({
            embeddingBindingVersionId: group.bindingVersionId,
            embeddingProfileVersion: group.embeddingProfileVersion,
            dimensions: group.dimensions,
            collectionIds: Object.freeze(
              group.collections
                .map((collection) => collection.id)
                .sort(compareText),
            ),
            vector: Object.freeze([...vector]),
          }),
        };
      }),
    );
    return embedded.sort((left, right) =>
      compareText(
        left.query.embeddingBindingVersionId,
        right.query.embeddingBindingVersionId,
      ),
    );
  }

  private fuse(
    candidates: readonly RetrievalCandidate[],
    profile: RetrievalProfile,
    authorizedSources: ReadonlySet<string>,
    selectedCollections: ReadonlySet<string>,
  ): readonly FusedCandidate[] {
    const deduplicated = new Map<
      string,
      {
        candidate: RetrievalCandidate;
        lexicalRank?: number;
        vectorRank?: number;
      }
    >();
    for (const candidate of candidates) {
      validateCandidate(candidate);
      if (
        !candidate.activeRevision ||
        !authorizedSources.has(candidate.sourceId) ||
        !selectedCollections.has(candidate.collectionId)
      ) {
        continue;
      }
      const key = candidateKey(candidate);
      const existing = deduplicated.get(key);
      if (existing === undefined) {
        deduplicated.set(key, {
          candidate,
          ...(candidate.lexicalRank === undefined
            ? {}
            : { lexicalRank: candidate.lexicalRank }),
          ...(candidate.vectorRank === undefined
            ? {}
            : { vectorRank: candidate.vectorRank }),
        });
        continue;
      }
      if (
        existing.candidate.content !== candidate.content ||
        existing.candidate.location !== candidate.location ||
        existing.candidate.sourceUrl !== candidate.sourceUrl
      ) {
        throw new RetrievalError(
          "Duplicate candidate identities must contain identical immutable evidence.",
          "retrieval.invalidCandidate",
        );
      }
      if (
        candidate.lexicalRank !== undefined &&
        (existing.lexicalRank === undefined ||
          candidate.lexicalRank < existing.lexicalRank)
      ) {
        existing.lexicalRank = candidate.lexicalRank;
      }
      if (
        candidate.vectorRank !== undefined &&
        (existing.vectorRank === undefined ||
          candidate.vectorRank < existing.vectorRank)
      ) {
        existing.vectorRank = candidate.vectorRank;
      }
    }
    return [...deduplicated.values()]
      .map((item) => {
        const lexicalRrf =
          item.lexicalRank === undefined
            ? 0
            : profile.policy.lexicalWeight /
              (profile.policy.rankConstant + item.lexicalRank);
        const vectorRrf =
          item.vectorRank === undefined
            ? 0
            : profile.policy.vectorWeight /
              (profile.policy.rankConstant + item.vectorRank);
        return {
          candidate: item.candidate,
          ...(item.lexicalRank === undefined
            ? {}
            : { lexicalRank: item.lexicalRank }),
          ...(item.vectorRank === undefined
            ? {}
            : { vectorRank: item.vectorRank }),
          lexicalRrf,
          vectorRrf,
          fusedRrf: lexicalRrf + vectorRrf,
        };
      })
      .sort(compareFused);
  }

  private applyCandidateQuotas(
    candidates: readonly FusedCandidate[],
    profile: RetrievalProfile,
  ): readonly FusedCandidate[] {
    const counts = new Map<string, number>();
    return candidates.filter((candidate) => {
      const count = counts.get(candidate.candidate.sourceId) ?? 0;
      if (
        count >=
        quotaFor(profile, candidate.candidate.sourceId).maximumCandidates
      ) {
        return false;
      }
      counts.set(candidate.candidate.sourceId, count + 1);
      return true;
    });
  }

  private async rerank(
    candidates: readonly FusedCandidate[],
    request: RetrievalRequest,
    queryTokens: number,
  ): Promise<{
    readonly candidates: readonly FusedCandidate[];
    readonly operationId?: string;
  }> {
    const policy = request.profile.reranker;
    if (policy === undefined) return { candidates };
    if (queryTokens > policy.maximumInputTokens) {
      throw new RetrievalError(
        "The retrieval query exceeds the configured reranker token limit.",
        "retrieval.invalidConfiguration",
      );
    }
    let consumedTokens = queryTokens;
    const bounded: FusedCandidate[] = [];
    for (const candidate of candidates.slice(0, policy.maximumCandidates)) {
      const tokenCount = this.dependencies.tokens.count(
        candidate.candidate.content,
      );
      requireNonNegativeInteger(tokenCount, "Candidate token count");
      if (consumedTokens + tokenCount > policy.maximumInputTokens) continue;
      consumedTokens += tokenCount;
      bounded.push(candidate);
    }
    if (bounded.length === 0) return { candidates: [] };
    const result = await this.dependencies.ai.execute<RerankerResult>(
      {
        kind: "reranker",
        role: "reranker",
        bindingVersionId: policy.bindingVersionId,
        requiredCapabilities: ["reranking"],
        maximumInputTokens: policy.maximumInputTokens,
        ...(policy.timeoutMs === undefined
          ? {}
          : { timeoutMs: policy.timeoutMs }),
        budget: policy.budget,
        request: {
          query: request.query,
          documents: bounded.map((candidate) => candidate.candidate.content),
        },
      },
      { workspaceId: request.workspaceId, signal: request.signal },
    );
    if (
      result.value.scores.length !== bounded.length ||
      result.value.scores.some((score) => !Number.isFinite(score))
    ) {
      throw new RetrievalError(
        "The reranker gateway returned an invalid score set.",
        "retrieval.invalidAiResult",
      );
    }
    return {
      operationId: result.operationId,
      candidates: bounded
        .map((candidate, index) => ({
          ...candidate,
          rerankerScore: result.value.scores[index] as number,
        }))
        .sort(compareRanked),
    };
  }

  private applyFinalBudgets(
    candidates: readonly FusedCandidate[],
    profile: RetrievalProfile,
  ): readonly RetrievalEvidence[] {
    const sourceCounts = new Map<string, number>();
    const evidence: RetrievalEvidence[] = [];
    let characters = 0;
    let tokens = 0;
    for (const candidate of candidates) {
      if (evidence.length >= profile.policy.maximumFinalResults) break;
      const sourceCount = sourceCounts.get(candidate.candidate.sourceId) ?? 0;
      if (
        sourceCount >=
        quotaFor(profile, candidate.candidate.sourceId).maximumFinalResults
      ) {
        continue;
      }
      const characterCount = candidate.candidate.content.length;
      const tokenCount = this.dependencies.tokens.count(
        candidate.candidate.content,
      );
      requireNonNegativeInteger(tokenCount, "Candidate token count");
      if (
        characters + characterCount > profile.policy.maximumCharacters ||
        tokens + tokenCount > profile.policy.maximumTokens
      ) {
        continue;
      }
      characters += characterCount;
      tokens += tokenCount;
      sourceCounts.set(candidate.candidate.sourceId, sourceCount + 1);
      evidence.push(immutableEvidence(candidate, tokenCount));
    }
    return Object.freeze(evidence);
  }

  private async persistSnapshot(
    request: RetrievalRequest,
    evidence: readonly RetrievalEvidence[],
    queryEmbeddingOperationIds: Readonly<Record<string, string>>,
    rerankerOperationId: string | undefined,
  ): Promise<RetrievalSnapshot> {
    const snapshot: RetrievalSnapshot = Object.freeze({
      id: request.snapshot.id,
      workspaceId: request.workspaceId,
      ...(request.snapshot.analysisId === undefined
        ? {}
        : { analysisId: request.snapshot.analysisId }),
      capturedAt: request.snapshot.capturedAt,
      query: request.query,
      profileId: request.profile.id,
      profileVersion: request.profile.version,
      queryEmbeddingOperationIds: Object.freeze({
        ...queryEmbeddingOperationIds,
      }),
      ...(rerankerOperationId === undefined ? {} : { rerankerOperationId }),
      evidence: Object.freeze([...evidence]),
    });
    await this.dependencies.snapshots.persist(snapshot);
    return snapshot;
  }
}
