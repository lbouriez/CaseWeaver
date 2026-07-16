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

class ProductionStandaloneHost implements StandaloneHostRuntime {
  private readonly started: ManagedProcess[] = [];
  private telemetry: Awaited<ReturnType<typeof startOpenTelemetry>>;
  private stopping = false;
  private active = false;

  public constructor(
    private readonly environment: NodeJS.ProcessEnv,
    private readonly processes: readonly ManagedProcess[],
  ) {}

  public async start(): Promise<void> {
    if (this.active || this.stopping) {
      throw new Error("Standalone runtime is already started or stopped.");
    }
    try {
      this.telemetry = await startOpenTelemetry(
        resolveOpenTelemetryConfig(this.environment, "caseweaver-standalone"),
      );
      for (const process of this.processes) {
        await process.start();
        this.started.push(process);
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
    for (const process of this.started.splice(0).reverse()) {
      try {
        await process.stop();
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
  const [worker, scheduler, api, webhook] = await Promise.all([
    createProductionWorkerRuntimeFromEnvironment(environment),
    createSchedulerRuntimeFromEnvironment(environment),
    createApiRuntimeFromEnvironment(environment, { startTelemetry: false }),
    createWebhookRuntimeFromEnvironment(environment),
  ]);
  return new ProductionStandaloneHost(environment, [
    asManaged(worker),
    asManaged(scheduler),
    asManaged(api),
    asManaged(webhook),
  ]);
}

function asManaged(
  value: WorkerProcess | SchedulerProcess | ApiRuntime | WebhookRuntime,
): ManagedProcess {
  return value;
}
