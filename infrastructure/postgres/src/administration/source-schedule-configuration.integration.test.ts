import { randomUUID } from "node:crypto";
import {
  AdministrationConflictError,
  type AdministrationTransactionRunner,
  type ConfigurationLifecycleAudit,
  ManageKnowledgeScheduleConfiguration,
  ManageKnowledgeSourceConfiguration,
} from "@caseweaver/administration";
import type {
  ApplicationTransaction,
  AuditStore,
} from "@caseweaver/application";
import {
  auditEventId,
  principalId,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPostgresPersistence,
  type PostgresTransactionLookup,
} from "../index.js";
import { PostgresSourceScheduleConfigurationStore } from "./source-schedule-configuration-store.js";

const databaseUrl = process.env.DATABASE_URL;
if (
  databaseUrl === undefined ||
  !new URL(databaseUrl).pathname.toLowerCase().includes("test")
) {
  throw new Error(
    "PostgreSQL source/schedule configuration tests require a disposable test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const transactions: AdministrationTransactionRunner = {
  transaction: async <T>(operation: () => Promise<T>): Promise<T> =>
    operation(),
};

beforeEach(async () => {
  await pool.query(
    "TRUNCATE TABLE workspaces, ai_catalog_snapshots RESTART IDENTITY CASCADE",
  );
  await seedWorkspace("workspace-a", "a", true);
  await seedWorkspace("workspace-b", "b", false);
});

afterAll(async () => {
  await pool.end();
});

describe("PostgreSQL source and schedule administration projections", () => {
  it("commits immutable source/schedule versions, projections, cache notices, and audits atomically", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      const sourceResult = await persistence.unitOfWork.transaction(
        async (transaction) => {
          const manager = new ManageKnowledgeSourceConfiguration(
            transactions,
            store(persistence, transaction),
            audit(
              persistence.auditStore,
              transaction,
              "workspace-a",
              "principal-a",
            ),
          );
          return manager.create({
            workspaceId: "workspace-a",
            displayName: "Documentation",
            settings: { filters: { include: ["docs/**"] }, schemaVersion: 1 },
            source: sourceProjection(),
            mutation: mutation("knowledgeSource.create", "a"),
          });
        },
      );
      expect(sourceResult).toMatchObject({
        idempotency: "created",
        configuration: { lifecycle: "draft", revision: 1 },
      });
      const activatedSource = await persistence.unitOfWork.transaction(
        async (transaction) =>
          new ManageKnowledgeSourceConfiguration(
            transactions,
            store(persistence, transaction),
            audit(
              persistence.auditStore,
              transaction,
              "workspace-a",
              "principal-a",
            ),
          ).transition({
            workspaceId: "workspace-a",
            settings: { filters: { include: ["docs/**"] }, schemaVersion: 1 },
            source: sourceProjection(),
            expectedRevision: 1,
            lifecycle: "active",
            mutation: mutation("knowledgeSource.activate", "b"),
          }),
      );
      const sourceVersion = activatedSource.version.id;

      const scheduleDraft = await persistence.unitOfWork.transaction(
        async (transaction) =>
          new ManageKnowledgeScheduleConfiguration(
            transactions,
            store(persistence, transaction),
            audit(
              persistence.auditStore,
              transaction,
              "workspace-a",
              "principal-a",
            ),
          ).create({
            workspaceId: "workspace-a",
            displayName: "Documentation sync",
            settings: { cadence: "interval", intervalMs: 60_000 },
            schedule: scheduleProjection(sourceVersion),
            mutation: mutation("knowledgeSchedule.create", "c"),
          }),
      );
      const activatedSchedule = await persistence.unitOfWork.transaction(
        async (transaction) =>
          new ManageKnowledgeScheduleConfiguration(
            transactions,
            store(persistence, transaction),
            audit(
              persistence.auditStore,
              transaction,
              "workspace-a",
              "principal-a",
            ),
          ).transition({
            workspaceId: "workspace-a",
            settings: { cadence: "interval", intervalMs: 60_000 },
            schedule: scheduleProjection(sourceVersion),
            expectedRevision: scheduleDraft.configuration.revision,
            lifecycle: "active",
            mutation: mutation("knowledgeSchedule.activate", "d"),
          }),
      );

      const source = await pool.query<{
        readonly lifecycle: string;
        readonly configuration_version: string;
        readonly connector_registration_id: string;
        readonly knowledge_collection_id: string;
      }>(
        `SELECT lifecycle, configuration_version, connector_registration_id,
                knowledge_collection_id
         FROM knowledge_sources
         WHERE workspace_id = 'workspace-a' AND id = 'source-a'`,
      );
      expect(source.rows).toEqual([
        {
          lifecycle: "enabled",
          configuration_version: sourceVersion,
          connector_registration_id: "connector-a",
          knowledge_collection_id: "collection-a",
        },
      ]);
      const schedule = await pool.query<{
        readonly enabled: boolean;
        readonly configuration_version: string;
        readonly administration_configuration_version_id: string;
        readonly trigger_kind: string;
        readonly interval_ms: string;
      }>(
        `SELECT enabled, configuration_version,
                administration_configuration_version_id, trigger_kind, interval_ms
         FROM knowledge_schedules
         WHERE workspace_id = 'workspace-a' AND id = 'schedule-a'`,
      );
      expect(schedule.rows).toEqual([
        {
          enabled: true,
          configuration_version: sourceVersion,
          administration_configuration_version_id: activatedSchedule.version.id,
          trigger_kind: "interval",
          interval_ms: "60000",
        },
      ]);
      const changes = await pool.query<{ readonly count: string }>(
        "SELECT count(*)::text FROM administration_configuration_change_outbox WHERE workspace_id = 'workspace-a'",
      );
      expect(changes.rows[0]?.count).toBe("4");
      const audits = await pool.query<{
        readonly action: string;
        readonly target_id: string;
        readonly outcome: string;
      }>(
        `SELECT action, target_id, outcome FROM audit_events
         WHERE workspace_id = 'workspace-a' ORDER BY action`,
      );
      expect(audits.rows).toEqual([
        {
          action: "admin.knowledgeSchedule.configuration.changed",
          target_id: "schedule-a",
          outcome: "succeeded",
        },
        {
          action: "admin.knowledgeSchedule.draft.created",
          target_id: "schedule-a",
          outcome: "succeeded",
        },
        {
          action: "admin.knowledgeSource.configuration.changed",
          target_id: "source-a",
          outcome: "succeeded",
        },
        {
          action: "admin.knowledgeSource.draft.created",
          target_id: "source-a",
          outcome: "succeeded",
        },
      ]);
    } finally {
      await persistence.close();
    }
  });

  it("rejects an inactive or incapable connector without retaining a configuration or audit", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      await expect(
        persistence.unitOfWork.transaction((transaction) =>
          new ManageKnowledgeSourceConfiguration(
            transactions,
            store(persistence, transaction),
            audit(
              persistence.auditStore,
              transaction,
              "workspace-b",
              "principal-b",
            ),
          ).create({
            workspaceId: "workspace-b",
            displayName: "Rejected source",
            settings: { schemaVersion: 1 },
            source: {
              ...sourceProjection(),
              sourceId: "source-b",
              connectorRegistrationId: "connector-b",
              knowledgeCollectionId: "collection-b",
            },
            mutation: mutation("knowledgeSource.create", "e"),
          }),
        ),
      ).rejects.toThrow(/connector/i);
      await expect(
        pool.query(
          "SELECT id FROM administration_configurations WHERE workspace_id = 'workspace-b'",
        ),
      ).resolves.toMatchObject({ rows: [] });
      await expect(
        pool.query(
          "SELECT id FROM audit_events WHERE workspace_id = 'workspace-b'",
        ),
      ).resolves.toMatchObject({ rows: [] });
    } finally {
      await persistence.close();
    }
  });

  it("rejects a cross-workspace collection before creating a source projection", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      await expect(
        persistence.unitOfWork.transaction((transaction) =>
          new ManageKnowledgeSourceConfiguration(
            transactions,
            store(persistence, transaction),
            audit(
              persistence.auditStore,
              transaction,
              "workspace-a",
              "principal-a",
            ),
          ).create({
            workspaceId: "workspace-a",
            displayName: "Cross-workspace collection",
            settings: { schemaVersion: 1 },
            source: {
              ...sourceProjection(),
              sourceId: "source-cross-workspace",
              knowledgeCollectionId: "collection-b",
            },
            mutation: mutation("knowledgeSource.create", "f"),
          }),
        ),
      ).rejects.toThrow(/collection/i);
      const retained = await pool.query<{ readonly count: string }>(
        `SELECT count(*)::text FROM administration_configuration_versions
         WHERE workspace_id = 'workspace-a'
           AND configuration_id = 'source-cross-workspace'`,
      );
      expect(retained.rows[0]?.count).toBe("0");
    } finally {
      await persistence.close();
    }
  });

  it("does not rewrite a source projection when its immutable revision is stale", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      const draft = await persistence.unitOfWork.transaction((transaction) =>
        new ManageKnowledgeSourceConfiguration(
          transactions,
          store(persistence, transaction),
          audit(
            persistence.auditStore,
            transaction,
            "workspace-a",
            "principal-a",
          ),
        ).create({
          workspaceId: "workspace-a",
          displayName: "Versioned source",
          settings: { schemaVersion: 1 },
          source: sourceProjection(),
          mutation: mutation("knowledgeSource.create", "g"),
        }),
      );
      const activated = await persistence.unitOfWork.transaction(
        (transaction) =>
          new ManageKnowledgeSourceConfiguration(
            transactions,
            store(persistence, transaction),
            audit(
              persistence.auditStore,
              transaction,
              "workspace-a",
              "principal-a",
            ),
          ).transition({
            workspaceId: "workspace-a",
            settings: { schemaVersion: 1, revised: true },
            source: sourceProjection(),
            expectedRevision: draft.configuration.revision,
            lifecycle: "active",
            mutation: mutation("knowledgeSource.activate", "h"),
          }),
      );
      await expect(
        persistence.unitOfWork.transaction((transaction) =>
          new ManageKnowledgeSourceConfiguration(
            transactions,
            store(persistence, transaction),
            audit(
              persistence.auditStore,
              transaction,
              "workspace-a",
              "principal-a",
            ),
          ).transition({
            workspaceId: "workspace-a",
            settings: { schemaVersion: 1, revised: "stale" },
            source: sourceProjection(),
            expectedRevision: draft.configuration.revision,
            lifecycle: "disabled",
            mutation: mutation("knowledgeSource.disable", "i"),
          }),
        ),
      ).rejects.toBeInstanceOf(AdministrationConflictError);
      const source = await pool.query<{
        readonly lifecycle: string;
        readonly configuration_version: string;
      }>(
        `SELECT lifecycle, configuration_version FROM knowledge_sources
         WHERE workspace_id = 'workspace-a' AND id = 'source-a'`,
      );
      expect(source.rows).toEqual([
        {
          lifecycle: "enabled",
          configuration_version: activated.version.id,
        },
      ]);
    } finally {
      await persistence.close();
    }
  });

  it("fails closed and rolls back the source projection when its required audit cannot persist", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      await expect(
        persistence.unitOfWork.transaction((transaction) =>
          new ManageKnowledgeSourceConfiguration(
            transactions,
            store(persistence, transaction),
            {
              append: async () =>
                Promise.reject(new Error("audit unavailable")),
            },
          ).create({
            workspaceId: "workspace-a",
            displayName: "Audit failure source",
            settings: { schemaVersion: 1 },
            source: {
              ...sourceProjection(),
              sourceId: "source-audit-failure",
            },
            mutation: mutation("knowledgeSource.create", "j"),
          }),
        ),
      ).rejects.toThrow(/audit unavailable/i);
      await expect(
        pool.query(
          `SELECT id FROM knowledge_sources
           WHERE workspace_id = 'workspace-a' AND id = 'source-audit-failure'`,
        ),
      ).resolves.toMatchObject({ rows: [] });
      await expect(
        pool.query(
          `SELECT id FROM administration_configurations
           WHERE workspace_id = 'workspace-a' AND id = 'source-audit-failure'`,
        ),
      ).resolves.toMatchObject({ rows: [] });
    } finally {
      await persistence.close();
    }
  });

  it("rejects direct writes that would leave an enabled schedule on a disabled source", async () => {
    const provisioned = await provisionSourceAndSchedule({
      scheduleLifecycle: "active",
    });
    try {
      const before = await lifecycleCounts();

      await expect(
        pool.query(
          `UPDATE knowledge_sources
           SET lifecycle = 'disabled'
           WHERE workspace_id = 'workspace-a' AND id = 'source-a'`,
        ),
      ).rejects.toThrow(/enabled schedules/i);

      await pool.query(
        `UPDATE knowledge_schedules
         SET enabled = FALSE
         WHERE workspace_id = 'workspace-a' AND id = 'schedule-a'`,
      );
      await pool.query(
        `UPDATE knowledge_sources
         SET lifecycle = 'disabled'
         WHERE workspace_id = 'workspace-a' AND id = 'source-a'`,
      );

      await expect(
        pool.query(
          `UPDATE knowledge_schedules
           SET enabled = TRUE
           WHERE workspace_id = 'workspace-a' AND id = 'schedule-a'`,
        ),
      ).rejects.toThrow(/requires an enabled source/i);

      await expect(lifecycleRows()).resolves.toEqual({
        sourceLifecycle: "disabled",
        scheduleEnabled: false,
      });
      await expect(lifecycleCounts()).resolves.toEqual(before);
    } finally {
      await provisioned.persistence.close();
    }
  });

  it("serializes opposing direct lifecycle writes so an enabled schedule cannot race a source disable", async () => {
    const provisioned = await provisionSourceAndSchedule({
      scheduleLifecycle: "draft",
    });
    const sourceConnection = await pool.connect();
    const scheduleConnection = await pool.connect();
    try {
      await Promise.all([
        sourceConnection.query("BEGIN"),
        scheduleConnection.query("BEGIN"),
      ]);
      await Promise.all([
        sourceConnection.query("SET LOCAL statement_timeout = '5s'"),
        scheduleConnection.query("SET LOCAL statement_timeout = '5s'"),
      ]);

      await sourceConnection.query(
        `UPDATE knowledge_sources
         SET lifecycle = 'disabled'
         WHERE workspace_id = 'workspace-a' AND id = 'source-a'`,
      );
      const enableSchedule = scheduleConnection.query(
        `UPDATE knowledge_schedules
         SET enabled = TRUE
         WHERE workspace_id = 'workspace-a' AND id = 'schedule-a'`,
      );

      // A correct guard can make the schedule transaction wait for this commit.
      // Yielding first also makes the regression deterministic against unguarded
      // read-committed trigger implementations.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await sourceConnection.query("COMMIT");

      await expect(enableSchedule).rejects.toThrow(
        /requires an enabled source/i,
      );
      await scheduleConnection.query("ROLLBACK");
      await expect(lifecycleRows()).resolves.toEqual({
        sourceLifecycle: "disabled",
        scheduleEnabled: false,
      });
    } finally {
      await sourceConnection.query("ROLLBACK").catch(() => undefined);
      await scheduleConnection.query("ROLLBACK").catch(() => undefined);
      sourceConnection.release();
      scheduleConnection.release();
      await provisioned.persistence.close();
    }
  });

  it("rolls back a rejected source disable, including its successor version, mutation, outbox, and audit", async () => {
    const provisioned = await provisionSourceAndSchedule({
      scheduleLifecycle: "active",
    });
    try {
      const before = await lifecycleCounts();
      await expect(
        provisioned.persistence.unitOfWork.transaction((transaction) =>
          new ManageKnowledgeSourceConfiguration(
            transactions,
            store(provisioned.persistence, transaction),
            audit(
              provisioned.persistence.auditStore,
              transaction,
              "workspace-a",
              "principal-a",
            ),
          ).transition({
            workspaceId: "workspace-a",
            settings: { filters: { include: ["docs/**"] }, schemaVersion: 1 },
            source: sourceProjection(),
            expectedRevision: provisioned.sourceRevision,
            lifecycle: "disabled",
            mutation: mutation("knowledgeSource.disable", "rollback"),
          }),
        ),
      ).rejects.toThrow(/enabled schedules/i);

      await expect(lifecycleRows()).resolves.toEqual({
        sourceLifecycle: "enabled",
        scheduleEnabled: true,
      });
      await expect(lifecycleCounts()).resolves.toEqual(before);
    } finally {
      await provisioned.persistence.close();
    }
  });
});

