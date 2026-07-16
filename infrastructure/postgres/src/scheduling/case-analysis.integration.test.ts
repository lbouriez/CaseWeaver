import { CaseAnalysisScheduler } from "@caseweaver/scheduling";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresCaseAnalysisScheduleStore } from "./case-analysis.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error(
    "PostgreSQL integration tests require DATABASE_URL for a disposable test database.",
  );
}
if (!new URL(databaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error(
    "PostgreSQL integration DATABASE_URL must name a test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const workspace = "workspace-case-analysis-schedule";
const principal = "principal-case-analysis-schedule";
const connector = "connector-case-analysis-schedule";
const connectorVersion = "connector-version-case-analysis-schedule";
const profile = "analysis-profile-case-analysis-schedule";
const profileVersion = "analysis-profile-version-case-analysis-schedule";
const trigger = "analysis-trigger-case-analysis-schedule";
const triggerVersion = "analysis-trigger-version-case-analysis-schedule";
const schedule = "case-analysis-schedule-1";
const now = "2026-07-15T12:00:01.000Z";

async function resetDatabase(): Promise<void> {
  await pool.query("TRUNCATE TABLE workspaces RESTART IDENTITY CASCADE");
}

async function seed(): Promise<void> {
  await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [workspace]);
  await pool.query(
    "INSERT INTO principals (id, workspace_id) VALUES ($1, $2)",
    [principal, workspace],
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
  await pool.query(
    `INSERT INTO administration_descriptor_revisions (
       kind, type, version, descriptor, descriptor_hash
     ) VALUES (
       'connector', 'case-analysis-schedule-test', 'v1',
       '{"connectorCapabilities":["caseSource"]}'::jsonb, repeat('a', 64)
     ) ON CONFLICT (kind, type, version) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO administration_configurations (
       id, workspace_id, resource_type, lifecycle, current_version_id
     ) VALUES ($1, $2, 'connector-instances', 'active', NULL)`,
    [connector, workspace],
  );
  await pool.query(
    `INSERT INTO administration_configuration_versions (
       id, workspace_id, configuration_id, version, settings, secret_references,
       descriptor_kind, descriptor_type, descriptor_version
     ) VALUES (
       $1, $2, $3, 1, '{}'::jsonb, '[]'::jsonb,
       'connector', 'case-analysis-schedule-test', 'v1'
     )`,
    [connectorVersion, workspace, connector],
  );
  await pool.query(
    `UPDATE administration_configurations
     SET current_version_id = $1
     WHERE workspace_id = $2 AND id = $3`,
    [connectorVersion, workspace, connector],
  );
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
  await pool.query(
    `INSERT INTO analysis_triggers (id, workspace_id, lifecycle)
     VALUES ($1, $2, 'disabled')`,
    [trigger, workspace],
  );
  await pool.query(
    `INSERT INTO analysis_trigger_versions (
       id, workspace_id, analysis_trigger_id, version,
       analysis_profile_version_id, connector_registration_id,
       connector_configuration_version_id
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
  await pool.query(
    `INSERT INTO case_analysis_schedules (
       id, workspace_id, trigger_id, configuration_version,
       analysis_trigger_version_id, target_connector_instance_id,
       target_resource_type, target_external_id, automated_principal_id,
       trigger_kind, interval_ms, next_run_at
     ) VALUES (
       $1, $2, $3, 'legacy-marker', $4, $5, 'case', 'case-1', $6,
       'interval', 60000, '2026-07-15T12:00:00.000Z'
     )`,
    [schedule, workspace, trigger, triggerVersion, connector, principal],
  );
  await pool.query(
    `INSERT INTO case_analysis_schedules (
       id, workspace_id, trigger_id, configuration_version,
       trigger_kind, interval_ms, next_run_at
     ) VALUES (
       'legacy-case-analysis-schedule', $1, $2, 'legacy-only',
       'interval', 60000, '2026-07-15T12:00:00.000Z'
     )`,
    [workspace, trigger],
  );
}

beforeEach(async () => {
  await resetDatabase();
  await seed();
});

afterAll(async () => {
  await pool.end();
});

describe("PostgreSQL versioned case-analysis schedules", () => {
  it("retains exact trigger/target/actor pins and atomically emits one v2 request", async () => {
    const store = new PostgresCaseAnalysisScheduleStore(pool);
    const scheduler = new CaseAnalysisScheduler({
      store,
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
      pool.query<{
        readonly type: string;
        readonly payload: {
          readonly triggerVersionId: string;
          readonly connectorConfigurationVersionId: string;
          readonly source: string;
          readonly target: { readonly externalId: string };
        };
        readonly actor_principal_id: string;
        readonly analysis_trigger_version_id: string;
        readonly connector_configuration_version_id: string;
      }>(
        `SELECT
           outbox.type, outbox.payload,
           request.actor_principal_id, request.analysis_trigger_version_id,
           request.connector_configuration_version_id
         FROM outbox_envelopes AS outbox
         JOIN analysis_trigger_requests AS request
           ON request.workspace_id = outbox.workspace_id
          AND request.id = outbox.payload->>'triggerRequestId'
         WHERE outbox.workspace_id = $1`,
        [workspace],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          type: "analysis.trigger.v2",
          payload: {
            triggerVersionId: triggerVersion,
            connectorConfigurationVersionId: connectorVersion,
            source: "schedule",
            target: { externalId: "case-1" },
          },
          actor_principal_id: principal,
          analysis_trigger_version_id: triggerVersion,
          connector_configuration_version_id: connectorVersion,
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT actor_principal_id
         FROM audit_events
         WHERE workspace_id = $1 AND action = 'analysis.trigger.requested'`,
        [workspace],
      ),
    ).resolves.toMatchObject({ rows: [{ actor_principal_id: principal }] });
    await expect(
      pool.query(
        `SELECT id
         FROM outbox_envelopes
         WHERE workspace_id = $1 AND type = 'analysis.trigger.v1'`,
        [workspace],
      ),
    ).resolves.toMatchObject({ rows: [] });
  });
});
