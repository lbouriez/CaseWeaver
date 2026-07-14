import { createHash } from "node:crypto";

import { isDue, nextRunAt } from "./cron.js";
import type {
  CaseAnalysisSchedule,
  CaseAnalysisSchedulerDependencies,
  CaseAnalysisTriggerCommand,
  SchedulerRunResult,
} from "./types.js";

function occurrenceKey(schedule: CaseAnalysisSchedule): string {
  return createHash("sha256")
    .update(
      [
        "case-analysis-schedule.v1",
        schedule.workspaceId,
        schedule.id,
        schedule.triggerId,
        schedule.configurationVersion,
        schedule.nextRunAt,
      ].join(":"),
      "utf8",
    )
    .digest("hex");
}

function commandFor(
  schedule: CaseAnalysisSchedule,
  key: string,
): CaseAnalysisTriggerCommand {
  return {
    type: "analysis.trigger.v1",
    workspaceId: schedule.workspaceId,
    triggerId: schedule.triggerId,
    configurationVersion: schedule.configurationVersion,
    occurrenceKey: key,
    scheduledFor: schedule.nextRunAt,
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
      if (result === "enqueued") enqueued += 1;
      else duplicate += 1;
    }
    return { due: due.length, leased, enqueued, duplicate };
  }
}

export function caseAnalysisScheduleOccurrenceKey(
  schedule: CaseAnalysisSchedule,
): string {
  return occurrenceKey(schedule);
}