async function provisionSourceAndSchedule(
  input: Readonly<{
    readonly scheduleLifecycle: "draft" | "active";
  }>,
): Promise<{
  readonly persistence: ReturnType<typeof createPostgresPersistence>;
  readonly sourceRevision: number;
}> {
  const persistence = createPostgresPersistence({ databaseUrl });
  try {
    const sourceDraft = await persistence.unitOfWork.transaction(
      (transaction) =>
        new ManageKnowledgeSourceConfiguration(
          transactions,
          store(persistence, transaction),
          audit(
            persistence.auditStore,
            transaction,
            "workspace-a",
            "principal-a",
          ),
        ).create({
          workspaceId: "workspace-a",
          displayName: "Documentation",
          settings: { filters: { include: ["docs/**"] }, schemaVersion: 1 },
          source: sourceProjection(),
          mutation: mutation("knowledgeSource.create", "provision-source"),
        }),
    );
    const sourceActive = await persistence.unitOfWork.transaction(
      (transaction) =>
        new ManageKnowledgeSourceConfiguration(
          transactions,
          store(persistence, transaction),
          audit(
            persistence.auditStore,
            transaction,
            "workspace-a",
            "principal-a",
          ),
        ).transition({
          workspaceId: "workspace-a",
          settings: { filters: { include: ["docs/**"] }, schemaVersion: 1 },
          source: sourceProjection(),
          expectedRevision: sourceDraft.configuration.revision,
          lifecycle: "active",
          mutation: mutation("knowledgeSource.activate", "provision-source"),
        }),
    );
    const scheduleDraft = await persistence.unitOfWork.transaction(
      (transaction) =>
        new ManageKnowledgeScheduleConfiguration(
          transactions,
          store(persistence, transaction),
          audit(
            persistence.auditStore,
            transaction,
            "workspace-a",
            "principal-a",
          ),
        ).create({
          workspaceId: "workspace-a",
          displayName: "Documentation sync",
          settings: { cadence: "interval", intervalMs: 60_000 },
          schedule: scheduleProjection(sourceActive.version.id),
          mutation: mutation("knowledgeSchedule.create", "provision-schedule"),
        }),
    );
    if (input.scheduleLifecycle === "active") {
      await persistence.unitOfWork.transaction((transaction) =>
        new ManageKnowledgeScheduleConfiguration(
          transactions,
          store(persistence, transaction),
          audit(
            persistence.auditStore,
            transaction,
            "workspace-a",
            "principal-a",
          ),
        ).transition({
          workspaceId: "workspace-a",
          settings: { cadence: "interval", intervalMs: 60_000 },
          schedule: scheduleProjection(sourceActive.version.id),
          expectedRevision: scheduleDraft.configuration.revision,
          lifecycle: "active",
          mutation: mutation(
            "knowledgeSchedule.activate",
            "provision-schedule",
          ),
        }),
      );
    }
    return Object.freeze({
      persistence,
      sourceRevision: sourceActive.configuration.revision,
    });
  } catch (error) {
    await persistence.close();
    throw error;
  }
}

