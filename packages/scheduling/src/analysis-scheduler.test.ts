import { describe, expect, it } from "vitest";

import {
  CaseAnalysisScheduler,
  type CaseAnalysisSchedule,
  caseAnalysisScheduleOccurrenceKey,
  type CaseAnalysisScheduleStore,
  type ScheduleLease,
} from "./index.js";

const schedule: CaseAnalysisSchedule = {
  id: "analysis-schedule-1",
  workspaceId: "workspace-1",
  triggerId: "trigger-1",
  configurationVersion: "trigger.v1",
  cadence: { kind: "interval", intervalMs: 60_000 },
  enabled: true,
  nextRunAt: "2026-07-14T16:00:00.000Z",
};

class Store implements CaseAnalysisScheduleStore {
  public commands: unknown[] = [];
  private occurred = false;

  public async findDue(): Promise<readonly CaseAnalysisSchedule[]> {
    return [schedule];
  }

  public async acquireLease(): Promise<ScheduleLease | undefined> {
    return this.occurred
      ? { fencingToken: 2n, expiresAt: "2026-07-14T16:02:00.000Z" }
      : { fencingToken: 1n, expiresAt: "2026-07-14T16:01:00.000Z" };
  }

  public async enqueueOccurrence(
    input: Parameters<CaseAnalysisScheduleStore["enqueueOccurrence"]>[0],
  ): Promise<"enqueued" | "duplicate"> {
    if (this.occurred) return "duplicate";
    this.occurred = true;
    this.commands.push(input.command);
    return "enqueued";
  }
}

describe("CaseAnalysisScheduler", () => {
  it("creates one deterministic analysis-trigger occurrence without polling a connector", async () => {
    const store = new Store();
    const scheduler = new CaseAnalysisScheduler({
      store,
      clock: { now: () => "2026-07-14T16:00:10.000Z" },
      leaseMs: 30_000,
    });

    await expect(scheduler.runOnce()).resolves.toEqual({
      due: 1,
      leased: 1,
      enqueued: 1,
      duplicate: 0,
    });
    await expect(scheduler.runOnce()).resolves.toEqual({
      due: 1,
      leased: 1,
      enqueued: 0,
      duplicate: 1,
    });
    expect(caseAnalysisScheduleOccurrenceKey(schedule)).toBe(
      caseAnalysisScheduleOccurrenceKey(schedule),
    );
    expect(store.commands).toEqual([
      expect.objectContaining({
        type: "analysis.trigger.v1",
        triggerId: "trigger-1",
      }),
    ]);
  });
});
