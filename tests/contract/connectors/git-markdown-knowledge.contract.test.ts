import { describe, expect, it } from "vitest";
import {
  createGitMarkdownConfiguration,
  FakeGitRepository,
  fixtureOid,
  GitMarkdownKnowledgeSource,
} from "../../../connectors/git-markdown/src/index.js";
import type {
  AiExecutionContext,
  AiExecutionGateway,
  MeteredAiRequest,
  MeteredAiResult,
} from "../../../packages/ai-execution/src/index.js";
import type {
  CachedEmbedding,
  FailedRevisionDiagnostic,
  KnowledgeIngestionStore,
  KnowledgeMutation,
  NewCachedEmbedding,
  StoredKnowledgeItem,
} from "../../../packages/knowledge/src/index.js";
import { KnowledgeIngestionService } from "../../../packages/knowledge/src/index.js";

const reference = {
  connectorInstanceId: "git-docs",
  resourceType: "document",
  externalId: "docs/install.md",
} as const;

const activeEmbeddingSpace = {
  embeddingBindingVersionId: "binding.v1",
  embeddingProfileVersion: "embedding.v1",
  dimensions: 3,
  normalizationProfileVersion: "normalization.v1",
} as const;

class UnchangedBlobStore implements KnowledgeIngestionStore {
  public readonly commits: {
    readonly mutations: readonly KnowledgeMutation[];
    readonly newEmbeddings: readonly NewCachedEmbedding[];
  }[] = [];

  public async findItem(): Promise<StoredKnowledgeItem> {
    return {
      documentId: "document:install",
      activeRevisionId: "revision:install",
      activeContentHash: "existing-content",
      activeEmbeddingSpace,
      lastSuccessfulFingerprint: {
        version: "git-blob.v1",
        value: fixtureOid("b"),
      },
    };
  }

  public async findReusableEmbeddings(): Promise<readonly CachedEmbedding[]> {
    throw new Error("Unchanged Git blobs must not look up embeddings.");
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
    throw new Error("An unchanged Git blob must not record a failed revision.");
  }
}

class ForbiddenAiGateway implements AiExecutionGateway {
  public calls = 0;

  public async execute<TResult = unknown>(
    _request: MeteredAiRequest,
    _context: AiExecutionContext,
  ): Promise<MeteredAiResult<TResult>> {
    this.calls += 1;
    throw new Error("An unchanged Git blob must not invoke AI.");
  }
}

describe("Git Markdown knowledge ingestion contract", () => {
  it("uses the blob fingerprint to avoid connector loads, normalization, and AI", async () => {
    const repository = new FakeGitRepository([
      {
        ref: "branch:main",
        commitSha: fixtureOid("a"),
        files: [
          {
            path: "docs/install.md",
            blobOid: fixtureOid("b"),
            content: "# Install\n",
          },
        ],
      },
    ]);
    const source = new GitMarkdownKnowledgeSource({
      repository,
      configuration: createGitMarkdownConfiguration(),
    });
    const store = new UnchangedBlobStore();
    const ai = new ForbiddenAiGateway();
    let normalizations = 0;
    const service = new KnowledgeIngestionService({
      store,
      ai,
      ids: { next: () => "unused-revision" },
      clock: { now: () => "2026-07-13T20:00:00.000Z" },
      profiles: {
        resolve: () =>
          Object.freeze({
            normalizer: {
              normalize: async () => {
                normalizations += 1;
                throw new Error(
                  "An unchanged Git blob must not be normalized.",
                );
              },
            },
            chunker: {
              chunk: async () => {
                throw new Error("An unchanged Git blob must not be chunked.");
              },
            },
          }),
      },
    });

    const result = await service.synchronize({
      source,
      signal: new AbortController().signal,
      discovery: {
        mode: "incremental",
        reset: false,
        signal: new AbortController().signal,
      },
      configuration: {
        id: "git-source",
        workspaceId: "workspace-1",
        connectorInstanceId: "git-docs",
        normalizationProfileId: "text-normalization",
        normalizationProfileVersion: "normalization.v1",
        chunkingProfileId: "text-chunking",
        chunkingProfileVersion: "chunking.v1",
        embeddingBatchSize: 10,
        synchronization: { triggers: [{ mode: "manual" }] },
        collection: {
          id: "collection-1",
          ...activeEmbeddingSpace,
          maximumInputTokens: 100,
          budget: { currency: "USD", hard: false },
        },
      },
    });

    expect(result).toMatchObject({
      mode: "snapshot",
      processed: 1,
      fingerprintNoops: 1,
      normalizedNoops: 0,
      embeddedChunks: 0,
    });
    expect(repository.readCalls).toEqual([]);
    expect(normalizations).toBe(0);
    expect(ai.calls).toBe(0);
    expect(store.commits).toEqual([
      expect.objectContaining({
        mutations: [
          expect.objectContaining({
            kind: "observe",
            reference,
            fingerprint: { version: "git-blob.v1", value: fixtureOid("b") },
          }),
        ],
        newEmbeddings: [],
      }),
    ]);
  });
});
