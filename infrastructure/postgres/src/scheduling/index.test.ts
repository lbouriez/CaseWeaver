import { createHash } from "node:crypto";

import type { KnowledgeScheduleStore } from "@caseweaver/scheduling";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { PostgresKnowledgeScheduleStore } from "./index.js";

interface QueryResponse {
  readonly rows?: readonly Record<string, unknown>[];
  readonly rowCount?: number | null;
}

interface RecordedQuery {
  readonly statement: string;
  readonly values: readonly unknown[];
}

class ScriptedTransactionClient {
  public readonly queries: RecordedQuery[] = [];
  public released = false;

  public constructor(private readonly responses: readonly QueryResponse[]) {}

  public async query(
    statement: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResponse> {
    this.queries.push({ statement, values });
    const response = this.responses[this.queries.length - 1];
    if (response === undefined) {
      throw new Error("Unexpected PostgreSQL query.");
    }
    return response;
  }

  public release(): void {
    this.released = true;
  }
}

function normalize(statement: string): string {
  return statement.replaceAll(/\s+/gu, " ").trim();
}

function store(
  client: ScriptedTransactionClient,
): PostgresKnowledgeScheduleStore {
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  return new PostgresKnowledgeScheduleStore(pool);
}

describe("PostgresKnowledgeScheduleStore.findDue", () => {
  it("filters legacy pinless schedules before the due-query limit", async () => {
    const queries: RecordedQuery[] = [];
    const pool = {
      query: async (
        statement: string,
        values: readonly unknown[] = [],
      ): Promise<QueryResponse> => {
        queries.push({ statement, values });
        return {
          rows: [
            {
              id: "pinned-schedule-1",
              workspace_id: "workspace-1",
              knowledge_source_id: "source-1",
              schedule_kind: "synchronize",
              configuration_version: "source-version-1",
              connector_configuration_version_id: "connector-version-1",
              trigger_kind: "interval",
              cron_expression: null,
              timezone: null,
              interval_ms: "60000",
              jitter_ms: null,
              enabled: true,
              next_run_at: new Date("2026-07-15T12:00:00.000Z"),
            },
          ],
        };
      },
    } as unknown as Pool;
    const schedules = await new PostgresKnowledgeScheduleStore(pool).findDue({
      now: "2026-07-15T12:00:01.000Z",
      limit: 1,
    });

    expect(schedules).toMatchObject([
      {
        id: "pinned-schedule-1",
        sourceConfigurationVersionId: "source-version-1",
        connectorConfigurationVersionId: "connector-version-1",
      },
    ]);
    expect(normalize(queries[0]?.statement ?? "")).toContain(
      "WHERE enabled AND next_run_at <= $1 AND connector_configuration_version_id IS NOT NULL ORDER BY next_run_at, id LIMIT $2",
    );
    expect(queries[0]?.values).toEqual(["2026-07-15T12:00:01.000Z", 1]);
  });
});

function input(): Parameters<KnowledgeScheduleStore["enqueueOccurrence"]>[0] {
  return {
    schedule: {
      id: "schedule-1",
      workspaceId: "workspace-1",
      sourceId: "source-1",
      sourceConfigurationVersionId: "source-version-1",
      connectorConfigurationVersionId: "connector-version-1",
      kind: "synchronize",
      cadence: { kind: "interval", intervalMs: 60_000 },
      enabled: true,
      nextRunAt: "2026-07-15T12:00:00.000Z",
    },
    lease: {
      fencingToken: 4n,
      expiresAt: "2026-07-15T12:01:00.000Z",
    },
    occurrenceKey: "occurrence-key-1",
    command: {
      type: "knowledge.synchronize.v2",
      workspaceId: "workspace-1",
      sourceId: "source-1",
      sourceConfigurationVersionId: "source-version-1",
      connectorConfigurationVersionId: "connector-version-1",
      trigger: "schedule",
      occurrenceKey: "occurrence-key-1",
      scheduledFor: "2026-07-15T12:00:00.000Z",
    },
    nextRunAt: "2026-07-15T12:01:00.000Z",
    now: "2026-07-15T12:00:01.000Z",
  };
}

describe("PostgresKnowledgeScheduleStore.enqueueOccurrence", () => {
  it("atomically writes a UUID standard knowledge envelope to the common outbox", async () => {
    const client = new ScriptedTransactionClient([
      {},
      { rows: [{ fencing_token: 4n, expires_at: new Date() }] },
      { rows: [{ id: "occurrence-1" }] },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 },
      {},
    ]);
    const occurrence = input();

    await expect(store(client).enqueueOccurrence(occurrence)).resolves.toBe(
      "enqueued",
    );

    const statements = client.queries.map(({ statement }) =>
      normalize(statement),
    );
    expect(statements).toEqual([
      "BEGIN",
      expect.stringContaining("FROM knowledge_schedule_leases"),
      expect.stringContaining("INSERT INTO knowledge_schedule_occurrences"),
      expect.stringContaining("UPDATE knowledge_schedules"),
      expect.stringContaining("INSERT INTO outbox_envelopes"),
      expect.stringContaining("DELETE FROM knowledge_schedule_leases"),
      "COMMIT",
    ]);
    expect(statements.join(" ")).not.toContain("knowledge_schedule_commands");

    const outbox = client.queries[4];
    expect(outbox?.values).toMatchObject([
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      "workspace-1",
      "knowledge.synchronize.v2",
      "2026-07-15T12:00:01.000Z",
      `schedule:schedule-1:${createHash("sha256")
        .update("occurrence-key-1", "utf8")
        .digest("hex")}`,
      JSON.stringify({
        sourceId: "source-1",
        sourceConfigurationVersionId: "source-version-1",
        connectorConfigurationVersionId: "connector-version-1",
        trigger: "schedule",
      }),
    ]);
    expect(client.released).toBe(true);
  });

  it("releases the matching lease without writing an outbox envelope for a duplicate occurrence", async () => {
    const client = new ScriptedTransactionClient([
      {},
      { rows: [{ fencing_token: 4n, expires_at: new Date() }] },
      { rows: [] },
      { rowCount: 1 },
      {},
    ]);

    await expect(store(client).enqueueOccurrence(input())).resolves.toBe(
      "duplicate",
    );

    const statements = client.queries.map(({ statement }) =>
      normalize(statement),
    );
    expect(statements).not.toContain(
      expect.stringContaining("UPDATE knowledge_schedules"),
    );
    expect(statements).not.toContain(
      expect.stringContaining("INSERT INTO outbox_envelopes"),
    );
    expect(statements).toEqual([
      "BEGIN",
      expect.stringContaining("FROM knowledge_schedule_leases"),
      expect.stringContaining("INSERT INTO knowledge_schedule_occurrences"),
      expect.stringContaining("DELETE FROM knowledge_schedule_leases"),
      "COMMIT",
    ]);
    expect(client.released).toBe(true);
  });

  it("rolls back the occurrence when the schedule is disabled before it can advance", async () => {
    const client = new ScriptedTransactionClient([
      {},
      { rows: [{ fencing_token: 4n, expires_at: new Date() }] },
      { rows: [{ id: "occurrence-1" }] },
      { rowCount: 0 },
      {},
    ]);

    await expect(store(client).enqueueOccurrence(input())).rejects.toThrow(
      "Knowledge schedule is no longer enabled.",
    );

    const statements = client.queries.map(({ statement }) =>
      normalize(statement),
    );
    expect(statements).toEqual([
      "BEGIN",
      expect.stringContaining("FROM knowledge_schedule_leases"),
      expect.stringContaining("INSERT INTO knowledge_schedule_occurrences"),
      expect.stringContaining("UPDATE knowledge_schedules"),
      "ROLLBACK",
    ]);
    expect(statements.join(" ")).not.toContain("INSERT INTO outbox_envelopes");
    expect(client.released).toBe(true);
  });

  it("rejects a caller that attempts to enqueue pins different from the scheduled immutable pair", async () => {
    const client = new ScriptedTransactionClient([]);
    const occurrence = input();
    const mismatched = {
      ...occurrence,
      command: {
        ...occurrence.command,
        connectorConfigurationVersionId: "connector-version-2",
      },
    };

    await expect(store(client).enqueueOccurrence(mismatched)).rejects.toThrow(
      "runtime pins are invalid",
    );
    expect(client.queries).toEqual([]);
  });
});
