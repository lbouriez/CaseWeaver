import {
  createApiRuntimeFromEnvironment,
  type ApiRuntime,
} from "@caseweaver/api";
import {
  resolveOpenTelemetryConfig,
  startOpenTelemetry,
} from "@caseweaver/observability";
import {
  createSchedulerRuntimeFromEnvironment,
  type SchedulerProcess,
} from "@caseweaver/scheduler";
import {
  createWebhookRuntimeFromEnvironment,
  type WebhookRuntime,
} from "@caseweaver/webhook";
import {
  createProductionWorkerRuntimeFromEnvironment,
  type WorkerProcess,
} from "@caseweaver/worker";

import type { ManagedProcess } from "./index.js";

export interface StandaloneHostRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const standaloneStartupStages = [
  "worker.compose",
  "scheduler.compose",
  "api.compose",
  "webhook.compose",
  "worker.start",
  "scheduler.start",
  "api.start",
  "webhook.start",
] as const;

export type StandaloneStartupStage = (typeof standaloneStartupStages)[number];

/** A finite, safe-to-log startup phase; it intentionally retains no cause. */
export class StandaloneStartupError extends Error {
  public readonly code: `standalone.${StandaloneStartupStage}`;

  public constructor(stage: StandaloneStartupStage) {
    super("Standalone lifecycle startup failed.");
    this.name = "StandaloneStartupError";
    this.code = `standalone.${stage}`;
  }
}

interface NamedManagedProcess {
  readonly stage: Extract<StandaloneStartupStage, `${string}.start`>;
  readonly process: ManagedProcess;
}

class ProductionStandaloneHost implements StandaloneHostRuntime {
  private readonly started: NamedManagedProcess[] = [];
  private telemetry: Awaited<ReturnType<typeof startOpenTelemetry>>;
  private stopping = false;
  private active = false;

  public constructor(
    private readonly environment: NodeJS.ProcessEnv,
    private readonly processes: readonly NamedManagedProcess[],
  ) {}

  public async start(): Promise<void> {
    if (this.active || this.stopping) {
      throw new Error("Standalone runtime is already started or stopped.");
    }
    try {
      this.telemetry = await startOpenTelemetry(
        resolveOpenTelemetryConfig(this.environment, "caseweaver-standalone"),
      );
      for (const item of this.processes) {
        try {
          await item.process.start();
        } catch {
          throw new StandaloneStartupError(item.stage);
        }
        this.started.push(item);
      }
      this.active = true;
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.stopping || (!this.active && this.started.length === 0)) return;
    await this.close();
  }

  private async close(): Promise<void> {
    this.stopping = true;
    const failures: unknown[] = [];
    for (const item of this.started.splice(0).reverse()) {
      try {
        await item.process.stop();
      } catch (error) {
        failures.push(error);
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
    this.active = false;
    if (failures.length > 0) {
      throw new AggregateError(failures, "Standalone shutdown failed.");
    }
  }
}

/**
 * Composes the same separate production services used in distributed mode.
 * The worker alone owns pg-boss consumption and outbox relay, so standalone
 * never adds a second in-memory dispatch route or duplicate queue consumer.
 */
export async function createStandaloneRuntimeFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<StandaloneHostRuntime> {
  const worker = await composeStandaloneProcess("worker.compose", () =>
    createProductionWorkerRuntimeFromEnvironment(environment),
  );
  const scheduler = await composeStandaloneProcess("scheduler.compose", () =>
    createSchedulerRuntimeFromEnvironment(environment),
  );
  const api = await composeStandaloneProcess("api.compose", () =>
    createApiRuntimeFromEnvironment(environment, { startTelemetry: false }),
  );
  const webhook = await composeStandaloneProcess("webhook.compose", () =>
    createWebhookRuntimeFromEnvironment(environment),
  );
  return new ProductionStandaloneHost(environment, [
    { stage: "worker.start", process: asManaged(worker) },
    { stage: "scheduler.start", process: asManaged(scheduler) },
    { stage: "api.start", process: asManaged(api) },
    { stage: "webhook.start", process: asManaged(webhook) },
  ]);
}

async function composeStandaloneProcess<T>(
  stage: Extract<StandaloneStartupStage, `${string}.compose`>,
  compose: () => Promise<T>,
): Promise<T> {
  try {
    return await compose();
  } catch {
    throw new StandaloneStartupError(stage);
  }
}

function asManaged(
  value: WorkerProcess | SchedulerProcess | ApiRuntime | WebhookRuntime,
): ManagedProcess {
  return value;
}
