import {
  CaseAnalysisScheduler,
  type CaseAnalysisScheduleStore,
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
 * Case-analysis scheduling composition only persists `analysis.trigger.v1` work.
 * It deliberately has no connector, renderer, or worker dependency.
 */
export function createCaseAnalysisSchedulerRuntime(
  dependencies: CaseAnalysisSchedulerRuntimeDependencies,
): SchedulerRuntime {
  const scheduler = new CaseAnalysisScheduler(dependencies);
  return Object.freeze({
    runOnce: (limit?: number) => scheduler.runOnce(limit),
  });
}
