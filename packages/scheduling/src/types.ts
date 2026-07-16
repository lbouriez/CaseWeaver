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
  /** Immutable source version selected before this schedule becomes due. */
  readonly sourceConfigurationVersionId: string;
  /** Immutable server-private connector version paired with the source version. */
  readonly connectorConfigurationVersionId: string;
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
  readonly type: "knowledge.synchronize.v2" | "knowledge.full-rescan.v2";
  readonly workspaceId: string;
  readonly sourceId: string;
  /** Immutable source configuration pinned when the occurrence was scheduled. */
  readonly sourceConfigurationVersionId: string;
  /** Immutable connector configuration paired with the pinned source version. */
  readonly connectorConfigurationVersionId: string;
  readonly trigger: "schedule";
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
  /** Stable trigger aggregate identity, retained for legacy schedule diagnostics. */
  readonly triggerId: string;
  /** Legacy mutable marker. It is never used to construct v2 work. */
  readonly configurationVersion: string;
  /** Exact active trigger revision selected when the schedule was configured. */
  readonly analysisTriggerVersionId?: string;
  /** Opaque case identity retained for v2 trigger work. */
  readonly target?: Readonly<{
    readonly connectorInstanceId: string;
    readonly resourceType: string;
    readonly externalId: string;
  }>;
  /** Principal authorized when this automated schedule was activated. */
  readonly automatedPrincipalId?: string;
  /**
   * Derived from the exact trigger revision by the durable store. These are
   * read-model values only; enqueue re-derives and verifies them while locked.
   */
  readonly connectorRegistrationId?: string;
  readonly connectorConfigurationVersionId?: string;
  readonly cadence: ScheduleCadence;
  readonly enabled: boolean;
  readonly nextRunAt: string;
}

export interface CaseAnalysisTriggerCommand {
  readonly type: "analysis.trigger.v2";
  readonly workspaceId: string;
  readonly triggerRequestId: string;
  readonly triggerId: string;
  readonly triggerVersionId: string;
  readonly connectorRegistrationId: string;
  readonly connectorConfigurationVersionId: string;
  readonly source: "schedule";
  readonly occurrenceKey: string;
  readonly target: Readonly<{
    readonly connectorInstanceId: string;
    readonly resourceType: string;
    readonly externalId: string;
  }>;
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
