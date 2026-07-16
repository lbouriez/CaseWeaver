import { readFile } from "node:fs/promises";

import {
  type Clock,
  type DurableMessageQueue,
  OutboxRelay,
} from "@caseweaver/application";
import { type Envelope, utcInstant } from "@caseweaver/domain";
import { KnowledgeScheduler } from "@caseweaver/scheduling";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createPostgresPersistence } from "../index.js";
import { PostgresKnowledgeScheduleStore } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("PostgreSQL integration tests require DATABASE_URL.");
}
if (!new URL(databaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error(
    "PostgreSQL integration DATABASE_URL must name a test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const workspace = "workspace-knowledge-schedule-outbox";
const source = "source-knowledge-schedule-outbox";
const schedule = "schedule-knowledge-schedule-outbox";
const sourceConfiguration = "source-configuration-knowledge-schedule-outbox";
const connectorConfiguration =
  "connector-configuration-knowledge-schedule-outbox";
const clock: Clock = {
  now: () => utcInstant("2026-01-01T00:00:01.000Z"),
};

class RecordingQueue implements DurableMessageQueue {
  public readonly published: Envelope[] = [];

  public async publish(envelope: Envelope): Promise<void> {
    this.published.push(envelope);
  }
}

async function resetDatabase(): Promise<void> {
  await pool.query(
    "TRUNCATE TABLE workspaces, ai_catalog_snapshots RESTART IDENTITY CASCADE",
  );
}

async function seedSchedule(): Promise<void> {
  await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [workspace]);
  await pool.query(
    `INSERT INTO ai_catalog_snapshots (
       id, upstream_url, upstream_commit_sha, fetched_at, sha256, raw_entries
     ) VALUES (
       'schedule-outbox-catalog', 'https://catalog.example/schedule-outbox',
       'schedule-outbox-commit', now(), repeat('a', 64), '{}'::jsonb
     )`,
  );
  await pool.query(
    `INSERT INTO ai_catalog_models (
       id, catalog_snapshot_id, canonical_model, provider, supported_roles,
       capabilities, raw_entry
     ) VALUES (
       'schedule-outbox-model', 'schedule-outbox-catalog', 'embedding-model',
       'test', '["embedding"]'::jsonb, '[]'::jsonb, '{}'::jsonb
     )`,
  );
  await pool.query(
    `INSERT INTO ai_provider_instances (id, workspace_id, provider_type, lifecycle)
     VALUES ('schedule-outbox-provider', $1, 'test', 'active')`,
    [workspace],
  );
  await pool.query(
    `INSERT INTO ai_provider_instance_versions (
       id, workspace_id, provider_instance_id, version, endpoint, wire_api,
       parameters, secret_reference
     ) VALUES (
       'schedule-outbox-provider-version', $1, 'schedule-outbox-provider', 1,
       'https://provider.example/schedule-outbox', 'embeddings', '{}'::jsonb,
       'vault:schedule-outbox'
     )`,
    [workspace],
  );
  await pool.query(
    `INSERT INTO ai_model_bindings (id, workspace_id, role, lifecycle)
     VALUES ('schedule-outbox-binding', $1, 'embedding', 'active')`,
    [workspace],
  );
  await pool.query(
    `INSERT INTO ai_model_binding_versions (
       id, workspace_id, model_binding_id, version, provider_instance_version_id,
       catalog_snapshot_id, catalog_model_id, canonical_model, wire_api,
       parameters, capabilities, secret_reference
     ) VALUES (
       'schedule-outbox-binding-version', $1, 'schedule-outbox-binding', 1,
       'schedule-outbox-provider-version', 'schedule-outbox-catalog',
       'schedule-outbox-model', 'embedding-model', 'embeddings', '{}'::jsonb,
       '[]'::jsonb, 'vault:schedule-outbox'
     )`,
    [workspace],
  );
  await pool.query(
    `INSERT INTO connector_registrations (id, workspace_id, lifecycle)
     VALUES ('schedule-outbox-connector', $1, 'active')`,
    [workspace],
  );
  await pool.query(
    `INSERT INTO connector_capabilities (
       workspace_id, connector_registration_id, capability
     ) VALUES ($1, 'schedule-outbox-connector', 'knowledgeSource')`,
    [workspace],
  );
  await pool.query(
    `INSERT INTO administration_descriptor_revisions (
       kind, type, version, descriptor, descriptor_hash
     ) VALUES (
       'connector', 'schedule-outbox-test-connector', 'v1', '{}'::jsonb,
       repeat('a', 64)
     ) ON CONFLICT (kind, type, version) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO administration_configurations (
       id, workspace_id, resource_type, lifecycle, current_version_id
     ) VALUES (
       'schedule-outbox-connector', $1, 'connector-instances', 'active', NULL
     )`,
    [workspace],
  );
  await pool.query(
    `INSERT INTO administration_configuration_versions (
       id, workspace_id, configuration_id, version, settings, secret_references,
       descriptor_kind, descriptor_type, descriptor_version
     ) VALUES (
       $1, $2, 'schedule-outbox-connector', 1, '{}'::jsonb, '[]'::jsonb,
       'connector', 'schedule-outbox-test-connector', 'v1'
     )`,
    [connectorConfiguration, workspace],
  );
  await pool.query(
    `UPDATE administration_configurations
     SET current_version_id = $1
     WHERE workspace_id = $2 AND id = 'schedule-outbox-connector'`,
    [connectorConfiguration, workspace],
  );
  await pool.query(
    `INSERT INTO knowledge_collections (
       id, workspace_id, embedding_binding_version_id, embedding_profile_version,
       dimensions
     ) VALUES (
       'schedule-outbox-collection', $1, 'schedule-outbox-binding-version',
       'embedding-profile-v1', 3
     )`,
    [workspace],
  );
  await pool.query(
    `INSERT INTO administration_configurations (
       id, workspace_id, resource_type, lifecycle, current_version_id
     ) VALUES ($1, $2, 'knowledge-sources', 'active', NULL)`,
    [source, workspace],
  );
  await pool.query(
    `INSERT INTO administration_configuration_versions (
       id, workspace_id, configuration_id, version, settings, secret_references
     ) VALUES ($1, $2, $3, 1, '{}'::jsonb, '[]'::jsonb)`,
    [sourceConfiguration, workspace, source],
  );
  await pool.query(
    `UPDATE administration_configurations
     SET current_version_id = $1
     WHERE workspace_id = $2 AND id = $3`,
    [sourceConfiguration, workspace, source],
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO knowledge_sources (
         id, workspace_id, connector_registration_id, knowledge_collection_id,
         lifecycle, configuration_version, connector_configuration_version_id,
         normalization_profile_version, chunking_profile_version,
         synchronization_policy, deletion_behavior
       ) VALUES (
         $1, $2, 'schedule-outbox-connector', 'schedule-outbox-collection',
         'enabled', $3, $4, 'normalization-v1', 'chunking-v1', '{}'::jsonb,
         'tombstone'
       )`,
      [source, workspace, sourceConfiguration, connectorConfiguration],
    );
    await client.query(
      `INSERT INTO knowledge_source_runtime_versions (
         workspace_id, knowledge_source_id, source_configuration_version_id,
         connector_registration_id, connector_configuration_version_id
       ) VALUES ($1, $2, $3, 'schedule-outbox-connector', $4)`,
      [workspace, source, sourceConfiguration, connectorConfiguration],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await pool.query(
    `INSERT INTO knowledge_schedules (
       id, workspace_id, knowledge_source_id, schedule_kind, configuration_version,
       connector_configuration_version_id, trigger_kind, interval_ms,
       overlap_policy, enabled, next_run_at
     ) VALUES (
       $1, $2, $3, 'synchronize', $4, $5, 'interval', 60000, 'queue', TRUE,
       '2026-01-01T00:00:00.000Z'
     )`,
    [schedule, workspace, source, sourceConfiguration, connectorConfiguration],
  );
}

async function relayOnce(): Promise<
  Readonly<{
    readonly queue: RecordingQueue;
    readonly result: { readonly delivered: number };
  }>
> {
  const persistence = createPostgresPersistence({ databaseUrl });
  const queue = new RecordingQueue();
  try {
    const result = await new OutboxRelay(
      persistence.unitOfWork,
      persistence.outboxStore,
      queue,
      clock,
    ).runOnce();
    return Object.freeze({ queue, result });
  } finally {
    await persistence.close();
  }
}

beforeEach(async () => {
  await resetDatabase();
  await seedSchedule();
});

afterAll(async () => {
  await pool.end();
});

describe("PostgreSQL knowledge schedule durable outbox", () => {
  it("persists a valid common envelope and relays it exactly once", async () => {
    const scheduler = new KnowledgeScheduler({
      store: new PostgresKnowledgeScheduleStore(pool),
      clock,
      leaseMs: 30_000,
    });

    await expect(scheduler.runOnce()).resolves.toEqual({
      due: 1,
      leased: 1,
      enqueued: 1,
      duplicate: 0,
    });

    const persisted = await pool.query<{
      readonly id: string;
      readonly kind: string;
      readonly type: string;
      readonly payload: Readonly<Record<string, string>>;
    }>(
      `SELECT id, kind, type, payload
       FROM outbox_envelopes
       WHERE workspace_id = $1`,
      [workspace],
    );
    expect(persisted.rows).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
        kind: "command",
        type: "knowledge.synchronize.v2",
        payload: {
          sourceId: source,
          sourceConfigurationVersionId: sourceConfiguration,
          connectorConfigurationVersionId: connectorConfiguration,
          trigger: "schedule",
        },
      }),
    ]);
    await expect(
      pool.query("SELECT 1 FROM knowledge_schedule_commands"),
    ).resolves.toMatchObject({ rows: [] });

    const first = await relayOnce();
    const second = await relayOnce();
    expect(first.result).toEqual({ delivered: 1 });
    expect(second.result).toEqual({ delivered: 0 });
    expect(first.queue.published).toEqual([
      expect.objectContaining({
        id: persisted.rows[0]?.id,
        type: "knowledge.synchronize.v2",
        payload: {
          sourceId: source,
          sourceConfigurationVersionId: sourceConfiguration,
          connectorConfigurationVersionId: connectorConfiguration,
          trigger: "schedule",
        },
      }),
    ]);
    expect(second.queue.published).toEqual([]);
  });

  it("backfills only pending legacy schedule commands into relay-valid envelopes", async () => {
    await pool.query(
      `INSERT INTO knowledge_schedule_occurrences (
         id, workspace_id, knowledge_schedule_id, occurrence_key, scheduled_for,
         source_configuration_version_id, connector_configuration_version_id
       ) VALUES (
         'legacy-schedule-occurrence', $1, $2, repeat('a', 64),
         '2026-01-01T00:00:00.000Z', $3, $4
       )`,
      [workspace, schedule, sourceConfiguration, connectorConfiguration],
    );
    await pool.query(
      `INSERT INTO knowledge_schedule_commands (
         id, workspace_id, knowledge_schedule_occurrence_id, command_type,
         idempotency_key, payload
       ) VALUES (
         'legacy-schedule-command', $1, 'legacy-schedule-occurrence',
         'knowledge.full-rescan.v1', repeat('b', 64),
         jsonb_build_object(
           'sourceId', $2::text,
           'configurationVersion', $3::text,
           'trigger', 'schedule',
           'occurrenceKey', repeat('a', 64)
         )
       )`,
      [workspace, source, sourceConfiguration],
    );
    await pool.query(
      `INSERT INTO knowledge_schedule_occurrences (
         id, workspace_id, knowledge_schedule_id, occurrence_key, scheduled_for,
         source_configuration_version_id, connector_configuration_version_id
       ) VALUES (
         'delivered-legacy-schedule-occurrence', $1, $2, repeat('c', 64),
         '2026-01-01T00:00:00.000Z', $3, $4
       )`,
      [workspace, schedule, sourceConfiguration, connectorConfiguration],
    );
    await pool.query(
      `INSERT INTO knowledge_schedule_commands (
         id, workspace_id, knowledge_schedule_occurrence_id, command_type,
         idempotency_key, payload, delivered_at
       ) VALUES (
         'delivered-legacy-schedule-command', $1,
         'delivered-legacy-schedule-occurrence', 'knowledge.synchronize.v1',
         repeat('d', 64),
         jsonb_build_object(
           'sourceId', $2::text,
           'configurationVersion', $3::text,
           'trigger', 'schedule'
         ),
         now()
       )`,
      [workspace, source, sourceConfiguration],
    );
    const migration = await readFile(
      new URL(
        "../../prisma/migrations/20260715123000_pbi_013_knowledge_schedule_outbox/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );

    await pool.query(migration);

    const first = await relayOnce();
    const second = await relayOnce();
    expect(first.result).toEqual({ delivered: 1 });
    expect(second.result).toEqual({ delivered: 0 });
    expect(first.queue.published).toEqual([
      expect.objectContaining({
        type: "knowledge.full-rescan.v1",
        payload: {
          sourceId: source,
          configurationVersion: sourceConfiguration,
          trigger: "schedule",
          legacy: true,
        },
      }),
    ]);
    await expect(
      pool.query(
        `SELECT type
         FROM outbox_envelopes
         WHERE workspace_id = $1
           AND payload ->> 'sourceId' = $2`,
        [workspace, source],
      ),
    ).resolves.toMatchObject({
      rows: [{ type: "knowledge.full-rescan.v1" }],
    });
  });
});
