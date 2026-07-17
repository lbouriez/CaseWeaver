import { createHash } from "node:crypto";

import { isDue, nextRunAt } from "./cron.js";
import type {
  CaseDiscoveryCommand,
  CaseDiscoverySchedule,
  CaseDiscoverySchedulerDependencies,
  SchedulerRunResult,
} from "./types.js";

function occurrenceKey(schedule: CaseDiscoverySchedule): string {
  return createHash("sha256")
    .update(
      [
        "case-discovery-schedule.v1",
        schedule.workspaceId,
        schedule.id,
        schedule.configurationVersionId,
        schedule.triggerId,
        schedule.triggerVersionId,
        schedule.connectorRegistrationId,
        schedule.connectorConfigurationVersionId,
        schedule.nextRunAt,
      ].join(":"),
      "utf8",
    )
    .digest("hex");
}

function commandFor(
  schedule: CaseDiscoverySchedule,
  key: string,
): CaseDiscoveryCommand {
  return Object.freeze({
    type: "analysis.discover.v1",
    workspaceId: schedule.workspaceId,
    scheduleId: schedule.id,
    scheduleConfigurationVersionId: schedule.configurationVersionId,
    triggerId: schedule.triggerId,
    triggerVersionId: schedule.triggerVersionId,
    connectorRegistrationId: schedule.connectorRegistrationId,
    connectorConfigurationVersionId: schedule.connectorConfigurationVersionId,
    occurrenceKey: key,
  });
}

/**
 * Durable producer for target-free PBI-020 case discovery.  The scheduler is
 * deliberately unable to construct a connector or invoke an AI/attachment
 * service; it only releases exact immutable command work to the outbox.
 */
export class CaseDiscoveryScheduler {
  public constructor(
    private readonly dependencies: CaseDiscoverySchedulerDependencies,
  ) {
    if (!Number.isInteger(dependencies.leaseMs) || dependencies.leaseMs < 1) {
      throw new RangeError(
        "Case discovery scheduler lease duration must be a positive integer.",
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

export function caseDiscoveryScheduleOccurrenceKey(
  schedule: CaseDiscoverySchedule,
): string {
  return occurrenceKey(schedule);
}
