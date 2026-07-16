import { describe, expect, it } from "vitest";

import {
  type CaseAnalysisSchedule,
  CaseAnalysisScheduler,
  type CaseAnalysisScheduleStore,
  caseAnalysisScheduleOccurrenceKey,
  LegacyCaseAnalysisScheduleUnavailableError,
  type ScheduleLease,
} from "./index.js";

const schedule: CaseAnalysisSchedule = {
  id: "analysis-schedule-1",
  workspaceId: "workspace-1",
  triggerId: "trigger-1",
  configurationVersion: "legacy-marker",
  analysisTriggerVersionId: "trigger-version-1",
  automatedPrincipalId: "principal-1",
  connectorRegistrationId: "connector-1",
  connectorConfigurationVersionId: "connector-configuration-1",
  target: {
    connectorInstanceId: "connector-1",
    resourceType: "case",
    externalId: "case-1",
  },
  cadence: { kind: "interval", intervalMs: 60_000 },
  enabled: true,
  nextRunAt: "2026-07-14T16:00:00.000Z",
};

class Store implements CaseAnalysisScheduleStore {
  public commands: unknown[] = [];
  public leaseAttempts = 0;
  public enqueueAttempts = 0;
  private occurred = false;

  public async findDue(): Promise<readonly CaseAnalysisSchedule[]> {
    return [schedule];
  }

  public async acquireLease(): Promise<ScheduleLease | undefined> {
    this.leaseAttempts += 1;
    return this.occurred
      ? { fencingToken: 2n, expiresAt: "2026-07-14T16:02:00.000Z" }
      : { fencingToken: 1n, expiresAt: "2026-07-14T16:01:00.000Z" };
  }

  public async enqueueOccurrence(
    input: Parameters<CaseAnalysisScheduleStore["enqueueOccurrence"]>[0],
  ): Promise<"enqueued" | "duplicate"> {
    this.enqueueAttempts += 1;
    if (this.occurred) return "duplicate";
    this.occurred = true;
    this.commands.push(input.command);
    return "enqueued";
  }
}

describe("CaseAnalysisScheduler", () => {
  it("creates a deterministic version-pinned v2 request occurrence", async () => {
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
    expect(caseAnalysisScheduleOccurrenceKey(schedule)).toBe(
      caseAnalysisScheduleOccurrenceKey(schedule),
    );
    expect(store.leaseAttempts).toBe(1);
    expect(store.enqueueAttempts).toBe(1);
    expect(store.commands).toEqual([
      expect.objectContaining({
        type: "analysis.trigger.v2",
        triggerId: "trigger-1",
        triggerVersionId: "trigger-version-1",
        connectorRegistrationId: "connector-1",
        connectorConfigurationVersionId: "connector-configuration-1",
        source: "schedule",
        target: {
          connectorInstanceId: "connector-1",
          resourceType: "case",
          externalId: "case-1",
        },
      }),
    ]);
  });

  it("fails a legacy row closed before leasing or emitting v1 work", async () => {
    const store = new Store();
    store.findDue = async () => [
      {
        id: "legacy-schedule-1",
        workspaceId: "workspace-1",
        triggerId: "trigger-1",
        configurationVersion: "legacy-marker",
        cadence: { kind: "interval", intervalMs: 60_000 },
        enabled: true,
        nextRunAt: "2026-07-14T16:00:00.000Z",
      },
    ];
    const scheduler = new CaseAnalysisScheduler({
      store,
      clock: { now: () => "2026-07-14T16:00:10.000Z" },
      leaseMs: 30_000,
    });

    await expect(scheduler.runOnce()).rejects.toBeInstanceOf(
      LegacyCaseAnalysisScheduleUnavailableError,
    );
    expect(store.leaseAttempts).toBe(0);
    expect(store.enqueueAttempts).toBe(0);
    expect(store.commands).toEqual([]);
  });
});
