import type {
  CaseAnalysisScheduleStore,
  KnowledgeScheduleStore,
  SchedulerRunResult,
} from "@caseweaver/scheduling";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import type {
  SchedulerProcess,
  SchedulerProcessDependencies,
} from "./process.js";
import {
  createSchedulerRuntimeFromEnvironment,
  type SchedulerRuntimeBootstrapDependencies,
} from "./production-bootstrap.js";

const result: SchedulerRunResult = Object.freeze({
  due: 0,
  leased: 0,
  enqueued: 0,
  duplicate: 0,
});

describe("scheduler production bootstrap", () => {
  it("mounts knowledge and exact-pinned case-analysis producers on one owned pool", async () => {
    const pool = { end: vi.fn(async () => undefined) } as unknown as Pool;
    const knowledgeStore = {
      findDue: vi.fn(async () => []),
    } as unknown as KnowledgeScheduleStore;
    const analysisStore = {
      findDue: vi.fn(async () => []),
    } as unknown as CaseAnalysisScheduleStore;
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    let processDependencies: SchedulerProcessDependencies | undefined;
    const process: SchedulerProcess = {
      start,
      stop,
      runOnce: async () => {
        if (processDependencies === undefined) {
          throw new Error("Scheduler process dependencies were not composed.");
        }
        return Promise.all(
          processDependencies.runtimes.map((runtime) => runtime.runOnce(25)),
        );
      },
    };
    const dependencies: SchedulerRuntimeBootstrapDependencies = {
      createPool: vi.fn(() => pool),
      createKnowledgeScheduleStore: vi.fn(() => knowledgeStore),
      createCaseAnalysisScheduleStore: vi.fn(() => analysisStore),
      clock: { now: () => "2026-07-15T12:00:00.000Z" },
      createProcess: vi.fn((input) => {
        processDependencies = input;
        return process;
      }),
    };

    const runtime = await createSchedulerRuntimeFromEnvironment(
      {
        DATABASE_URL: "postgresql://scheduler-test",
        SCHEDULER_BATCH_LIMIT: "25",
      },
      dependencies,
    );

    expect(dependencies.createPool).toHaveBeenCalledWith(
      "postgresql://scheduler-test",
    );
    expect(dependencies.createKnowledgeScheduleStore).toHaveBeenCalledWith(
      pool,
    );
    expect(dependencies.createCaseAnalysisScheduleStore).toHaveBeenCalledWith(
      pool,
    );
    expect(processDependencies?.runtimes).toHaveLength(2);
    await expect(runtime.runOnce()).resolves.toEqual([result, result]);
    expect(knowledgeStore.findDue).toHaveBeenCalledWith({
      now: "2026-07-15T12:00:00.000Z",
      limit: 25,
    });
    expect(analysisStore.findDue).toHaveBeenCalledWith({
      now: "2026-07-15T12:00:00.000Z",
      limit: 25,
    });

    await runtime.stop();
    await runtime.stop();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
