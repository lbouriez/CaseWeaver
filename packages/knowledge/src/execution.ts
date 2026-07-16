import type { KnowledgeSource } from "@caseweaver/connector-sdk";

import type { KnowledgeIngestionService } from "./ingestion.js";
import type {
  KnowledgeExecutionMode,
  KnowledgeSourceExecutionFence,
  PinnedKnowledgeSourceConfiguration,
  PinnedKnowledgeSourceConfigurationResolver,
} from "./types.js";

export interface KnowledgeSourceExecutionLease {
  readonly fence: KnowledgeSourceExecutionFence;
  readonly cursor?: Readonly<{
    readonly version: string;
    readonly value: string;
  }>;
  readonly expiresAt: string;
}

export interface KnowledgeSourceExecutionStore {
  claim(
    input: Readonly<{
      readonly workspaceId: string;
      readonly sourceId: string;
      readonly mode: KnowledgeExecutionMode;
      readonly leaseMs: number;
    }>,
  ): Promise<KnowledgeSourceExecutionLease | undefined>;
  renew(
    input: Readonly<{
      readonly workspaceId: string;
      readonly sourceId: string;
      readonly fence: KnowledgeSourceExecutionFence;
      readonly leaseMs: number;
    }>,
  ): Promise<boolean>;
  cancel(
    input: Readonly<{
      readonly workspaceId: string;
      readonly sourceId: string;
      readonly fence: KnowledgeSourceExecutionFence;
    }>,
  ): Promise<void>;
}

export class KnowledgeSourceRuntimeUnavailableError extends Error {
  public readonly code = "knowledge.runtimeUnavailable";
  public readonly retryable = false;

  public constructor() {
    super("Knowledge source runtime configuration is unavailable.");
    this.name = "KnowledgeSourceRuntimeUnavailableError";
  }
}

/** The current worker lost, expired, or never acquired the durable source fence. */
export class KnowledgeExecutionFenceError extends Error {
  public readonly code = "knowledge.executionFenceUnavailable";
  public readonly retryable = false;

  public constructor() {
    super("Knowledge source execution fence is unavailable.");
    this.name = "KnowledgeExecutionFenceError";
  }
}

export interface KnowledgeSynchronizationCoordinatorDependencies {
  readonly resolver: PinnedKnowledgeSourceConfigurationResolver;
  readonly executions: KnowledgeSourceExecutionStore;
  readonly ingestion: KnowledgeIngestionService;
  readonly leaseMs: number;
}

export type KnowledgeSynchronizationExecutionResult =
  | Readonly<{
      readonly kind: "completed";
      readonly result: Awaited<
        ReturnType<KnowledgeIngestionService["synchronize"]>
      >;
    }>
  | Readonly<{ readonly kind: "alreadyRunning" }>
  | Readonly<{ readonly kind: "unavailable" }>;

/**
 * Coordinates a version-pinned synchronization. It makes the rescan reset a
 * first-class control value and gives ingestion the opaque source fence that
 * PostgreSQL verifies in the final activation/cursor transaction.
 */
export class KnowledgeSynchronizationCoordinator {
  public constructor(
    private readonly dependencies: KnowledgeSynchronizationCoordinatorDependencies,
  ) {
    assertLeaseMs(dependencies.leaseMs);
  }

  public async execute(
    input: Readonly<{
      readonly workspaceId: string;
      readonly sourceId: string;
      readonly sourceConfigurationVersionId: string;
      readonly connectorConfigurationVersionId: string;
      readonly mode: KnowledgeExecutionMode;
      readonly source: KnowledgeSource;
      readonly signal: AbortSignal;
    }>,
  ): Promise<KnowledgeSynchronizationExecutionResult> {
    const configuration = await this.dependencies.resolver.resolve({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      sourceConfigurationVersionId: input.sourceConfigurationVersionId,
      connectorConfigurationVersionId: input.connectorConfigurationVersionId,
    });
    if (configuration === undefined)
      return Object.freeze({ kind: "unavailable" });
    const lease = await this.dependencies.executions.claim({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      mode: input.mode,
      leaseMs: this.dependencies.leaseMs,
    });
    if (lease === undefined) return Object.freeze({ kind: "alreadyRunning" });

    const composedSignal = composeAbortSignal(input.signal);
    let ownsLease = true;
    let fenceError: KnowledgeExecutionFenceError | undefined;
    const loseFence = () => {
      ownsLease = false;
      fenceError ??= new KnowledgeExecutionFenceError();
      composedSignal.abort(fenceError);
    };
    let heartbeat: KnowledgeExecutionHeartbeat | undefined;
    try {
      // Renew before discovery starts. A claim may have been valid only until the
      // first database round trip, so no connector or AI I/O is safe before this.
      if (!(await this.renew(input, lease))) {
        loseFence();
        throw fenceError;
      }
      heartbeat = new KnowledgeExecutionHeartbeat({
        renew: () => this.renew(input, lease),
        leaseMs: this.dependencies.leaseMs,
        onFenceLost: loseFence,
      });
      heartbeat.start();
      const result = await this.dependencies.ingestion.synchronize({
        configuration: asKnowledgeSourceConfiguration(configuration),
        source: input.source,
        signal: composedSignal.signal,
        discovery: Object.freeze({
          mode: input.mode,
          reset: input.mode === "fullRescan",
          signal: composedSignal.signal,
          ...(input.mode === "incremental" && lease.cursor !== undefined
            ? { cursor: lease.cursor }
            : {}),
        }),
        fence: lease.fence,
      });
      if (fenceError !== undefined) throw fenceError;
      return Object.freeze({ kind: "completed", result });
    } catch (error) {
      // A lease loss must never be surfaced as a connector, AI, or generic abort
      // error. It is the actionable, stable outcome for job retry policy.
      if (fenceError !== undefined) throw fenceError;
      throw error;
    } finally {
      heartbeat?.dispose();
      composedSignal.dispose();
      // `cancel` is an exact-fence conditional update. Once renewal reported a
      // lost fence, another owner may hold the source and this worker must not
      // attempt to release it.
      if (ownsLease) {
        await this.dependencies.executions.cancel({
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          fence: lease.fence,
        });
      }
    }
  }

