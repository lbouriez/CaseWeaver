import { createHash } from "node:crypto";

import { isDue, nextRunAt } from "./cron.js";
import type {
  CaseAnalysisSchedule,
  CaseAnalysisSchedulerDependencies,
  SchedulerRunResult,
} from "./types.js";

function occurrenceKey(schedule: CaseAnalysisSchedule): string {
  return createHash("sha256")
    .update(
      [
        "case-analysis-schedule.v2",
        schedule.workspaceId,
        schedule.id,
        schedule.triggerId,
        schedule.analysisTriggerVersionId ?? "legacy",
        schedule.target?.connectorInstanceId ?? "legacy",
        schedule.target?.resourceType ?? "legacy",
        schedule.target?.externalId ?? "legacy",
        schedule.nextRunAt,
      ].join(":"),
      "utf8",
    )
    .digest("hex");
}

/**
 * A legacy schedule lacks at least one immutable trigger, target, actor, or
 * connector pin. It cannot produce a safe v2 command and must never be rebound
 * to a current trigger/configuration pointer.
 */
export class LegacyCaseAnalysisScheduleUnavailableError extends Error {
  public readonly code = "scheduling.legacyAnalysisTriggerUnavailable";
  public readonly retryable = false;

  public constructor() {
    super(
      "Legacy case-analysis schedules have no immutable trigger configuration pin.",
    );
    this.name = "LegacyCaseAnalysisScheduleUnavailableError";
  }
}

function isPinnedSchedule(
  schedule: CaseAnalysisSchedule,
): schedule is CaseAnalysisSchedule & {
  readonly analysisTriggerVersionId: string;
  readonly automatedPrincipalId: string;
  readonly connectorRegistrationId: string;
  readonly connectorConfigurationVersionId: string;
  readonly target: NonNullable<CaseAnalysisSchedule["target"]>;
} {
  return (
    typeof schedule.analysisTriggerVersionId === "string" &&
    schedule.analysisTriggerVersionId.length > 0 &&
    typeof schedule.automatedPrincipalId === "string" &&
    schedule.automatedPrincipalId.length > 0 &&
    typeof schedule.connectorRegistrationId === "string" &&
    schedule.connectorRegistrationId.length > 0 &&
    typeof schedule.connectorConfigurationVersionId === "string" &&
    schedule.connectorConfigurationVersionId.length > 0 &&
    schedule.target !== undefined &&
    schedule.target.connectorInstanceId.length > 0 &&
    schedule.target.resourceType.length > 0 &&
    schedule.target.externalId.length > 0
  );
}

function commandFor(
  schedule: Parameters<typeof isPinnedSchedule>[0] & {
    readonly analysisTriggerVersionId: string;
    readonly connectorRegistrationId: string;
    readonly connectorConfigurationVersionId: string;
    readonly target: NonNullable<CaseAnalysisSchedule["target"]>;
  },
  occurrenceKey: string,
) {
  return {
    type: "analysis.trigger.v2" as const,
    workspaceId: schedule.workspaceId,
    triggerRequestId: `analysis-trigger-request:schedule:${occurrenceKey}`,
    triggerId: schedule.triggerId,
    triggerVersionId: schedule.analysisTriggerVersionId,
    connectorRegistrationId: schedule.connectorRegistrationId,
    connectorConfigurationVersionId: schedule.connectorConfigurationVersionId,
    source: "schedule" as const,
    occurrenceKey,
    target: schedule.target,
  };
}

export class CaseAnalysisScheduler {
  public constructor(
    private readonly dependencies: CaseAnalysisSchedulerDependencies,
  ) {
    if (!Number.isInteger(dependencies.leaseMs) || dependencies.leaseMs < 1) {
      throw new RangeError(
        "Scheduler lease duration must be a positive integer.",
      );
    }
  }

  public async runOnce(limit = 25): Promise<SchedulerRunResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Scheduler limit must be between 1 and 100.");
    }
    const now = this.dependencies.clock.now();
    const due = await this.dependencies.store.findDue({ now, limit });
    let leased = 0;
    let enqueued = 0;
    let duplicate = 0;
    for (const schedule of due) {
      if (!isDue(schedule, now)) continue;
      if (!isPinnedSchedule(schedule)) {
        throw new LegacyCaseAnalysisScheduleUnavailableError();
      }
      const lease = await this.dependencies.store.acquireLease({
        schedule,
        now,
        leaseMs: this.dependencies.leaseMs,
      });
      if (lease === undefined) continue;
      leased += 1;
      const key = occurrenceKey(schedule);
      const result = await this.dependencies.store.enqueueOccurrence({
        schedule,
        lease,
        occurrenceKey: key,
        command: commandFor(schedule, key),
        nextRunAt: nextRunAt(schedule, schedule.nextRunAt),
        now,
      });
      if (result === "enqueued") {
        enqueued += 1;
      } else {
        duplicate += 1;
      }
    }
    return { due: due.length, leased, enqueued, duplicate };
  }
}

export function caseAnalysisScheduleOccurrenceKey(
  schedule: CaseAnalysisSchedule,
): string {
  return occurrenceKey(schedule);
}
