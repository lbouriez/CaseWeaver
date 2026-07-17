import { describe, expect, it } from "vitest";

import {
  type CaseDiscoverySchedule,
  CaseDiscoveryScheduler,
  type CaseDiscoveryScheduleStore,
  caseDiscoveryScheduleOccurrenceKey,
  type ScheduleLease,
} from "./index.js";

const schedule: CaseDiscoverySchedule = {
  id: "intake-schedule-1",
  workspaceId: "workspace-1",
  configurationVersionId: "intake-schedule-version-1",
  triggerId: "trigger-1",
  triggerVersionId: "trigger-version-1",
  automatedPrincipalId: "principal-1",
  connectorRegistrationId: "connector-1",
  connectorConfigurationVersionId: "connector-version-1",
  cadence: { kind: "interval", intervalMs: 60_000 },
  enabled: true,
  nextRunAt: "2026-07-17T16:00:00.000Z",
};

class Store implements CaseDiscoveryScheduleStore {
  public readonly commands: unknown[] = [];

  public async findDue(): Promise<readonly CaseDiscoverySchedule[]> {
    return [schedule];
  }

  public async acquireLease(): Promise<ScheduleLease | undefined> {
    return { fencingToken: 1n, expiresAt: "2026-07-17T16:01:00.000Z" };
  }

  public async enqueueOccurrence(
    input: Parameters<CaseDiscoveryScheduleStore["enqueueOccurrence"]>[0],
  ): Promise<"enqueued" | "duplicate"> {
    this.commands.push(input.command);
    return "enqueued";
  }
}

describe("CaseDiscoveryScheduler", () => {
  it("emits one exact-pinned, target-free discovery occurrence", async () => {
    const store = new Store();
    const scheduler = new CaseDiscoveryScheduler({
      store,
      clock: { now: () => "2026-07-17T16:00:10.000Z" },
      leaseMs: 30_000,
    });

    await expect(scheduler.runOnce()).resolves.toEqual({
      due: 1,
      leased: 1,
      enqueued: 1,
      duplicate: 0,
    });
    expect(caseDiscoveryScheduleOccurrenceKey(schedule)).toBe(
      caseDiscoveryScheduleOccurrenceKey(schedule),
    );
    expect(store.commands).toEqual([
      expect.objectContaining({
        type: "analysis.discover.v1",
        scheduleId: "intake-schedule-1",
        scheduleConfigurationVersionId: "intake-schedule-version-1",
        triggerId: "trigger-1",
        triggerVersionId: "trigger-version-1",
        connectorRegistrationId: "connector-1",
        connectorConfigurationVersionId: "connector-version-1",
      }),
    ]);
    expect(JSON.stringify(store.commands)).not.toContain("cursor");
  });
});
