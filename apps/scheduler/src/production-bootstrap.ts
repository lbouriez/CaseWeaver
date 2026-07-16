import {
  PostgresCaseAnalysisScheduleStore,
  PostgresKnowledgeScheduleStore,
} from "@caseweaver/postgres";
import type {
  CaseAnalysisScheduleStore,
  KnowledgeScheduleStore,
  SchedulerClock,
} from "@caseweaver/scheduling";
import { Pool } from "pg";

import {
  createSchedulerProcess,
  type SchedulerProcess,
  type SchedulerProcessDependencies,
} from "./process.js";
import {
  createCaseAnalysisSchedulerRuntime,
  createSchedulerRuntime,
} from "./runtime.js";

export interface SchedulerRuntimeConfiguration {
  readonly databaseUrl: string;
  readonly pollIntervalMs: number;
  readonly batchLimit: number;
  readonly leaseMs: number;
}

/** Injectable app-local factories keep production pool ownership testable. */
export interface SchedulerRuntimeBootstrapDependencies {
  readonly createPool: (databaseUrl: string) => Pool;
  readonly createKnowledgeScheduleStore: (pool: Pool) => KnowledgeScheduleStore;
  readonly createCaseAnalysisScheduleStore: (
    pool: Pool,
  ) => CaseAnalysisScheduleStore;
  readonly clock: SchedulerClock;
  readonly createProcess: (
    dependencies: SchedulerProcessDependencies,
  ) => SchedulerProcess;
}

const productionDependencies: SchedulerRuntimeBootstrapDependencies =
  Object.freeze({
    createPool: (databaseUrl: string) =>
      new Pool({ connectionString: databaseUrl }),
    createKnowledgeScheduleStore: (pool: Pool) =>
      new PostgresKnowledgeScheduleStore(pool),
    createCaseAnalysisScheduleStore: (pool: Pool) =>
      new PostgresCaseAnalysisScheduleStore(pool),
    clock: Object.freeze({ now: () => new Date().toISOString() }),
    createProcess: createSchedulerProcess,
  });

export class SchedulerConfigurationError extends Error {
  public readonly code = "scheduler.invalidConfiguration";
  public readonly retryable = false;

  public constructor() {
    super("Scheduler configuration is invalid.");
    this.name = "SchedulerConfigurationError";
  }
}

/** Parses only scheduler-owned, non-secret operational bounds. */
export function loadSchedulerRuntimeConfiguration(
  environment: NodeJS.ProcessEnv,
): SchedulerRuntimeConfiguration {
  const databaseUrl = environment.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new SchedulerConfigurationError();
  }
  return Object.freeze({
    databaseUrl,
    pollIntervalMs: boundedInteger(
      environment.SCHEDULER_POLL_INTERVAL_MS,
      1_000,
      100,
      3_600_000,
    ),
    batchLimit: boundedInteger(environment.SCHEDULER_BATCH_LIMIT, 25, 1, 100),
    leaseMs: boundedInteger(
      environment.SCHEDULER_LEASE_MS,
      30_000,
      1,
      3_600_000,
    ),
  });
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new SchedulerConfigurationError();
  }
  return parsed;
}

/**
 * Builds all executable durable schedule producers against one PostgreSQL pool.
 * The case-analysis store discovers only fully immutable v2 schedule rows; it
 * excludes legacy rows rather than rebinding their mutable trigger state.
 */
export async function createSchedulerRuntimeFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: SchedulerRuntimeBootstrapDependencies = productionDependencies,
): Promise<SchedulerProcess> {
  const configuration = loadSchedulerRuntimeConfiguration(environment);
  const pool = dependencies.createPool(configuration.databaseUrl);
  const process = dependencies.createProcess({
    runtimes: [
      createSchedulerRuntime({
        store: dependencies.createKnowledgeScheduleStore(pool),
        clock: dependencies.clock,
        leaseMs: configuration.leaseMs,
      }),
      createCaseAnalysisSchedulerRuntime({
        store: dependencies.createCaseAnalysisScheduleStore(pool),
        clock: dependencies.clock,
        leaseMs: configuration.leaseMs,
      }),
    ],
    pollIntervalMs: configuration.pollIntervalMs,
    batchLimit: configuration.batchLimit,
  });
  let closed = false;
  return Object.freeze({
    start: () => process.start(),
    runOnce: () => process.runOnce(),
    async stop(): Promise<void> {
      const failures: unknown[] = [];
      try {
        await process.stop();
      } catch (error) {
        failures.push(error);
      }
      if (!closed) {
        closed = true;
        try {
          await pool.end();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Scheduler shutdown failed.");
      }
    },
  });
}
