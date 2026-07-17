import { createHash } from "node:crypto";

import type {
  CaseDiscoverySchedule,
  CaseDiscoveryScheduleStore,
  ScheduleCadence,
  ScheduleLease,
} from "@caseweaver/scheduling";
import type { Pool, PoolClient, QueryResultRow } from "pg";

interface ScheduleRow extends QueryResultRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly configuration_version_id: string;
  readonly trigger_id: string;
  readonly trigger_version_id: string;
  readonly automated_principal_id: string;
  readonly connector_registration_id: string;
  readonly connector_configuration_version_id: string;
  readonly cadence: unknown;
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

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Persisted case-discovery schedule ${field} is invalid.`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`Persisted case-discovery schedule ${field} is invalid.`);
  }
  return value as number;
}

function optionalNonNegativeInteger(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Persisted case-discovery schedule ${field} is invalid.`);
  }
  return value as number;
}

function cadence(value: unknown): ScheduleCadence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Persisted case-discovery schedule cadence is invalid.");
  }
  const object = value as Record<string, unknown>;
  const jitterMs = optionalNonNegativeInteger(object.jitterMs, "jitter");
  if (object.kind === "interval") {
    return Object.freeze({
      kind: "interval",
      intervalMs: positiveInteger(object.intervalMs, "interval"),
      ...(jitterMs === undefined ? {} : { jitterMs }),
    });
  }
  if (object.kind === "cron") {
    return Object.freeze({
      kind: "cron",
      expression: nonEmpty(object.expression, "cron expression"),
      timezone: nonEmpty(object.timezone, "cron timezone"),
      ...(jitterMs === undefined ? {} : { jitterMs }),
    });
  }
  throw new Error("Persisted case-discovery schedule cadence is invalid.");
}

function toSchedule(row: ScheduleRow): CaseDiscoverySchedule {
  return Object.freeze({
    id: nonEmpty(row.id, "id"),
    workspaceId: nonEmpty(row.workspace_id, "workspace"),
    configurationVersionId: nonEmpty(
      row.configuration_version_id,
      "configuration version",
    ),
    triggerId: nonEmpty(row.trigger_id, "trigger"),
    triggerVersionId: nonEmpty(row.trigger_version_id, "trigger version"),
    automatedPrincipalId: nonEmpty(
      row.automated_principal_id,
      "automated principal",
    ),
    connectorRegistrationId: nonEmpty(
      row.connector_registration_id,
      "connector registration",
    ),
    connectorConfigurationVersionId: nonEmpty(
      row.connector_configuration_version_id,
      "connector configuration version",
    ),
    cadence: cadence(row.cadence),
    enabled: row.enabled,
    nextRunAt: row.next_run_at.toISOString(),
  });
}

/**
 * Resolves all runtime pins while the schedule is locked.  A PBI-020 intake
 * schedule is available only when its generic schedule aggregate, generic
 * trigger aggregate, PBI-012 trigger version, case-source connector, and
 * activation principal still prove the exact immutable runtime identity.
 */
function pinnedScheduleQuery(where: string): string {
  return `SELECT
    schedule.id,
    schedule.workspace_id,
    schedule.configuration_version_id,
    trigger_configuration.id AS trigger_id,
    trigger_version.id AS trigger_version_id,
    schedule.automated_principal_id,
    trigger_version.connector_registration_id,
    trigger_version.connector_configuration_version_id,
    schedule.cadence,
    schedule.enabled,
    schedule.next_run_at
  FROM case_analysis_intake_schedules AS schedule
  JOIN administration_configurations AS schedule_configuration
    ON schedule_configuration.workspace_id = schedule.workspace_id
   AND schedule_configuration.id = schedule.schedule_id
   AND schedule_configuration.resource_type = 'case-analysis-schedules'
   AND schedule_configuration.lifecycle = 'active'
   AND schedule_configuration.current_version_id = schedule.configuration_version_id
  JOIN administration_configurations AS trigger_configuration
    ON trigger_configuration.workspace_id = schedule.workspace_id
   AND trigger_configuration.resource_type = 'case-analysis-triggers'
   AND trigger_configuration.lifecycle = 'active'
   AND trigger_configuration.current_version_id = schedule.analysis_trigger_configuration_version_id
  JOIN analysis_triggers AS trigger
    ON trigger.workspace_id = schedule.workspace_id
   AND trigger.id = trigger_configuration.id
   AND trigger.lifecycle = 'active'
   AND trigger.current_version_id = schedule.analysis_trigger_configuration_version_id
  JOIN analysis_trigger_versions AS trigger_version
    ON trigger_version.workspace_id = schedule.workspace_id
   AND trigger_version.id = schedule.analysis_trigger_configuration_version_id
   AND trigger_version.analysis_trigger_id = trigger.id
  JOIN connector_registrations AS connector
    ON connector.workspace_id = trigger_version.workspace_id
   AND connector.id = trigger_version.connector_registration_id
   AND connector.lifecycle = 'active'
  JOIN connector_capabilities AS capability
    ON capability.workspace_id = connector.workspace_id
   AND capability.connector_registration_id = connector.id
   AND capability.capability = 'caseSource'
  JOIN administration_configurations AS connector_configuration
    ON connector_configuration.workspace_id = connector.workspace_id
   AND connector_configuration.id = connector.id
   AND connector_configuration.resource_type = 'connector-instances'
   AND connector_configuration.lifecycle = 'active'
  JOIN administration_configuration_versions AS connector_version
    ON connector_version.workspace_id = connector_configuration.workspace_id
   AND connector_version.id = trigger_version.connector_configuration_version_id
   AND connector_version.configuration_id = connector_configuration.id
   AND connector_version.descriptor_kind = 'connector'
  JOIN administration_descriptor_revisions AS descriptor
    ON descriptor.kind = connector_version.descriptor_kind
   AND descriptor.type = connector_version.descriptor_type
   AND descriptor.version = connector_version.descriptor_version
   AND descriptor.descriptor -> 'connectorCapabilities' ? 'caseSource'
  JOIN principals AS principal
    ON principal.workspace_id = schedule.workspace_id
   AND principal.id = schedule.automated_principal_id
  WHERE ${where}`;
}

