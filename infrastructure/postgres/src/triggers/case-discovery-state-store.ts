import type {
  CaseDiscoveryStateStore,
  ClaimedCaseDiscovery,
} from "@caseweaver/application";
import { principalId } from "@caseweaver/domain";
import type { PrismaClient } from "@prisma/client";

interface PinnedScheduleRow {
  readonly actor_principal_id: string;
  readonly cursor_version: string | null;
  readonly cursor_value: string | null;
  readonly cursor_state: string | null;
  readonly cursor_lease_expires_at: Date | null;
  readonly cursor_active: boolean | null;
}

interface CursorClaimRow {
  readonly execution_fence: bigint;
  readonly cursor_version: string | null;
  readonly cursor_value: string | null;
}

function validCursor(value: { readonly version: string; readonly value: string }): boolean {
  return (
    value.version.length > 0 &&
    value.version.length <= 200 &&
    value.value.length > 0 &&
    value.value.length <= 16_384
  );
}

function validFailureCode(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/u.test(value);
}

/**
 * Locks a PBI-020 intake schedule and proves every immutable runtime pin
 * before exposing its private cursor. The cursor table is deliberately not an
 * administration read model and this adapter has no connector dependency.
 */
export class PostgresCaseDiscoveryStateStore
  implements CaseDiscoveryStateStore
{
  public constructor(private readonly database: PrismaClient) {}

  public async claim(
    input: Parameters<CaseDiscoveryStateStore["claim"]>[0],
  ): Promise<Awaited<ReturnType<CaseDiscoveryStateStore["claim"]>>> {
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1) {
      throw new RangeError("Case discovery lease must be a positive integer.");
    }
    return this.database.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<readonly PinnedScheduleRow[]>`
        SELECT
          schedule.automated_principal_id,
          cursor.cursor_version,
          cursor.cursor_value,
          cursor.state AS cursor_state,
          cursor.lease_expires_at AS cursor_lease_expires_at,
          cursor.lease_expires_at > NOW() AS cursor_active
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
        LEFT JOIN case_analysis_intake_schedule_cursors AS cursor
          ON cursor.workspace_id = schedule.workspace_id
         AND cursor.case_analysis_intake_schedule_id = schedule.id
        WHERE schedule.workspace_id = ${input.command.workspaceId}
          AND schedule.id = ${input.command.payload.scheduleId}
          AND schedule.configuration_version_id = ${input.command.payload.scheduleConfigurationVersionId}
          AND trigger.id = ${input.command.payload.triggerId}
          AND trigger_version.id = ${input.command.payload.triggerVersionId}
          AND trigger_version.connector_registration_id = ${input.command.payload.connectorRegistrationId}
          AND trigger_version.connector_configuration_version_id = ${input.command.payload.connectorConfigurationVersionId}
          AND schedule.enabled
        FOR UPDATE OF schedule, cursor
      `;
      const pinned = rows[0];
      if (pinned === undefined) return { kind: "unavailable" };
      if (
        pinned.cursor_state === "running" &&
        pinned.cursor_lease_expires_at !== null &&
        pinned.cursor_active === true
      ) {
        return { kind: "alreadyRunning" };
      }
      if (
        (pinned.cursor_version === null) !== (pinned.cursor_value === null)
      ) {
        return { kind: "unavailable" };
      }
      const claimed = await transaction.$queryRaw<readonly CursorClaimRow[]>`
        INSERT INTO case_analysis_intake_schedule_cursors (
          workspace_id, case_analysis_intake_schedule_id, execution_fence,
          lease_expires_at, state, updated_at
        ) VALUES (
          ${input.command.workspaceId}, ${input.command.payload.scheduleId}, 1,
          NOW() + (${input.leaseMs} * INTERVAL '1 millisecond'), 'running', NOW()
        )
        ON CONFLICT (workspace_id, case_analysis_intake_schedule_id)
        DO UPDATE SET
          execution_fence = case_analysis_intake_schedule_cursors.execution_fence + 1,
          lease_expires_at = NOW() + (${input.leaseMs} * INTERVAL '1 millisecond'),
          state = 'running',
          error_code = NULL,
          error_retryable = NULL,
          updated_at = NOW()
        WHERE case_analysis_intake_schedule_cursors.state <> 'running'
           OR case_analysis_intake_schedule_cursors.lease_expires_at <= NOW()
        RETURNING execution_fence, cursor_version, cursor_value
      `;
      const cursor = claimed[0];
      if (cursor === undefined) return { kind: "alreadyRunning" };
      if ((cursor.cursor_version === null) !== (cursor.cursor_value === null)) {
        throw new Error("Case discovery cursor is invalid.");
      }
      const claim: ClaimedCaseDiscovery = Object.freeze({
        fencingToken: cursor.execution_fence,
        actorPrincipalId: principalId(pinned.actor_principal_id),
        ...(cursor.cursor_version === null || cursor.cursor_value === null
          ? {}
          : {
              cursor: Object.freeze({
                version: cursor.cursor_version,
                value: cursor.cursor_value,
              }),
            }),
      });
      return Object.freeze({ kind: "claimed", claim });
    });
  }

  public async advance(
    input: Parameters<CaseDiscoveryStateStore["advance"]>[0],
  ): Promise<void> {
    if (!validCursor(input.cursor)) {
      throw new Error("Case discovery cursor is invalid.");
    }
    const updated = await this.database.$executeRaw`
      UPDATE case_analysis_intake_schedule_cursors
      SET
        cursor_version = ${input.cursor.version},
        cursor_value = ${input.cursor.value},
        updated_at = NOW()
      WHERE workspace_id = ${input.command.workspaceId}
        AND case_analysis_intake_schedule_id = ${input.command.payload.scheduleId}
        AND execution_fence = ${input.claim.fencingToken}
        AND state = 'running'
        AND lease_expires_at > NOW()
    `;
    if (updated !== 1) {
      throw new Error("Case discovery cursor claim was lost.");
    }
  }

  public async complete(
    input: Parameters<CaseDiscoveryStateStore["complete"]>[0],
  ): Promise<void> {
    const updated = await this.database.$executeRaw`
      UPDATE case_analysis_intake_schedule_cursors
      SET
        state = 'idle',
        lease_expires_at = NULL,
        error_code = NULL,
        error_retryable = NULL,
        updated_at = NOW()
      WHERE workspace_id = ${input.command.workspaceId}
        AND case_analysis_intake_schedule_id = ${input.command.payload.scheduleId}
        AND execution_fence = ${input.claim.fencingToken}
        AND state = 'running'
        AND lease_expires_at > NOW()
    `;
    if (updated !== 1) {
      throw new Error("Case discovery cursor claim was lost.");
    }
  }

  public async fail(
    input: Parameters<CaseDiscoveryStateStore["fail"]>[0],
  ): Promise<void> {
    const code = validFailureCode(input.code)
      ? input.code
      : "analysis.discovery.failed";
    await this.database.$executeRaw`
      UPDATE case_analysis_intake_schedule_cursors
      SET
        state = 'failed',
        lease_expires_at = NULL,
        error_code = ${code},
        error_retryable = ${input.retryable},
        updated_at = NOW()
      WHERE workspace_id = ${input.command.workspaceId}
        AND case_analysis_intake_schedule_id = ${input.command.payload.scheduleId}
        AND execution_fence = ${input.claim.fencingToken}
        AND state = 'running'
    `;
  }
}