async function lifecycleRows(): Promise<{
  readonly sourceLifecycle: string;
  readonly scheduleEnabled: boolean;
}> {
  const [source, schedule] = await Promise.all([
    pool.query<{ readonly lifecycle: string }>(
      `SELECT lifecycle FROM knowledge_sources
       WHERE workspace_id = 'workspace-a' AND id = 'source-a'`,
    ),
    pool.query<{ readonly enabled: boolean }>(
      `SELECT enabled FROM knowledge_schedules
       WHERE workspace_id = 'workspace-a' AND id = 'schedule-a'`,
    ),
  ]);
  return Object.freeze({
    sourceLifecycle: source.rows[0]?.lifecycle ?? "missing",
    scheduleEnabled: schedule.rows[0]?.enabled ?? false,
  });
}

async function lifecycleCounts(): Promise<{
  readonly audits: string;
  readonly mutations: string;
  readonly outbox: string;
  readonly versions: string;
}> {
  const counts = await pool.query<{
    readonly audits: string;
    readonly mutations: string;
    readonly outbox: string;
    readonly versions: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM audit_events WHERE workspace_id = 'workspace-a') AS audits,
       (SELECT count(*)::text FROM idempotency_records WHERE workspace_id = 'workspace-a') AS mutations,
       (SELECT count(*)::text FROM administration_configuration_change_outbox WHERE workspace_id = 'workspace-a') AS outbox,
       (SELECT count(*)::text FROM administration_configuration_versions WHERE workspace_id = 'workspace-a') AS versions`,
  );
  const first = counts.rows[0];
  if (first === undefined)
    throw new Error("Lifecycle count query returned no row.");
  return first;
}

function store(
  persistence: ReturnType<typeof createPostgresPersistence>,
  transaction: ApplicationTransaction,
): PostgresSourceScheduleConfigurationStore {
  return new PostgresSourceScheduleConfigurationStore(
    persistence.unitOfWork as PostgresTransactionLookup,
    transaction,
  );
}

function audit(
  auditStore: AuditStore,
  transaction: ApplicationTransaction,
  workspace: string,
  principal: string,
): ConfigurationLifecycleAudit {
  return {
    append: async (input) => {
      await auditStore.append(transaction, {
        id: auditEventId(randomUUID()),
        workspaceId: workspaceId(workspace),
        actorPrincipalId: principalId(principal),
        action: input.action,
        targetId: input.targetId,
        targetType: input.targetType,
        permission: input.permission,
        outcome: input.outcome,
        ...(input.beforeHash === undefined
          ? {}
          : { beforeHash: input.beforeHash }),
        afterHash: input.afterHash,
        origin: "admin_ui",
        occurredAt: utcInstant("2026-07-15T12:00:00.000Z"),
      });
    },
  };
}

function sourceProjection() {
  return {
    sourceId: "source-a",
    connectorRegistrationId: "connector-a",
    knowledgeCollectionId: "collection-a",
    normalizationProfileVersion: "normalization-v1",
    chunkingProfileVersion: "chunking-v1",
    synchronizationPolicy: { triggers: [{ mode: "manual" }] },
    deletionBehavior: "tombstone" as const,
  };
}

function scheduleProjection(sourceConfigurationVersionId: string) {
  return {
    scheduleId: "schedule-a",
    sourceId: "source-a",
    sourceConfigurationVersionId,
    kind: "synchronize" as const,
    cadence: {
      kind: "interval" as const,
      intervalMs: 60_000,
      jitterMs: 1_000,
      overlapPolicy: "skip" as const,
    },
    nextRunAt: "2026-07-15T12:00:00.000Z",
  };
}

function mutation(operation: string, suffix: string) {
  return {
    operation,
    keyDigest: `key-${suffix}`,
    requestDigest: `request-${suffix}`,
  };
}

async function seedWorkspace(
  workspace: string,
  suffix: string,
  knowledgeCapability: boolean,
): Promise<void> {
  const catalog = `catalog-${suffix}`;
  const model = `model-${suffix}`;
  const provider = `provider-${suffix}`;
  const providerVersion = `provider-version-${suffix}`;
  const binding = `binding-${suffix}`;
  const bindingVersion = `binding-version-${suffix}`;
  await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [workspace]);
  await pool.query(
    "INSERT INTO principals (id, workspace_id) VALUES ($1, $2)",
    [`principal-${suffix}`, workspace],
  );
  await pool.query(
    `INSERT INTO ai_catalog_snapshots (id, upstream_url, upstream_commit_sha, fetched_at, sha256, raw_entries)
     VALUES ($1, $2, $3, now(), repeat('a', 64), '{}'::jsonb)`,
    [catalog, `https://catalog.example/${suffix}.json`, `commit-${suffix}`],
  );
  await pool.query(
    `INSERT INTO ai_catalog_models (id, catalog_snapshot_id, canonical_model, provider, supported_roles, capabilities, raw_entry)
     VALUES ($1, $2, 'embedding', 'test', '["embedding"]'::jsonb, '[]'::jsonb, '{}'::jsonb)`,
    [model, catalog],
  );
  await pool.query(
    `INSERT INTO ai_provider_instances (id, workspace_id, provider_type, lifecycle)
     VALUES ($1, $2, 'test', 'active')`,
    [provider, workspace],
  );
  await pool.query(
    `INSERT INTO ai_provider_instance_versions (id, workspace_id, provider_instance_id, version, endpoint, wire_api, parameters, secret_reference)
     VALUES ($1, $2, $3, 1, 'https://provider.example', 'embeddings', '{}'::jsonb, 'vault:test')`,
    [providerVersion, workspace, provider],
  );
  await pool.query(
    `INSERT INTO ai_model_bindings (id, workspace_id, role, lifecycle)
     VALUES ($1, $2, 'embedding', 'active')`,
    [binding, workspace],
  );
  await pool.query(
    `INSERT INTO ai_model_binding_versions (
       id, workspace_id, model_binding_id, version, provider_instance_version_id,
       catalog_snapshot_id, catalog_model_id, canonical_model, wire_api,
       parameters, capabilities, secret_reference
     ) VALUES ($1, $2, $3, 1, $4, $5, $6, 'embedding', 'embeddings', '{}'::jsonb, '[]'::jsonb, 'vault:test')`,
    [bindingVersion, workspace, binding, providerVersion, catalog, model],
  );
  await pool.query(
    `INSERT INTO connector_registrations (id, workspace_id, lifecycle)
     VALUES ($1, $2, 'active')`,
    [`connector-${suffix}`, workspace],
  );
  if (knowledgeCapability) {
    await pool.query(
      `INSERT INTO connector_capabilities (workspace_id, connector_registration_id, capability)
       VALUES ($1, $2, 'knowledgeSource')`,
      [workspace, `connector-${suffix}`],
    );
  }
  await pool.query(
    `INSERT INTO knowledge_collections (id, workspace_id, embedding_binding_version_id, embedding_profile_version, dimensions)
     VALUES ($1, $2, $3, 'embedding-profile-v1', 3)`,
    [`collection-${suffix}`, workspace, bindingVersion],
  );
}
