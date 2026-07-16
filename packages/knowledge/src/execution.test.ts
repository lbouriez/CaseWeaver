import type { KnowledgeSource } from "@caseweaver/connector-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createProductionKnowledgeTextProfileRegistry,
  ImmutableKnowledgeTextProfileRegistry,
  KnowledgeIngestionService,
  KnowledgeSynchronizationCoordinator,
  type PinnedKnowledgeSourceConfiguration,
} from "./index.js";

const configuration: PinnedKnowledgeSourceConfiguration = {
  workspaceId: "workspace-1",
  sourceId: "source-1",
  sourceConfigurationVersionId: "source-config-1",
  connectorConfigurationVersionId: "connector-config-1",
  connectorRegistrationId: "connector-1",
  collection: {
    id: "collection-1",
    runtimeVersionId: "collection-runtime-1",
    embeddingBindingVersionId: "binding-1",
    embeddingProfileVersion: "embedding-v1",
    dimensions: 3,
    maximumInputTokens: 100,
    budget: { currency: "USD", hard: true },
  },
  normalizationProfile: { id: "text-normalization", version: "v1" },
  chunkingProfile: { id: "text-chunking", version: "v1" },
  synchronization: { triggers: [{ mode: "manual" }] },
  embeddingBatchSize: 10,
};

class EmptySnapshotSource implements KnowledgeSource {
  public readonly discoveries: unknown[] = [];

  public async *discover(request: unknown) {
    this.discoveries.push(request);
    yield {
      mode: "snapshot" as const,
      scanEpoch: { version: "scan-v1", value: "epoch-1" },
      items: [],
      complete: true,
    };
  }

  public async load(): Promise<never> {
    throw new Error("No load should occur for an empty snapshot.");
  }
}

function deferred<T = void>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  if (resolve === undefined || reject === undefined) {
    throw new Error("Deferred promise callbacks were not initialized.");
  }
  return { promise, resolve, reject };
}

class BlockingSnapshotSource implements KnowledgeSource {
  public readonly discoveries: unknown[] = [];
  public readonly started = deferred();
  private readonly completion = deferred();

  public async *discover(request: unknown) {
    this.discoveries.push(request);
    this.started.resolve();
    await this.completion.promise;
    yield {
      mode: "snapshot" as const,
      scanEpoch: { version: "scan-v1", value: "epoch-1" },
      items: [],
      complete: true,
    };
  }

  public complete(): void {
    this.completion.resolve();
  }

  public async load(): Promise<never> {
    throw new Error("No load should occur for an empty snapshot.");
  }
}

class AbortAwareSnapshotSource implements KnowledgeSource {
  public readonly discoveries: unknown[] = [];
  public readonly started = deferred();
  public signal: AbortSignal | undefined;

  public async *discover(request: unknown) {
    const control = request as { readonly signal: AbortSignal };
    this.discoveries.push(request);
    this.signal = control.signal;
    this.started.resolve();
    await new Promise<void>((_resolve, reject) => {
      control.signal.addEventListener(
        "abort",
        () => reject(control.signal.reason),
        { once: true },
      );
    });
  }

  public async load(): Promise<never> {
    throw new Error("No load should occur for a blocked discovery.");
  }
}

function ingestion(commit = vi.fn(async () => undefined)) {
  return {
    commit,
    service: new KnowledgeIngestionService({
      store: {
        findItem: async () => undefined,
        findReusableEmbeddings: async () => [],
        commit,
        recordFailedRevision: async () => undefined,
      },
      profiles: createProductionKnowledgeTextProfileRegistry(),
      ai: {} as never,
      ids: { next: () => "revision-1" },
      clock: { now: () => "2026-07-15T12:00:00.000Z" },
    }),
  };
}

