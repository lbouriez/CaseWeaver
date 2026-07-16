import {
  createWorkerRuntime,
  type WorkerCommandDispatcher,
  type WorkerRuntime,
} from "./runtime.js";

export interface WorkerQueueRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  work(
    consumer: Pick<WorkerRuntime, "consume">,
    options?: Readonly<{ readonly teamSize?: number }>,
  ): Promise<string>;
}

export interface WorkerOutboxRelay {
  runOnce(limit: number): Promise<Readonly<{ readonly delivered: number }>>;
}

export interface WorkerProcess {
  start(): Promise<void>;
  stop(): Promise<void>;
  runRelayOnce(): Promise<Readonly<{ readonly delivered: number }>>;
}

export interface WorkerProcessDiagnostics {
  record(
    input: Readonly<{
      readonly name: "worker.outbox-relay.failed";
      readonly failureCode: string;
    }>,
  ): void;
}

export interface WorkerProcessDependencies {
  /** A PgBossDurableMessageQueue in production; no direct dispatch is allowed. */
  readonly queue: WorkerQueueRuntime;
  readonly dispatcher: WorkerCommandDispatcher;
  /** The application OutboxRelay built from the same queue and durable store. */
  readonly relay: WorkerOutboxRelay;
  readonly relayBatchSize?: number;
  readonly relayPollIntervalMs?: number;
  readonly workerTeamSize?: number;
  readonly diagnostics?: WorkerProcessDiagnostics;
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
  return "worker.outboxRelayFailed";
}

class DefaultWorkerProcess implements WorkerProcess {
  private readonly runtime: WorkerRuntime;
  private readonly relayBatchSize: number;
  private readonly relayPollIntervalMs: number;
  private relayTimer: NodeJS.Timeout | undefined;
  private relayInFlight:
    | Promise<Readonly<{ readonly delivered: number }>>
    | undefined;
  private queueStarted = false;
  private started = false;

  public constructor(private readonly dependencies: WorkerProcessDependencies) {
    this.runtime = createWorkerRuntime(dependencies.dispatcher);
    this.relayBatchSize = dependencies.relayBatchSize ?? 25;
    this.relayPollIntervalMs = dependencies.relayPollIntervalMs ?? 1_000;
    if (
      !Number.isInteger(this.relayBatchSize) ||
      this.relayBatchSize < 1 ||
      this.relayBatchSize > 100
    ) {
      throw new RangeError(
        "Worker relay batch size must be between 1 and 100.",
      );
    }
    if (
      !Number.isInteger(this.relayPollIntervalMs) ||
      this.relayPollIntervalMs < 100 ||
      this.relayPollIntervalMs > 3_600_000
    ) {
      throw new RangeError(
        "Worker relay poll interval must be between 100 and 3600000 milliseconds.",
      );
    }
    if (
      dependencies.workerTeamSize !== undefined &&
      (!Number.isInteger(dependencies.workerTeamSize) ||
        dependencies.workerTeamSize < 1)
    ) {
      throw new RangeError("Worker team size must be a positive integer.");
    }
  }

  public async start(): Promise<void> {
    if (this.started) throw new Error("Worker process is already started.");
    try {
      await this.dependencies.queue.start();
      this.queueStarted = true;
      await this.dependencies.queue.work(this.runtime, {
        ...(this.dependencies.workerTeamSize === undefined
          ? {}
          : { teamSize: this.dependencies.workerTeamSize }),
      });
      await this.runRelayOnce();
      this.relayTimer = setInterval(() => {
        void this.runRelayOnce().catch((error: unknown) => {
          this.dependencies.diagnostics?.record({
            name: "worker.outbox-relay.failed",
            failureCode: failureCode(error),
          });
        });
      }, this.relayPollIntervalMs);
      this.started = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.relayTimer !== undefined) {
      clearInterval(this.relayTimer);
      this.relayTimer = undefined;
    }
    try {
      await this.relayInFlight;
    } finally {
      if (this.queueStarted) {
        this.queueStarted = false;
        await this.dependencies.queue.stop();
      }
      this.started = false;
    }
  }

  public async runRelayOnce(): Promise<
    Readonly<{ readonly delivered: number }>
  > {
    if (this.relayInFlight !== undefined) return this.relayInFlight;
    const run = this.dependencies.relay.runOnce(this.relayBatchSize);
    this.relayInFlight = run;
    try {
      return await run;
    } finally {
      if (this.relayInFlight === run) this.relayInFlight = undefined;
    }
  }
}

/**
 * Hosts the normal envelope dispatcher, PostgreSQL durable queue subscription,
 * and application OutboxRelay. The relay publishes through the same queue;
 * this process never dispatches an outbox envelope in memory.
 */
export function createWorkerProcess(
  dependencies: WorkerProcessDependencies,
): WorkerProcess {
  return new DefaultWorkerProcess(dependencies);
}

export interface WorkerSignalProcess {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
  exitCode?: number | string | null;
}

export function attachWorkerShutdownSignals(
  runtime: WorkerProcess,
  process: WorkerSignalProcess,
): () => void {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void runtime.stop().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return () => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  };
}
