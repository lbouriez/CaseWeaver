import { createHash } from "node:crypto";

import type {
  CaseAnalysisSchedule,
  CaseAnalysisScheduleStore,
  ScheduleCadence,
  ScheduleLease,
} from "@caseweaver/scheduling";
import type { Pool, PoolClient, QueryResultRow } from "pg";

interface ScheduleRow extends QueryResultRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly trigger_id: string;
  readonly configuration_version: string;
  readonly analysis_trigger_version_id: string | null;
  readonly target_connector_instance_id: string | null;
  readonly target_resource_type: string | null;
  readonly target_external_id: string | null;
  readonly automated_principal_id: string | null;
  readonly connector_registration_id: string | null;
  readonly connector_configuration_version_id: string | null;
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

function required(value: string | null, field: string): string {
  if (value === null || value.length === 0) {
    throw new Error(
      `Persisted case-analysis schedule ${field} is unavailable.`,
    );
  }
  return value;
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

  const analysisTriggerVersionId = required(
    row.analysis_trigger_version_id,
    "trigger version",
  );
  const connectorRegistrationId = required(
    row.connector_registration_id,
    "connector registration",
  );
  const connectorConfigurationVersionId = required(
    row.connector_configuration_version_id,
    "connector configuration version",
  );
  const connectorInstanceId = required(
    row.target_connector_instance_id,
    "target connector",
  );
  if (connectorInstanceId !== connectorRegistrationId) {
    throw new Error(
      "Persisted case-analysis schedule target connector is invalid.",
    );
  }
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspace_id,
    triggerId: row.trigger_id,
    configurationVersion: row.configuration_version,
    analysisTriggerVersionId,
    automatedPrincipalId: required(
      row.automated_principal_id,
      "automated principal",
    ),
    connectorRegistrationId,
    connectorConfigurationVersionId,
    target: Object.freeze({
      connectorInstanceId,
      resourceType: required(row.target_resource_type, "target resource type"),
      externalId: required(
        row.target_external_id,
        "target external identifier",
      ),
    }),
    cadence,
    enabled: row.enabled,
    nextRunAt: row.next_run_at.toISOString(),
  });
}

function pinnedScheduleQuery(where: string): string {
  return `SELECT
    schedule.id, schedule.workspace_id, schedule.trigger_id,
    schedule.configuration_version, schedule.analysis_trigger_version_id,
    schedule.target_connector_instance_id, schedule.target_resource_type,
    schedule.target_external_id, schedule.automated_principal_id,
    version.connector_registration_id, version.connector_configuration_version_id,
    schedule.trigger_kind, schedule.cron_expression, schedule.timezone,
    schedule.interval_ms, schedule.jitter_ms, schedule.enabled, schedule.next_run_at
  FROM case_analysis_schedules AS schedule
  JOIN analysis_triggers AS trigger
    ON trigger.workspace_id = schedule.workspace_id
   AND trigger.id = schedule.trigger_id
   AND trigger.lifecycle = 'active'
   AND trigger.current_version_id = schedule.analysis_trigger_version_id
  JOIN analysis_trigger_versions AS version
    ON version.workspace_id = schedule.workspace_id
   AND version.id = schedule.analysis_trigger_version_id
   AND version.analysis_trigger_id = schedule.trigger_id
  JOIN connector_registrations AS connector
    ON connector.workspace_id = version.workspace_id
   AND connector.id = version.connector_registration_id
   AND connector.lifecycle = 'active'
  JOIN connector_capabilities AS capability
    ON capability.workspace_id = connector.workspace_id
   AND capability.connector_registration_id = connector.id
   AND capability.capability = 'caseSource'
  JOIN administration_configurations AS configuration
    ON configuration.workspace_id = connector.workspace_id
   AND configuration.id = connector.id
   AND configuration.resource_type = 'connector-instances'
   AND configuration.lifecycle = 'active'
  JOIN administration_configuration_versions AS connector_version
    ON connector_version.workspace_id = configuration.workspace_id
   AND connector_version.id = version.connector_configuration_version_id
   AND connector_version.configuration_id = configuration.id
   AND connector_version.descriptor_kind = 'connector'
  JOIN administration_descriptor_revisions AS descriptor
    ON descriptor.kind = connector_version.descriptor_kind
   AND descriptor.type = connector_version.descriptor_type
   AND descriptor.version = connector_version.descriptor_version
   AND descriptor.descriptor -> 'connectorCapabilities' ? 'caseSource'
  JOIN principals AS actor
    ON actor.workspace_id = schedule.workspace_id
   AND actor.id = schedule.automated_principal_id
  WHERE ${where}`;
}

