import { createHash } from "node:crypto";

import type {
  CaseAnalysisSchedule,
  CaseAnalysisScheduleStore,
  ScheduleCadence,
  ScheduleLease,
} from "@caseweaver/scheduling";
import type { Pool, QueryResultRow } from "pg";

interface ScheduleRow extends QueryResultRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly trigger_id: string;
  readonly configuration_version: string;
  readonly trigger_kind: "cron" | "interval";
  readonly cron_expression: string | null;
  readonly timezone: string | null;
  readonly interval_ms: string | null;
  readonly jitter_ms: string | null;
  readonly enabled: boolean;
  readonly next_run_at: Date;
}

interface LeaseRow extends QueryResultRow {
  readonly fencing_token: bigint;
  readonly expires_at: Date;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function asSafeInteger(
  value: string | null,
  field: string,
): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Persisted ${field} must be a safe integer.`);
  }
  return parsed;
}

function toSchedule(row: ScheduleRow): CaseAnalysisSchedule {
  const jitterMs = asSafeInteger(row.jitter_ms, "schedule jitter");
  let cadence: ScheduleCadence;
  if (row.trigger_kind === "cron") {
    if (row.cron_expression === null || row.timezone === null) {
      throw new Error("Persisted cron schedule is incomplete.");
    }
    cadence = {
      kind: "cron",
      expression: row.cron_expression,
      timezone: row.timezone,
      jitterMs,
    };
  } else {
    const intervalMs = asSafeInteger(row.interval_ms, "schedule interval");
    if (intervalMs === undefined) {
      throw new Error("Persisted interval schedule is incomplete.");
    }
    cadence = { kind: "interval", intervalMs, jitterMs };
  }
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspace_id,
    triggerId: row.trigger_id,
    configurationVersion: row.configuration_version,
    cadence,
    enabled: row.enabled,
    nextRunAt: row.next_run_at.toISOString(),
  });
}

export class PostgresCaseAnalysisScheduleStore
  implements CaseAnalysisScheduleStore
{
  public constructor(private readonly pool: Pool) {}

  public async findDue(input: {
    readonly now: string;
    readonly limit: number;
  }): Promise<readonly CaseAnalysisSchedule[]> {
    const result = await this.pool.query<ScheduleRow>(
      `SELECT
         id, workspace_id, trigger_id, configuration_version, trigger_kind,
         cron_expression, timezone, interval_ms, jitter_ms, enabled, next_run_at
       FROM case_analysis_schedules
       WHERE enabled AND next_run_at <= $1
       ORDER BY next_run_at, id
       LIMIT $2`,
      [input.now, input.limit],
    );
    return Object.freeze(result.rows.map(toSchedule));
  }

  public async acquireLease(input: {
    readonly schedule: CaseAnalysisSchedule;
    readonly now: string;
    readonly leaseMs: number;
  }): Promise<ScheduleLease | undefined> {
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1) {
      throw new RangeError(
        "Schedule lease duration must be a positive integer.",
      );
    }
    const result = await this.pool.query<LeaseRow>(
      `INSERT INTO case_analysis_schedule_leases (
         workspace_id, case_analysis_schedule_id, fencing_token, expires_at
       ) VALUES ($1, $2, 1, NOW() + ($3 * INTERVAL '1 millisecond'))
       ON CONFLICT (workspace_id, case_analysis_schedule_id)
       DO UPDATE SET
         fencing_token = case_analysis_schedule_leases.fencing_token + 1,
         expires_at = NOW() + ($3 * INTERVAL '1 millisecond'),
         updated_at = NOW()
       WHERE case_analysis_schedule_leases.expires_at <= NOW()
       RETURNING fencing_token, expires_at`,
      [input.schedule.workspaceId, input.schedule.id, input.leaseMs],
    );
    const lease = result.rows[0];
    return lease === undefined
      ? undefined
      : Object.freeze({
          fencingToken: lease.fencing_token,
          expiresAt: lease.expires_at.toISOString(),
        });
  }

  public async enqueueOccurrence(
    input: Parameters<CaseAnalysisScheduleStore["enqueueOccurrence"]>[0],
  ): Promise<"enqueued" | "duplicate"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const lease = await client.query<LeaseRow>(
        `SELECT fencing_token
         FROM case_analysis_schedule_leases
         WHERE workspace_id = $1
           AND case_analysis_schedule_id = $2
           AND fencing_token = $3
           AND expires_at > NOW()
         FOR UPDATE`,
        [
          input.schedule.workspaceId,
          input.schedule.id,
          input.lease.fencingToken,
        ],
      );
      if (lease.rows[0] === undefined) {
        throw new Error("Case-analysis schedule lease is no longer current.");
      }
      const occurrence = await client.query<{ readonly id: string }>(
        `INSERT INTO case_analysis_schedule_occurrences (
           id, workspace_id, case_analysis_schedule_id, occurrence_key, scheduled_for
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (
           workspace_id, case_analysis_schedule_id, occurrence_key
         ) DO NOTHING
         RETURNING id`,
        [
          `case-analysis-occurrence:${hash(input.occurrenceKey)}`,
          input.schedule.workspaceId,
          input.schedule.id,
          input.occurrenceKey,
          input.command.scheduledFor,
        ],
      );
      if (occurrence.rows[0] === undefined) {
        await client.query(
          `DELETE FROM case_analysis_schedule_leases
           WHERE workspace_id = $1
             AND case_analysis_schedule_id = $2
             AND fencing_token = $3`,
          [
            input.schedule.workspaceId,
            input.schedule.id,
            input.lease.fencingToken,
          ],
        );
        await client.query("COMMIT");
        return "duplicate";
      }
      const advanced = await client.query(
        `UPDATE case_analysis_schedules
         SET next_run_at = $1, updated_at = NOW()
         WHERE workspace_id = $2 AND id = $3 AND enabled`,
        [input.nextRunAt, input.schedule.workspaceId, input.schedule.id],
      );
      if (advanced.rowCount !== 1) {
        throw new Error("Case-analysis schedule is no longer enabled.");
      }
      const envelopeId = `analysis-trigger:${hash(input.occurrenceKey)}`;
      await client.query(
        `INSERT INTO outbox_envelopes (
           id, workspace_id, kind, type, schema_version, occurred_at,
           correlation_id, causation_id, payload, available_at
         ) VALUES ($1, $2, 'command', 'analysis.trigger.v1', 1, $3, $4, $5, $6::jsonb, $3)
         ON CONFLICT (id) DO NOTHING`,
        [
          envelopeId,
          input.schedule.workspaceId,
          input.now,
          `schedule:${input.schedule.id}:${hash(input.occurrenceKey)}`,
          `schedule:${input.schedule.id}:${hash(input.occurrenceKey)}`,
          JSON.stringify({
            triggerId: input.command.triggerId,
            source: "schedule",
            occurrenceKey: input.command.occurrenceKey,
          }),
        ],
      );
      const released = await client.query(
        `DELETE FROM case_analysis_schedule_leases
         WHERE workspace_id = $1
           AND case_analysis_schedule_id = $2
           AND fencing_token = $3`,
        [
          input.schedule.workspaceId,
          input.schedule.id,
          input.lease.fencingToken,
        ],
      );
      if (released.rowCount !== 1) {
        throw new Error("Case-analysis schedule lease is no longer current.");
      }
      await client.query("COMMIT");
      return "enqueued";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
