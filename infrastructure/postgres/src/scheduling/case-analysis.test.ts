import { createHash } from "node:crypto";

import type { CaseAnalysisScheduleStore } from "@caseweaver/scheduling";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { PostgresCaseAnalysisScheduleStore } from "./case-analysis.js";

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
): PostgresCaseAnalysisScheduleStore {
  return new PostgresCaseAnalysisScheduleStore({
    connect: async () => client,
  } as unknown as Pool);
}

function pinnedRow(): Record<string, unknown> {
  return {
    id: "schedule-1",
    workspace_id: "workspace-1",
    trigger_id: "trigger-1",
    configuration_version: "legacy-marker",
    analysis_trigger_version_id: "trigger-version-1",
    target_connector_instance_id: "connector-1",
    target_resource_type: "case",
    target_external_id: "case-1",
    automated_principal_id: "principal-1",
    connector_registration_id: "connector-1",
    connector_configuration_version_id: "connector-configuration-1",
    trigger_kind: "interval",
    cron_expression: null,
    timezone: null,
    interval_ms: "60000",
    jitter_ms: null,
    enabled: true,
    next_run_at: new Date("2026-07-15T12:00:00.000Z"),
  };
}

function input(): Parameters<
  CaseAnalysisScheduleStore["enqueueOccurrence"]
>[0] {
  const occurrenceKey = "occurrence-key-1";
  return {
    schedule: {
      id: "schedule-1",
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
      nextRunAt: "2026-07-15T12:00:00.000Z",
    },
    lease: {
      fencingToken: 4n,
      expiresAt: "2026-07-15T12:01:00.000Z",
    },
    occurrenceKey,
    command: {
      type: "analysis.trigger.v2",
      workspaceId: "workspace-1",
      triggerRequestId: `analysis-trigger-request:schedule:${occurrenceKey}`,
      triggerId: "trigger-1",
      triggerVersionId: "trigger-version-1",
      connectorRegistrationId: "connector-1",
      connectorConfigurationVersionId: "connector-configuration-1",
      source: "schedule",
      occurrenceKey,
      target: {
        connectorInstanceId: "connector-1",
        resourceType: "case",
        externalId: "case-1",
      },
    },
    nextRunAt: "2026-07-15T12:01:00.000Z",
    now: "2026-07-15T12:00:01.000Z",
  };
}

describe("PostgresCaseAnalysisScheduleStore", () => {
  it("selects only active, version-pinned schedules with target and actor proof", async () => {
    const queries: RecordedQuery[] = [];
    const schedules = await new PostgresCaseAnalysisScheduleStore({
      query: async (
        statement: string,
        values: readonly unknown[] = [],
      ): Promise<QueryResponse> => {
        queries.push({ statement, values });
        return { rows: [pinnedRow()] };
      },
    } as unknown as Pool).findDue({
      now: "2026-07-15T12:00:01.000Z",
      limit: 1,
    });

    expect(schedules).toMatchObject([
      {
        analysisTriggerVersionId: "trigger-version-1",
        automatedPrincipalId: "principal-1",
        connectorConfigurationVersionId: "connector-configuration-1",
        target: { externalId: "case-1" },
      },
    ]);
    expect(normalize(queries[0]?.statement ?? "")).toContain(
      "trigger.current_version_id = schedule.analysis_trigger_version_id",
    );
    expect(normalize(queries[0]?.statement ?? "")).toContain(
      "schedule.automated_principal_id IS NOT NULL",
    );
    expect(queries[0]?.values).toEqual(["2026-07-15T12:00:01.000Z", 1]);
  });

  it("atomically persists a durable trigger request, audit, and v2 outbox handoff", async () => {
    const client = new ScriptedTransactionClient([
      {},
      { rows: [{ fencing_token: 4n }] },
      { rows: [pinnedRow()] },
      { rows: [{ id: "occurrence-1" }] },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 },
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
      expect.stringContaining("FROM case_analysis_schedule_leases"),
      expect.stringContaining("FROM case_analysis_schedules AS schedule"),
      expect.stringContaining("INSERT INTO case_analysis_schedule_occurrences"),
      expect.stringContaining("INSERT INTO analysis_trigger_requests"),
      expect.stringContaining("INSERT INTO idempotency_records"),
      expect.stringContaining("INSERT INTO outbox_envelopes"),
      expect.stringContaining("INSERT INTO audit_events"),
      expect.stringContaining("UPDATE case_analysis_schedules"),
      expect.stringContaining("DELETE FROM case_analysis_schedule_leases"),
      "COMMIT",
    ]);
    const outbox = client.queries[6];
    expect(outbox?.values).toMatchObject([
      `analysis-trigger:${createHash("sha256")
        .update("occurrence-key-1", "utf8")
        .digest("hex")}`,
      "workspace-1",
      "2026-07-15T12:00:01.000Z",
      `schedule:schedule-1:${createHash("sha256")
        .update("occurrence-key-1", "utf8")
        .digest("hex")}`,
      JSON.stringify({
        triggerRequestId: "analysis-trigger-request:schedule:occurrence-key-1",
        triggerId: "trigger-1",
        triggerVersionId: "trigger-version-1",
        connectorRegistrationId: "connector-1",
        connectorConfigurationVersionId: "connector-configuration-1",
        source: "schedule",
        occurrenceKey: "occurrence-key-1",
        target: {
          connectorInstanceId: "connector-1",
          resourceType: "case",
          externalId: "case-1",
        },
      }),
    ]);
    expect(client.released).toBe(true);
  });

  it("rejects altered immutable pins before opening a transaction", async () => {
    const client = new ScriptedTransactionClient([]);
    const occurrence = input();
    const mismatched = {
      ...occurrence,
      command: {
        ...occurrence.command,
        connectorConfigurationVersionId: "connector-configuration-2",
      },
    };

    await expect(store(client).enqueueOccurrence(mismatched)).rejects.toThrow(
      "runtime pins are invalid",
    );
    expect(client.queries).toEqual([]);
  });
});