function samePinnedSchedule(
  schedule: CaseDiscoverySchedule,
  row: ScheduleRow,
): boolean {
  return (
    schedule.id === row.id &&
    schedule.workspaceId === row.workspace_id &&
    schedule.configurationVersionId === row.configuration_version_id &&
    schedule.triggerId === row.trigger_id &&
    schedule.triggerVersionId === row.trigger_version_id &&
    schedule.automatedPrincipalId === row.automated_principal_id &&
    schedule.connectorRegistrationId === row.connector_registration_id &&
    schedule.connectorConfigurationVersionId ===
      row.connector_configuration_version_id
  );
}

function assertOccurrence(
  input: Parameters<CaseDiscoveryScheduleStore["enqueueOccurrence"]>[0],
): void {
  const { command, schedule } = input;
  if (
    command.type !== "analysis.discover.v1" ||
    command.workspaceId !== schedule.workspaceId ||
    command.scheduleId !== schedule.id ||
    command.scheduleConfigurationVersionId !== schedule.configurationVersionId ||
    command.triggerId !== schedule.triggerId ||
    command.triggerVersionId !== schedule.triggerVersionId ||
    command.connectorRegistrationId !== schedule.connectorRegistrationId ||
    command.connectorConfigurationVersionId !==
      schedule.connectorConfigurationVersionId ||
    command.occurrenceKey !== input.occurrenceKey
  ) {
    throw new Error("Case-discovery schedule occurrence runtime pins are invalid.");
  }
}