  private async renew(
    input: Readonly<{
      readonly workspaceId: string;
      readonly sourceId: string;
    }>,
    lease: KnowledgeSourceExecutionLease,
  ): Promise<boolean> {
    try {
      return await this.dependencies.executions.renew({
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        fence: lease.fence,
        leaseMs: this.dependencies.leaseMs,
      });
    } catch {
      // A failed heartbeat cannot prove that the fence remains valid. Stop work
      // until a new command safely claims a fresh fence.
      return false;
    }
  }
}

interface ComposedAbortSignal {
  readonly signal: AbortSignal;
  abort(reason: unknown): void;
  dispose(): void;
}

function composeAbortSignal(supplied: AbortSignal): ComposedAbortSignal {
  const controller = new AbortController();
  const abortFromSupplied = () => controller.abort(supplied.reason);
  supplied.addEventListener("abort", abortFromSupplied, { once: true });
  if (supplied.aborted) abortFromSupplied();
  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    dispose: () => supplied.removeEventListener("abort", abortFromSupplied),
  };
}

interface KnowledgeExecutionHeartbeatDependencies {
  readonly renew: () => Promise<boolean>;
  readonly leaseMs: number;
  readonly onFenceLost: () => void;
}

/**
 * Keeps a source fence alive for the whole synchronization without overlapping
 * database renewals. A false result or renewal failure always aborts the job.
 */
class KnowledgeExecutionHeartbeat {
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  public constructor(
    private readonly dependencies: KnowledgeExecutionHeartbeatDependencies,
  ) {}

  public start(): void {
    this.schedule();
  }

  public dispose(): void {
    this.disposed = true;
    if (this.timeout !== undefined) clearTimeout(this.timeout);
    this.timeout = undefined;
  }

  private schedule(): void {
    if (this.disposed) return;
    this.timeout = setTimeout(() => {
      this.timeout = undefined;
      void this.heartbeat();
    }, heartbeatIntervalMs(this.dependencies.leaseMs));
  }

  private async heartbeat(): Promise<void> {
    if (this.disposed) return;
    const renewed = await this.dependencies.renew();
    if (this.disposed) return;
    if (!renewed) {
      this.dependencies.onFenceLost();
      return;
    }
    this.schedule();
  }
}

function heartbeatIntervalMs(leaseMs: number): number {
  // A third leaves room for transient database scheduling latency while the
  // lower/upper bounds prevent both tight loops and excessively stale leases.
  return Math.max(250, Math.min(30_000, Math.floor(leaseMs / 3)));
}

function asKnowledgeSourceConfiguration(
  input: PinnedKnowledgeSourceConfiguration,
) {
  return Object.freeze({
    id: input.sourceId,
    workspaceId: input.workspaceId,
    connectorInstanceId: input.connectorRegistrationId,
    collection: input.collection,
    normalizationProfileId: input.normalizationProfile.id,
    normalizationProfileVersion: input.normalizationProfile.version,
    chunkingProfileId: input.chunkingProfile.id,
    chunkingProfileVersion: input.chunkingProfile.version,
    synchronization: input.synchronization,
    embeddingBatchSize: input.embeddingBatchSize,
  });
}

function assertLeaseMs(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 900_000) {
    throw new RangeError(
      "Knowledge source execution lease duration is invalid.",
    );
  }
}