function samePinnedSchedule(
  schedule: CaseAnalysisSchedule,
  row: ScheduleRow,
): boolean {
  return (
    schedule.id === row.id &&
    schedule.workspaceId === row.workspace_id &&
    schedule.triggerId === row.trigger_id &&
    schedule.analysisTriggerVersionId === row.analysis_trigger_version_id &&
    schedule.automatedPrincipalId === row.automated_principal_id &&
    schedule.connectorRegistrationId === row.connector_registration_id &&
    schedule.connectorConfigurationVersionId ===
      row.connector_configuration_version_id &&
    schedule.target?.connectorInstanceId === row.target_connector_instance_id &&
    schedule.target?.resourceType === row.target_resource_type &&
    schedule.target?.externalId === row.target_external_id
  );
}

function requestDigests(
  input: Parameters<CaseAnalysisScheduleStore["enqueueOccurrence"]>[0],
): {
  readonly idempotencyKeyDigest: string;
  readonly requestDigest: string;
} {
  const request = [
    "analysis.trigger.schedule.v2",
    input.command.workspaceId,
    input.command.triggerRequestId,
    input.command.triggerId,
    input.command.triggerVersionId,
    input.command.connectorRegistrationId,
    input.command.connectorConfigurationVersionId,
    input.command.occurrenceKey,
    input.command.target.connectorInstanceId,
    input.command.target.resourceType,
    input.command.target.externalId,
  ].join("\u0000");
  return Object.freeze({
    idempotencyKeyDigest: hash(`idempotency\u0000${request}`),
    requestDigest: hash(`request\u0000${request}`),
  });
}

