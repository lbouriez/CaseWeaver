import {
  CaseAnalysisScheduler,
  type CaseAnalysisScheduleStore,
  CaseDiscoveryScheduler,
  type CaseDiscoveryScheduleStore,
  KnowledgeScheduler,
  type KnowledgeScheduleStore,
  type SchedulerClock,
  type SchedulerRunResult,
} from "@caseweaver/scheduling";

export interface SchedulerRuntime {
  runOnce(limit?: number): Promise<SchedulerRunResult>;
}

export interface SchedulerRuntimeDependencies {
  readonly store: KnowledgeScheduleStore;
  readonly clock: SchedulerClock;
  readonly leaseMs: number;
}

/**
 * Transport/lifecycle composition only. The injected store durably enqueues commands;
 * this app has no connector, attachment, or AI dependency.
 */
export function createSchedulerRuntime(
  dependencies: SchedulerRuntimeDependencies,
): SchedulerRuntime {
  const scheduler = new KnowledgeScheduler(dependencies);
  return Object.freeze({
    runOnce: (limit?: number) => scheduler.runOnce(limit),
  });
}

export interface CaseAnalysisSchedulerRuntimeDependencies {
  readonly store: CaseAnalysisScheduleStore;
  readonly clock: SchedulerClock;
  readonly leaseMs: number;
}

/**
 * Case-analysis schedule composition owns no connector or worker dependency.
 * Its durable store selects only a fully pinned command version.
 */
export function createCaseAnalysisSchedulerRuntime(
  dependencies: CaseAnalysisSchedulerRuntimeDependencies,
): SchedulerRuntime {
  const scheduler = new CaseAnalysisScheduler(dependencies);
  return Object.freeze({
    runOnce: (limit?: number) => scheduler.runOnce(limit),
  });
}

export interface CaseDiscoverySchedulerRuntimeDependencies {
  readonly store: CaseDiscoveryScheduleStore;
  readonly clock: SchedulerClock;
  readonly leaseMs: number;
}

/**
 * PBI-020 polling schedules only enqueue immutable case-discovery work. The
 * case source, attachment pipeline, and analysis execution remain worker-only.
 */
export function createCaseDiscoverySchedulerRuntime(
  dependencies: CaseDiscoverySchedulerRuntimeDependencies,
): SchedulerRuntime {
  const scheduler = new CaseDiscoveryScheduler(dependencies);
  return Object.freeze({
    runOnce: (limit?: number) => scheduler.runOnce(limit),
  });
}
