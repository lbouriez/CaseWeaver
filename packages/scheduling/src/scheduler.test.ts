import { describe, expect, it } from "vitest";

import {
  type KnowledgeSchedule,
  KnowledgeScheduler,
  type KnowledgeScheduleStore,
  knowledgeScheduleOccurrenceKey,
  nextRunAt,
  type ScheduleLease,
} from "./index.js";

function schedule(
  overrides: Partial<KnowledgeSchedule> = {},
): KnowledgeSchedule {
  return {
    id: "schedule-1",
    workspaceId: "workspace-1",
    sourceId: "source-1",
    configurationVersion: "source-config.v1",
    kind: "synchronize",
    enabled: true,
    nextRunAt: "2026-07-13T20:00:00.000Z",
    cadence: { kind: "interval", intervalMs: 60_000 },
    ...overrides,
  };
}

class Store implements KnowledgeScheduleStore {
  public readonly occurrences = new Set<string>();
  public readonly commands: unknown[] = [];
  public leaseAvailable = true;

  public constructor(private readonly due: readonly KnowledgeSchedule[]) {}

  public async findDue(): Promise<readonly KnowledgeSchedule[]> {
    return this.due;
  }

  public async acquireLease(): Promise<ScheduleLease | undefined> {
    if (!this.leaseAvailable) return undefined;
    this.leaseAvailable = false;
    return {
      fencingToken: 1n,
      expiresAt: "2026-07-13T20:01:00.000Z",
    };
  }

  public async enqueueOccurrence(
    input: Parameters<KnowledgeScheduleStore["enqueueOccurrence"]>[0],
  ): Promise<"enqueued" | "duplicate"> {
    this.leaseAvailable = true;
    if (this.occurrences.has(input.occurrenceKey)) return "duplicate";
    this.occurrences.add(input.occurrenceKey);
    this.commands.push(input.command);
    return "enqueued";
  }
}

describe("KnowledgeScheduler", () => {
  it("uses a deterministic occurrence key and atomically delegates one enqueue", async () => {
    const due = schedule();
    const store = new Store([due]);
    const scheduler = new KnowledgeScheduler({
      store,
      clock: { now: () => "2026-07-13T20:00:10.000Z" },
      leaseMs: 30_000,
    });

    const first = await scheduler.runOnce();
    const second = await scheduler.runOnce();

    expect(knowledgeScheduleOccurrenceKey(due)).toBe(
      knowledgeScheduleOccurrenceKey(due),
    );
    expect(first).toEqual({ due: 1, leased: 1, enqueued: 1, duplicate: 0 });
    expect(second).toEqual({ due: 1, leased: 1, enqueued: 0, duplicate: 1 });
    expect(store.commands).toEqual([
      expect.objectContaining({
        type: "knowledge.synchronize.v1",
        sourceId: "source-1",
        configurationVersion: "source-config.v1",
        trigger: "schedule",
      }),
    ]);
  });

  it("does not lease disabled schedules", async () => {
    const store = new Store([schedule({ enabled: false })]);
    const result = await new KnowledgeScheduler({
      store,
      clock: { now: () => "2026-07-13T20:00:10.000Z" },
      leaseMs: 30_000,
    }).runOnce();

    expect(result).toEqual({ due: 1, leased: 0, enqueued: 0, duplicate: 0 });
    expect(store.commands).toEqual([]);
  });

  it("skips a nonexistent local cron time across the DST spring transition", () => {
    const next = nextRunAt(
      schedule({
        cadence: {
          kind: "cron",
          expression: "30 2 * * *",
          timezone: "America/New_York",
        },
      }),
      "2026-03-08T06:59:00.000Z",
    );

    expect(next).toBe("2026-03-09T06:30:00.000Z");
  });

  it("uses separate deterministic occurrences for repeated DST local times and schedule identities", () => {
    const dstSchedule = schedule({
      cadence: {
        kind: "cron",
        expression: "30 1 * * *",
        timezone: "America/New_York",
      },
    });
    const first = nextRunAt(dstSchedule, "2026-11-01T05:29:00.000Z");
    const second = nextRunAt(dstSchedule, first);

    expect(first).toBe("2026-11-01T05:30:00.000Z");
    expect(second).toBe("2026-11-01T06:30:00.000Z");
    expect(
      knowledgeScheduleOccurrenceKey({ ...dstSchedule, nextRunAt: first }),
    ).not.toBe(
      knowledgeScheduleOccurrenceKey({ ...dstSchedule, nextRunAt: second }),
    );
    expect(
      knowledgeScheduleOccurrenceKey({
        ...dstSchedule,
        configurationVersion: "source-config.v2",
        nextRunAt: first,
      }),
    ).not.toBe(
      knowledgeScheduleOccurrenceKey({ ...dstSchedule, nextRunAt: first }),
    );
  });

  it("does not enqueue when another worker holds the schedule lease", async () => {
    const store = new Store([schedule()]);
    store.leaseAvailable = false;

    const result = await new KnowledgeScheduler({
      store,
      clock: { now: () => "2026-07-13T20:00:10.000Z" },
      leaseMs: 30_000,
    }).runOnce();

    expect(result).toEqual({ due: 1, leased: 0, enqueued: 0, duplicate: 0 });
    expect(store.commands).toEqual([]);
  });
});
