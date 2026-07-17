import { CaseDiscoveryScheduler } from "@caseweaver/scheduling";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresCaseDiscoveryScheduleStore } from "./case-discovery.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("PostgreSQL integration tests require DATABASE_URL.");
}
if (!new URL(databaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error("PostgreSQL integration DATABASE_URL must name a test database.");
}

const pool = new Pool({ connectionString: databaseUrl });
const workspace = "workspace-case-discovery-schedule";
const principal = "principal-case-discovery-schedule";
const connector = "connector-case-discovery-schedule";
const connectorVersion = "connector-version-case-discovery-schedule";
const profile = "analysis-profile-case-discovery-schedule";
const profileVersion = "analysis-profile-version-case-discovery-schedule";
const trigger = "analysis-trigger-case-discovery-schedule";
const triggerVersion = "analysis-trigger-version-case-discovery-schedule";
const schedule = "case-discovery-schedule";
const scheduleVersion = "case-discovery-schedule-version";
const now = "2026-07-17T18:00:01.000Z";

async function resetDatabase(): Promise<void> {
  await pool.query("TRUNCATE TABLE workspaces RESTART IDENTITY CASCADE");
}

async function configuration(input: {
  readonly id: string;
  readonly resourceType: string;
  readonly versionId: string;
  readonly descriptor?: Readonly<{
    readonly kind: string;
    readonly type: string;
    readonly version: string;
  }>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO administration_configurations (
       id, workspace_id, resource_type, lifecycle, revision, current_version_id
     ) VALUES ($1, $2, $3, 'active', 1, NULL)`,
    [input.id, workspace, input.resourceType],
  );
  await pool.query(
    `INSERT INTO administration_configuration_versions (
       id, workspace_id, configuration_id, version, settings, secret_references,
       descriptor_kind, descriptor_type, descriptor_version
     ) VALUES ($1, $2, $3, 1, '{}'::jsonb, '[]'::jsonb, $4, $5, $6)`,
    [
      input.versionId,
      workspace,
      input.id,
      input.descriptor?.kind ?? null,
      input.descriptor?.type ?? null,
      input.descriptor?.version ?? null,
    ],
  );
  await pool.query(
    `UPDATE administration_configurations
     SET current_version_id = $1
     WHERE workspace_id = $2 AND id = $3`,
    [input.versionId, workspace, input.id],
  );
}

async function seed(): Promise<void> {
  await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [workspace]);
  await pool.query("INSERT INTO principals (id, workspace_id) VALUES ($1, $2)", [
    principal,
    workspace,
  ]);
  await pool.query(
    `INSERT INTO administration_descriptor_revisions (
       kind, type, version, descriptor, descriptor_hash
     ) VALUES (
       'connector', 'case-discovery-schedule-test', 'v1',
       '{"connectorCapabilities":["caseSource"]}'::jsonb, repeat('a', 64)
     ) ON CONFLICT (kind, type, version) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO connector_registrations (id, workspace_id, lifecycle)
     VALUES ($1, $2, 'active')`,
    [connector, workspace],
  );
  await pool.query(
    `INSERT INTO connector_capabilities (
       workspace_id, connector_registration_id, capability
     ) VALUES ($1, $2, 'caseSource')`,
    [workspace, connector],
  );
  await configuration({
    id: connector,
    resourceType: "connector-instances",
    versionId: connectorVersion,
    descriptor: {
      kind: "connector",
      type: "case-discovery-schedule-test",
      version: "v1",
    },
  });
  await pool.query(
    `INSERT INTO analysis_profiles (id, workspace_id, lifecycle)
     VALUES ($1, $2, 'active')`,
    [profile, workspace],
  );
  await pool.query(
    `INSERT INTO analysis_profile_versions (
       id, workspace_id, analysis_profile_id, version, definition_hash, definition
     ) VALUES ($1, $2, $3, 1, repeat('b', 64), '{}'::jsonb)`,
    [profileVersion, workspace, profile],
  );
  await configuration({
    id: trigger,
    resourceType: "case-analysis-triggers",
    versionId: triggerVersion,
  });
  await pool.query(
    `INSERT INTO analysis_triggers (
       id, workspace_id, lifecycle, revision, current_version_id
     ) VALUES ($1, $2, 'disabled', 1, NULL)`,
    [trigger, workspace],
  );
  await pool.query(
    `INSERT INTO analysis_trigger_versions (
       id, workspace_id, analysis_trigger_id, version, analysis_profile_version_id,
       connector_registration_id, connector_configuration_version_id
     ) VALUES ($1, $2, $3, 1, $4, $5, $6)`,
    [
      triggerVersion,
      workspace,
      trigger,
      profileVersion,
      connector,
      connectorVersion,
    ],
  );
  await pool.query(
    `UPDATE analysis_triggers
     SET lifecycle = 'active', current_version_id = $1
     WHERE workspace_id = $2 AND id = $3`,
    [triggerVersion, workspace, trigger],
  );
  await configuration({
    id: schedule,
    resourceType: "case-analysis-schedules",
    versionId: scheduleVersion,
  });
  await pool.query(
    `INSERT INTO case_analysis_intake_schedules (
       id, workspace_id, schedule_id, configuration_version_id,
       analysis_trigger_configuration_version_id, automated_principal_id,
       cadence, next_run_at, enabled
     ) VALUES ($1, $2, $3, $4, $5, $6,
       '{"kind":"interval","intervalMs":60000,"overlapPolicy":"skip"}'::jsonb,
       '2026-07-17T18:00:00.000Z', true)`,
    [scheduleVersion, workspace, schedule, scheduleVersion, triggerVersion, principal],
  );
}

beforeEach(async () => {
  await resetDatabase();
  await seed();
});

afterAll(async () => pool.end());

describe("PostgreSQL case-discovery schedules", () => {
  it("atomically creates one exact-pinned target-free discovery outbox occurrence", async () => {
    const scheduler = new CaseDiscoveryScheduler({
      store: new PostgresCaseDiscoveryScheduleStore(pool),
      clock: { now: () => now },
      leaseMs: 30_000,
    });

    await expect(scheduler.runOnce()).resolves.toEqual({
      due: 1,
      leased: 1,
      enqueued: 1,
      duplicate: 0,
    });
    await expect(
      pool.query(
        `SELECT type, payload FROM outbox_envelopes WHERE workspace_id = $1`,
        [workspace],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          type: "analysis.discover.v1",
          payload: {
            scheduleId: scheduleVersion,
            scheduleConfigurationVersionId: scheduleVersion,
            triggerId: trigger,
            triggerVersionId: triggerVersion,
            connectorRegistrationId: connector,
            connectorConfigurationVersionId: connectorVersion,
          },
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT actor_principal_id FROM audit_events
         WHERE workspace_id = $1 AND action = 'analysis.discovery.requested'`,
        [workspace],
      ),
    ).resolves.toMatchObject({ rows: [{ actor_principal_id: principal }] });
    await expect(
      pool.query(
        `SELECT cursor_version, cursor_value
         FROM case_analysis_intake_schedule_cursors WHERE workspace_id = $1`,
        [workspace],
      ),
    ).resolves.toMatchObject({ rows: [] });
  });
});