export class PostgresCaseDiscoveryScheduleStore
  implements CaseDiscoveryScheduleStore
{
  public constructor(private readonly pool: Pool) {}

  public async findDue(input: {
    readonly now: string;
    readonly limit: number;
  }): Promise<readonly CaseDiscoverySchedule[]> {
    const result = await this.pool.query<ScheduleRow>(
      `${pinnedScheduleQuery("schedule.enabled AND schedule.next_run_at <= $1")}
       ORDER BY schedule.next_run_at, schedule.id
       LIMIT $2`,
      [input.now, input.limit],
    );
    return Object.freeze(result.rows.map(toSchedule));
  }

  public async acquireLease(input: {
    readonly schedule: CaseDiscoverySchedule;
    readonly now: string;
    readonly leaseMs: number;
  }): Promise<ScheduleLease | undefined> {
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1) {
      throw new RangeError("Schedule lease duration must be a positive integer.");
    }
    const result = await this.pool.query<LeaseRow>(
      `INSERT INTO case_analysis_intake_schedule_leases (
         workspace_id, case_analysis_intake_schedule_id, fencing_token, expires_at
       ) VALUES ($1, $2, 1, NOW() + ($3 * INTERVAL '1 millisecond'))
       ON CONFLICT (workspace_id, case_analysis_intake_schedule_id)
       DO UPDATE SET
         fencing_token = case_analysis_intake_schedule_leases.fencing_token + 1,
         expires_at = NOW() + ($3 * INTERVAL '1 millisecond'),
         updated_at = NOW()
       WHERE case_analysis_intake_schedule_leases.expires_at <= NOW()
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
    input: Parameters<CaseDiscoveryScheduleStore["enqueueOccurrence"]>[0],
  ): Promise<"enqueued" | "duplicate"> {
    assertOccurrence(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.assertLease(client, input);
      const locked = await client.query<ScheduleRow>(
        `${pinnedScheduleQuery("schedule.workspace_id = $1 AND schedule.id = $2")}
         FOR UPDATE OF schedule`,
        [input.schedule.workspaceId, input.schedule.id],
      );
      const current = locked.rows[0];
      if (current === undefined || !samePinnedSchedule(input.schedule, current)) {
        throw new Error("Case-discovery schedule runtime pins are unavailable.");
      }
      const occurrence = await client.query<{ readonly id: string }>(
        `INSERT INTO case_analysis_intake_schedule_occurrences (
          id, workspace_id, case_analysis_intake_schedule_id, occurrence_key, scheduled_for,
          configuration_version_id, trigger_version_id, connector_configuration_version_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (workspace_id, case_analysis_intake_schedule_id, occurrence_key)
        DO NOTHING
        RETURNING id`,
        [
          `case-discovery-occurrence:${hash(input.occurrenceKey)}`,
          input.schedule.workspaceId,
          input.schedule.id,
          input.occurrenceKey,
          input.schedule.nextRunAt,
          input.command.scheduleConfigurationVersionId,
          input.command.triggerVersionId,
          input.command.connectorConfigurationVersionId,
        ],
      );
      if (occurrence.rows[0] === undefined) {
        await this.releaseLease(client, input);
        await client.query("COMMIT");
        return "duplicate";
      }
      const context = `case-discovery:${input.schedule.id}:${hash(input.occurrenceKey)}`;
      await client.query(
        `INSERT INTO outbox_envelopes (
           id, workspace_id, kind, type, schema_version, occurred_at,
           correlation_id, causation_id, payload, available_at
         ) VALUES ($1, $2, 'command', 'analysis.discover.v1', 1, $3, $4, $4, $5::jsonb, $3)`,
        [
          `case-discovery:${hash(input.occurrenceKey)}`,
          input.schedule.workspaceId,
          input.now,
          context,
          JSON.stringify({
            scheduleId: input.command.scheduleId,
            scheduleConfigurationVersionId:
              input.command.scheduleConfigurationVersionId,
            triggerId: input.command.triggerId,
            triggerVersionId: input.command.triggerVersionId,
            connectorRegistrationId: input.command.connectorRegistrationId,
            connectorConfigurationVersionId:
              input.command.connectorConfigurationVersionId,
            occurrenceKey: input.command.occurrenceKey,
          }),
        ],
      );
      await client.query(
        `INSERT INTO audit_events (
           id, workspace_id, actor_principal_id, action, target_id, after_hash, occurred_at
         ) VALUES ($1, $2, $3, 'analysis.discovery.requested', $4, $5, $6)`,
        [
          `audit:case-discovery:${hash(input.occurrenceKey)}`,
          input.schedule.workspaceId,
          input.schedule.automatedPrincipalId,
          input.schedule.id,
          hash(
            [
              input.command.scheduleConfigurationVersionId,
              input.command.triggerVersionId,
              input.command.connectorConfigurationVersionId,
              input.command.occurrenceKey,
            ].join("\u0000"),
          ),
          input.now,
        ],
      );
      const advanced = await client.query(
        `UPDATE case_analysis_intake_schedules
         SET next_run_at = $1
         WHERE workspace_id = $2 AND id = $3 AND enabled`,
        [input.nextRunAt, input.schedule.workspaceId, input.schedule.id],
      );
      if (advanced.rowCount !== 1) {
        throw new Error("Case-discovery schedule is no longer enabled.");
      }
      await this.releaseLease(client, input);
      await client.query("COMMIT");
      return "enqueued";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async assertLease(
    client: PoolClient,
    input: Parameters<CaseDiscoveryScheduleStore["enqueueOccurrence"]>[0],
  ): Promise<void> {
    const lease = await client.query<LeaseRow>(
      `SELECT fencing_token
       FROM case_analysis_intake_schedule_leases
       WHERE workspace_id = $1
         AND case_analysis_intake_schedule_id = $2
         AND fencing_token = $3
         AND expires_at > NOW()
       FOR UPDATE`,
      [input.schedule.workspaceId, input.schedule.id, input.lease.fencingToken],
    );
    if (lease.rows[0] === undefined) {
      throw new Error("Case-discovery schedule lease is no longer current.");
    }
  }

  private async releaseLease(
    client: PoolClient,
    input: Parameters<CaseDiscoveryScheduleStore["enqueueOccurrence"]>[0],
  ): Promise<void> {
    const deleted = await client.query(
      `DELETE FROM case_analysis_intake_schedule_leases
       WHERE workspace_id = $1
         AND case_analysis_intake_schedule_id = $2
         AND fencing_token = $3`,
      [input.schedule.workspaceId, input.schedule.id, input.lease.fencingToken],
    );
    if (deleted.rowCount !== 1) {
      throw new Error("Case-discovery schedule lease is no longer current.");
    }
  }
}
