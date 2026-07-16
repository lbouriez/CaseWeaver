import type { SchedulerRunResult } from "@caseweaver/scheduling";

export interface ScheduledProcessRuntime {
  runOnce(limit?: number): Promise<SchedulerRunResult>;
}

export interface SchedulerProcess {
  start(): Promise<void>;
  stop(): Promise<void>;
  runOnce(): Promise<readonly SchedulerRunResult[]>;
}

export interface SchedulerProcessDiagnostics {
  record(
    input: Readonly<{
      readonly name: "scheduler.poll.failed";
      readonly failureCode: string;
    }>,
  ): void;
}

export interface SchedulerProcessDependencies {
  readonly runtimes: readonly ScheduledProcessRuntime[];
  readonly pollIntervalMs?: number;
  readonly batchLimit?: number;
  readonly diagnostics?: SchedulerProcessDiagnostics;
}

export interface SchedulerSignalProcess {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
  exitCode?: number | string | null;
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
  return "scheduler.pollFailed";
}

class DefaultSchedulerProcess implements SchedulerProcess {
  private readonly pollIntervalMs: number;
  private readonly batchLimit: number | undefined;
  private started = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private inFlight: Promise<readonly SchedulerRunResult[]> | undefined;

  public constructor(
    private readonly dependencies: SchedulerProcessDependencies,
  ) {
    this.pollIntervalMs = dependencies.pollIntervalMs ?? 1_000;
    this.batchLimit = dependencies.batchLimit;
    if (
      !Number.isInteger(this.pollIntervalMs) ||
      this.pollIntervalMs < 100 ||
      this.pollIntervalMs > 3_600_000
    ) {
      throw new RangeError(
        "Scheduler poll interval must be between 100 and 3600000 milliseconds.",
      );
    }
    if (
      this.batchLimit !== undefined &&
      (!Number.isInteger(this.batchLimit) ||
        this.batchLimit < 1 ||
        this.batchLimit > 100)
    ) {
      throw new RangeError("Scheduler batch limit must be between 1 and 100.");
    }
    if (dependencies.runtimes.length === 0) {
      throw new RangeError("Scheduler process requires at least one runtime.");
    }
  }

  public async start(): Promise<void> {
    if (this.started) throw new Error("Scheduler process is already started.");
    // A failed first poll is a startup failure, not a deceptively ready process.
    await this.runOnce();
    this.started = true;
    this.pollTimer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.dependencies.diagnostics?.record({
          name: "scheduler.poll.failed",
          failureCode: failureCode(error),
        });
      });
    }, this.pollIntervalMs);
  }

  public async stop(): Promise<void> {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    try {
      await this.inFlight;
    } finally {
      this.started = false;
    }
  }

  public async runOnce(): Promise<readonly SchedulerRunResult[]> {
    if (this.inFlight !== undefined) return this.inFlight;
    const poll = Promise.all(
      this.dependencies.runtimes.map((runtime) =>
        runtime.runOnce(this.batchLimit),
      ),
    );
    this.inFlight = poll;
    try {
      return await poll;
    } finally {
      if (this.inFlight === poll) this.inFlight = undefined;
    }
  }
}

/** Polls already-composed durable schedule stores without running work directly. */
export function createSchedulerProcess(
  dependencies: SchedulerProcessDependencies,
): SchedulerProcess {
  return new DefaultSchedulerProcess(dependencies);
}

export function attachSchedulerShutdownSignals(
  runtime: SchedulerProcess,
  process: SchedulerSignalProcess,
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