describe("knowledge synchronization coordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("makes a full rescan an explicit reset and commits with the claimed fence", async () => {
    const source = new EmptySnapshotSource();
    const { service, commit } = ingestion();
    const claim = vi.fn(async () => ({
      fence: { value: "9" },
      cursor: { version: "cursor-v1", value: "prior" },
      expiresAt: "2026-07-15T12:01:00.000Z",
    }));
    const renew = vi.fn(async () => true);
    const cancel = vi.fn(async () => undefined);
    const coordinator = new KnowledgeSynchronizationCoordinator({
      resolver: { resolve: async () => configuration },
      executions: { claim, renew, cancel },
      ingestion: service,
      leaseMs: 30_000,
    });

    await expect(
      coordinator.execute({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        sourceConfigurationVersionId: "source-config-1",
        connectorConfigurationVersionId: "connector-config-1",
        mode: "fullRescan",
        source,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: "completed" });

    expect(source.discoveries).toEqual([
      expect.objectContaining({ mode: "fullRescan", reset: true }),
    ]);
    expect(source.discoveries[0]).not.toHaveProperty("cursor");
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ fence: { value: "9" } }),
    );
    expect(renew).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      fence: { value: "9" },
    });
  });

  it("rejects an unknown immutable profile before source discovery", async () => {
    const source = new EmptySnapshotSource();
    const { service } = ingestion();
    const coordinator = new KnowledgeSynchronizationCoordinator({
      resolver: {
        resolve: async () => ({
          ...configuration,
          normalizationProfile: { id: "missing", version: "v1" },
        }),
      },
      executions: {
        claim: async () => ({
          fence: { value: "1" },
          expiresAt: "2026-07-15T12:01:00.000Z",
        }),
        renew: async () => true,
        cancel: async () => undefined,
      },
      ingestion: service,
      leaseMs: 30_000,
    });

    await expect(
      coordinator.execute({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        sourceConfigurationVersionId: "source-config-1",
        connectorConfigurationVersionId: "connector-config-1",
        mode: "incremental",
        source,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "knowledge.textProfileUnavailable" });
    expect(source.discoveries).toEqual([]);
  });

  it("does not begin source I/O when the initial fence renewal fails", async () => {
    const source = new EmptySnapshotSource();
    const { service } = ingestion();
    const renew = vi.fn(async () => false);
    const cancel = vi.fn(async () => undefined);
    const coordinator = new KnowledgeSynchronizationCoordinator({
      resolver: { resolve: async () => configuration },
      executions: {
        claim: async () => ({
          fence: { value: "1" },
          expiresAt: "2026-07-15T12:01:00.000Z",
        }),
        renew,
        cancel,
      },
      ingestion: service,
      leaseMs: 30_000,
    });

    await expect(
      coordinator.execute({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        sourceConfigurationVersionId: "source-config-1",
        connectorConfigurationVersionId: "connector-config-1",
        mode: "incremental",
        source,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "knowledge.executionFenceUnavailable" });
    expect(renew).toHaveBeenCalledOnce();
    expect(source.discoveries).toEqual([]);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("renews the claimed fence repeatedly while a synchronization remains in flight", async () => {
    vi.useFakeTimers();
    const source = new BlockingSnapshotSource();
    const { service } = ingestion();
    const renew = vi.fn(async () => true);
    const cancel = vi.fn(async () => undefined);
    const inputController = new AbortController();
    const removeAbortListener = vi.spyOn(
      inputController.signal,
      "removeEventListener",
    );
    const coordinator = new KnowledgeSynchronizationCoordinator({
      resolver: { resolve: async () => configuration },
      executions: {
        claim: async () => ({
          fence: { value: "1" },
          expiresAt: "2026-07-15T12:01:00.000Z",
        }),
        renew,
        cancel,
      },
      ingestion: service,
      leaseMs: 1_000,
    });

    const execution = coordinator.execute({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      sourceConfigurationVersionId: "source-config-1",
      connectorConfigurationVersionId: "connector-config-1",
      mode: "incremental",
      source,
      signal: inputController.signal,
    });
    await source.started.promise;
    expect(renew).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(renew).toHaveBeenCalledTimes(4);

    source.complete();
    await expect(execution).resolves.toMatchObject({ kind: "completed" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(removeAbortListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(renew).toHaveBeenCalledTimes(4);
  });

  it("aborts in-flight source I/O and cleans up when a heartbeat loses its fence", async () => {
    vi.useFakeTimers();
    const source = new AbortAwareSnapshotSource();
    const { service } = ingestion();
    const renew = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const cancel = vi.fn(async () => undefined);
    const coordinator = new KnowledgeSynchronizationCoordinator({
      resolver: { resolve: async () => configuration },
      executions: {
        claim: async () => ({
          fence: { value: "1" },
          expiresAt: "2026-07-15T12:01:00.000Z",
        }),
        renew,
        cancel,
      },
      ingestion: service,
      leaseMs: 1_000,
    });

    const execution = coordinator.execute({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      sourceConfigurationVersionId: "source-config-1",
      connectorConfigurationVersionId: "connector-config-1",
      mode: "incremental",
      source,
      signal: new AbortController().signal,
    });
    const fenceLoss = expect(execution).rejects.toMatchObject({
      code: "knowledge.executionFenceUnavailable",
    });
    await source.started.promise;
    await vi.advanceTimersByTimeAsync(334);

    await fenceLoss;
    expect(source.signal?.aborted).toBe(true);
    expect(source.signal?.reason).toMatchObject({
      code: "knowledge.executionFenceUnavailable",
    });
    expect(cancel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it("requires an exact immutable ID/version pair from the profile registry", () => {
    const registry = new ImmutableKnowledgeTextProfileRegistry({
      normalization: [],
      chunking: [],
    });
    expect(
      registry.resolve({
        normalizationProfileId: "text-normalization",
        normalizationProfileVersion: "v1",
        chunkingProfileId: "text-chunking",
        chunkingProfileVersion: "v1",
      }),
    ).toBeUndefined();
  });
});
