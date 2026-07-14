export type KnowledgeScheduleKind = "synchronize" | "fullRescan";

export type ScheduleCadence =
  | Readonly<{
      readonly kind: "interval";
      readonly intervalMs: number;
      readonly jitterMs?: number;
    }>
  | Readonly<{
      readonly kind: "cron";
      readonly expression: string;
      readonly timezone: string;
      readonly jitterMs?: number;
    }>;

export interface KnowledgeSchedule {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceId: string;
  readonly configurationVersion: string;
  readonly kind: KnowledgeScheduleKind;
  readonly cadence: ScheduleCadence;
  readonly enabled: boolean;
  readonly nextRunAt: string;
}

export interface ScheduleLease {
  readonly fencingToken: bigint;
  readonly expiresAt: string;
}

export interface KnowledgeSynchronizationCommand {
  readonly type: "knowledge.synchronize.v1" | "knowledge.full-rescan.v1";
  readonly workspaceId: string;
  readonly sourceId: string;
  readonly configurationVersion: string;
  readonly occurrenceKey: string;
  readonly scheduledFor: string;
}

export interface KnowledgeScheduleStore {
  findDue(input: {
    readonly now: string;
    readonly limit: number;
  }): Promise<readonly KnowledgeSchedule[]>;
  acquireLease(input: {
    readonly schedule: KnowledgeSchedule;
    readonly now: string;
    readonly leaseMs: number;
  }): Promise<ScheduleLease | undefined>;
  /**
   * Implementations persist the occurrence, durable command handoff, next run state,
   * and release of the matching lease in one transaction.
   */
  enqueueOccurrence(input: {
    readonly schedule: KnowledgeSchedule;
    readonly lease: ScheduleLease;
    readonly occurrenceKey: string;
    readonly command: KnowledgeSynchronizationCommand;
    readonly nextRunAt: string;
    readonly now: string;
  }): Promise<"enqueued" | "duplicate">;
}

export interface SchedulerClock {
  now(): string;
}

export interface KnowledgeSchedulerDependencies {
  readonly store: KnowledgeScheduleStore;
  readonly clock: SchedulerClock;
  readonly leaseMs: number;
}

export interface SchedulerRunResult {
  readonly due: number;
  readonly leased: number;
  readonly enqueued: number;
  readonly duplicate: number;
}

export interface CaseAnalysisSchedule {
  readonly id: string;
  readonly workspaceId: string;
  /** Server-owned configuration resolved by the worker, not schedule payload. */
  readonly triggerId: string;
  readonly configurationVersion: string;
  readonly cadence: ScheduleCadence;
  readonly enabled: boolean;
  readonly nextRunAt: string;
}

export interface CaseAnalysisTriggerCommand {
  readonly type: "analysis.trigger.v1";
  readonly workspaceId: string;
  readonly triggerId: string;
  readonly configurationVersion: string;
  readonly occurrenceKey: string;
  readonly scheduledFor: string;
}

export interface CaseAnalysisScheduleStore {
  findDue(input: {
    readonly now: string;
    readonly limit: number;
  }): Promise<readonly CaseAnalysisSchedule[]>;
  acquireLease(input: {
    readonly schedule: CaseAnalysisSchedule;
    readonly now: string;
    readonly leaseMs: number;
  }): Promise<ScheduleLease | undefined>;
  enqueueOccurrence(input: {
    readonly schedule: CaseAnalysisSchedule;
    readonly lease: ScheduleLease;
    readonly occurrenceKey: string;
    readonly command: CaseAnalysisTriggerCommand;
    readonly nextRunAt: string;
    readonly now: string;
  }): Promise<"enqueued" | "duplicate">;
}

export interface CaseAnalysisSchedulerDependencies {
  readonly store: CaseAnalysisScheduleStore;
  readonly clock: SchedulerClock;
  readonly leaseMs: number;
}
