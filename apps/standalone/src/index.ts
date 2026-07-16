import {
  type Clock,
  type DurableMessageQueue,
  OutboxRelay,
  type OutboxStore,
  type UnitOfWork,
} from "@caseweaver/application";
import type { Envelope } from "@caseweaver/domain";
import {
  createDiagnosticEvent,
  type DiagnosticSink,
  type OpenTelemetryConfig,
  startOpenTelemetry,
} from "@caseweaver/observability";

export interface ManagedProcess {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DurableEnvelopeConsumer {
  consume(envelope: Envelope, signal: AbortSignal): Promise<void>;
}

/**
 * The queue is both the application DurableMessageQueue used by OutboxRelay and
 * the worker subscription. It intentionally has no direct-dispatch operation.
 */
export interface DurableQueueRuntime extends DurableMessageQueue {
  start(): Promise<void>;
  stop(): Promise<void>;
  work(
    consumer: DurableEnvelopeConsumer,
    options?: { readonly teamSize?: number },
  ): Promise<string>;
}

export interface StandaloneRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  runRelayOnce(): Promise<{ readonly delivered: number }>;
}

export interface StandaloneRuntimeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly outbox: OutboxStore;
  readonly clock: Clock;
  readonly queue: DurableQueueRuntime;
  readonly worker: DurableEnvelopeConsumer;
  readonly api: ManagedProcess;
  readonly webhook: ManagedProcess;
  readonly scheduler: ManagedProcess;
  readonly relayBatchSize?: number;
  readonly relayPollIntervalMs?: number;
  readonly workerTeamSize?: number;
  readonly telemetry?: OpenTelemetryConfig;
  readonly diagnostics?: DiagnosticSink;
}

function assertRelayConfiguration(
  batchSize: number,
  pollIntervalMs: number,
  workerTeamSize: number | undefined,
): void {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new RangeError(
      "Standalone relay batch size must be between 1 and 100.",
    );
  }
  if (
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 100 ||
    pollIntervalMs > 3_600_000
  ) {
    throw new RangeError(
      "Standalone relay poll interval must be between 100 and 3600000 milliseconds.",
    );
  }
  if (
    workerTeamSize !== undefined &&
    (!Number.isInteger(workerTeamSize) || workerTeamSize < 1)
  ) {
    throw new RangeError(
      "Standalone worker team size must be a positive integer.",
    );
  }
}

function failureCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/u.test(error.code)
  ) {
    return error.code;
  }
  return "standalone.backgroundFailure";
}

class DefaultStandaloneRuntime implements StandaloneRuntime {
  private readonly relay: OutboxRelay;
  private readonly relayBatchSize: number;
  private readonly relayPollIntervalMs: number;
  private readonly startedProcesses: ManagedProcess[] = [];
  private queueStarted = false;
  private starting = false;
  private started = false;
  private relayTimer: NodeJS.Timeout | undefined;
  private relayInFlight: Promise<{ readonly delivered: number }> | undefined;
  private telemetry: Awaited<ReturnType<typeof startOpenTelemetry>>;

  public constructor(
    private readonly dependencies: StandaloneRuntimeDependencies,
  ) {
    this.relayBatchSize = dependencies.relayBatchSize ?? 25;
    this.relayPollIntervalMs = dependencies.relayPollIntervalMs ?? 1_000;
    assertRelayConfiguration(
      this.relayBatchSize,
      this.relayPollIntervalMs,
      dependencies.workerTeamSize,
    );
    this.relay = new OutboxRelay(
      dependencies.unitOfWork,
      dependencies.outbox,
      dependencies.queue,
      dependencies.clock,
    );
  }

  public async start(): Promise<void> {
    if (this.started || this.starting) {
      throw new Error("Standalone runtime is already started.");
    }
    this.starting = true;
    try {
      this.telemetry = await startOpenTelemetry(this.dependencies.telemetry);
      await this.dependencies.queue.start();
      this.queueStarted = true;
      await this.dependencies.queue.work(this.dependencies.worker, {
        ...(this.dependencies.workerTeamSize === undefined
          ? {}
          : { teamSize: this.dependencies.workerTeamSize }),
      });

      for (const process of [
        this.dependencies.scheduler,
        this.dependencies.api,
        this.dependencies.webhook,
      ]) {
        await process.start();
        this.startedProcesses.push(process);
      }

      await this.runRelayOnce();
      this.relayTimer = setInterval(() => {
        void this.runRelayOnce().catch((error: unknown) => {
          this.recordBackgroundFailure(error);
        });
      }, this.relayPollIntervalMs);
      this.started = true;
    } catch (error) {
      try {
        await this.stopResources();
      } catch (cleanupError) {
        this.recordBackgroundFailure(cleanupError);
      }
      throw error;
    } finally {
      this.starting = false;
    }
  }

  public async stop(): Promise<void> {
    if (!this.started && !this.starting) return;
    try {
      await this.stopResources();
    } finally {
      this.started = false;
    }
  }

  public async runRelayOnce(): Promise<{ readonly delivered: number }> {
    if (this.relayInFlight !== undefined) return this.relayInFlight;
    const run = this.relay.runOnce(this.relayBatchSize);
    this.relayInFlight = run;
    try {
      return await run;
    } finally {
      if (this.relayInFlight === run) this.relayInFlight = undefined;
    }
  }

  private recordBackgroundFailure(error: unknown): void {
    this.dependencies.diagnostics?.record(
      createDiagnosticEvent({
        name: "standalone.outbox-relay.failed",
        severity: "error",
        attributes: {
          component: "outboxRelay",
          failureCode: failureCode(error),
        },
      }),
    );
  }

  private async stopResources(): Promise<void> {
    if (this.relayTimer !== undefined) {
      clearInterval(this.relayTimer);
      this.relayTimer = undefined;
    }

    const failures: unknown[] = [];
    for (const process of this.startedProcesses.splice(0).reverse()) {
      try {
        await process.stop();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await this.relayInFlight;
    } catch (error) {
      failures.push(error);
    }
    if (this.queueStarted) {
      try {
        await this.dependencies.queue.stop();
      } catch (error) {
        failures.push(error);
      } finally {
        this.queueStarted = false;
      }
    }
    if (this.telemetry !== undefined) {
      try {
        await this.telemetry.shutdown();
      } catch (error) {
        failures.push(error);
      } finally {
        this.telemetry = undefined;
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Standalone runtime shutdown failed.");
    }
  }
}

/**
 * Co-locates process lifecycle only. Queue delivery still flows from
 * OutboxRelay through DurableMessageQueue and into the normal worker consumer.
 */
export function createStandaloneRuntime(
  dependencies: StandaloneRuntimeDependencies,
): StandaloneRuntime {
  return new DefaultStandaloneRuntime(dependencies);
}

export * from "./process.js";
export * from "./production-bootstrap.js";