function assertPinnedOccurrence(
  input: Parameters<CaseAnalysisScheduleStore["enqueueOccurrence"]>[0],
): void {
  const { command, schedule } = input;
  if (
    command.type !== "analysis.trigger.v2" ||
    command.workspaceId !== schedule.workspaceId ||
    command.triggerRequestId !==
      `analysis-trigger-request:schedule:${input.occurrenceKey}` ||
    command.triggerId !== schedule.triggerId ||
    command.triggerVersionId !== schedule.analysisTriggerVersionId ||
    command.connectorRegistrationId !== schedule.connectorRegistrationId ||
    command.connectorConfigurationVersionId !==
      schedule.connectorConfigurationVersionId ||
    command.source !== "schedule" ||
    command.occurrenceKey !== input.occurrenceKey ||
    command.target.connectorInstanceId !==
      schedule.target?.connectorInstanceId ||
    command.target.resourceType !== schedule.target?.resourceType ||
    command.target.externalId !== schedule.target?.externalId ||
    schedule.automatedPrincipalId === undefined ||
    schedule.automatedPrincipalId.length === 0
  ) {
    throw new Error(
      "Case-analysis schedule occurrence runtime pins are invalid.",
    );
  }
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
      `${pinnedScheduleQuery(`
        schedule.enabled
        AND schedule.next_run_at <= $1
        AND schedule.analysis_trigger_version_id IS NOT NULL
        AND schedule.target_connector_instance_id IS NOT NULL
        AND schedule.target_resource_type IS NOT NULL
        AND schedule.target_external_id IS NOT NULL
        AND schedule.automated_principal_id IS NOT NULL
      `)}
       ORDER BY schedule.next_run_at, schedule.id
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
    assertPinnedOccurrence(input);
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
      const locked = await client.query<ScheduleRow>(
        `${pinnedScheduleQuery("schedule.workspace_id = $1 AND schedule.id = $2")}
         FOR UPDATE OF schedule`,
        [input.schedule.workspaceId, input.schedule.id],
      );
      const current = locked.rows[0];
      if (
        current === undefined ||
        !samePinnedSchedule(input.schedule, current)
      ) {
        throw new Error("Case-analysis schedule runtime pins are unavailable.");
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
          input.schedule.nextRunAt,
        ],
      );
      if (occurrence.rows[0] === undefined) {
        await this.releaseLease(client, input);
        await client.query("COMMIT");
        return "duplicate";
      }
      const digests = requestDigests(input);
      await client.query(
        `INSERT INTO analysis_trigger_requests (
           id, workspace_id, actor_principal_id, analysis_trigger_version_id,
           analysis_profile_version_id, connector_registration_id,
           connector_configuration_version_id, source, occurrence_key,
           target_connector_instance_id, target_resource_type, target_external_id,
           idempotency_key_digest, request_digest, state, created_at, updated_at
         ) SELECT
           $1, schedule.workspace_id, schedule.automated_principal_id,
           version.id, version.analysis_profile_version_id,
           version.connector_registration_id, version.connector_configuration_version_id,
           'schedule', $2, schedule.target_connector_instance_id,
           schedule.target_resource_type, schedule.target_external_id,
           $3, $4, 'pending', $5, $5
         FROM case_analysis_schedules AS schedule
         JOIN analysis_trigger_versions AS version
           ON version.workspace_id = schedule.workspace_id
          AND version.id = schedule.analysis_trigger_version_id
         WHERE schedule.workspace_id = $6 AND schedule.id = $7`,
        [
          input.command.triggerRequestId,
          input.command.occurrenceKey,
          digests.idempotencyKeyDigest,
          digests.requestDigest,
          input.now,
          input.schedule.workspaceId,
          input.schedule.id,
        ],
      );
      await client.query(
        `INSERT INTO idempotency_records (
           workspace_id, operation, key_digest, request_digest, resource_id, created_at
         ) VALUES ($1, 'analysis.trigger', $2, $3, $4, $5)`,
        [
          input.schedule.workspaceId,
          digests.idempotencyKeyDigest,
          digests.requestDigest,
          input.command.triggerRequestId,
          input.now,
        ],
      );
      const envelopeId = `analysis-trigger:${hash(input.occurrenceKey)}`;
      const envelopeContext = `schedule:${input.schedule.id}:${hash(
        input.occurrenceKey,
      )}`;
      await client.query(
        `INSERT INTO outbox_envelopes (
           id, workspace_id, kind, type, schema_version, occurred_at,
           correlation_id, causation_id, payload, available_at
         ) VALUES ($1, $2, 'command', 'analysis.trigger.v2', 1, $3, $4, $4, $5::jsonb, $3)`,
        [
          envelopeId,
          input.schedule.workspaceId,
          input.now,
          envelopeContext,
          JSON.stringify({
            triggerRequestId: input.command.triggerRequestId,
            triggerId: input.command.triggerId,
            triggerVersionId: input.command.triggerVersionId,
            connectorRegistrationId: input.command.connectorRegistrationId,
            connectorConfigurationVersionId:
              input.command.connectorConfigurationVersionId,
            source: "schedule",
            occurrenceKey: input.command.occurrenceKey,
            target: input.command.target,
          }),
        ],
      );
      await client.query(
        `INSERT INTO audit_events (
           id, workspace_id, actor_principal_id, action, target_id, after_hash, occurred_at
         ) VALUES ($1, $2, $3, 'analysis.trigger.requested', $4, $5, $6)`,
        [
          `audit:analysis-trigger-schedule:${hash(input.occurrenceKey)}`,
          input.schedule.workspaceId,
          input.schedule.automatedPrincipalId,
          input.command.triggerRequestId,
          digests.requestDigest,
          input.now,
        ],
      );
      const advanced = await client.query(
        `UPDATE case_analysis_schedules
         SET next_run_at = $1, updated_at = NOW()
         WHERE workspace_id = $2 AND id = $3 AND enabled`,
        [input.nextRunAt, input.schedule.workspaceId, input.schedule.id],
      );
      if (advanced.rowCount !== 1) {
        throw new Error("Case-analysis schedule is no longer enabled.");
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

  private async releaseLease(
    client: PoolClient,
    input: Parameters<CaseAnalysisScheduleStore["enqueueOccurrence"]>[0],
  ): Promise<void> {
    const released = await client.query(
      `DELETE FROM case_analysis_schedule_leases
       WHERE workspace_id = $1
         AND case_analysis_schedule_id = $2
         AND fencing_token = $3`,
      [input.schedule.workspaceId, input.schedule.id, input.lease.fencingToken],
    );
    if (released.rowCount !== 1) {
      throw new Error("Case-analysis schedule lease is no longer current.");
    }
  }
}
