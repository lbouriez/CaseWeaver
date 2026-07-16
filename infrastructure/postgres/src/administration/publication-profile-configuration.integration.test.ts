import { randomUUID } from "node:crypto";

import {
  type AdministrationTransactionRunner,
  type ConfigurationLifecycleAudit,
  ManagePublicationProfileConfiguration,
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
import { PostgresPublicationProfileConfigurationStore } from "./publication-profile-configuration-store.js";

const databaseUrl = process.env.DATABASE_URL;
if (
  databaseUrl === undefined ||
  !new URL(databaseUrl).pathname.toLowerCase().includes("test")
) {
  throw new Error(
    "PostgreSQL publication-profile configuration tests require a disposable test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const transactions: AdministrationTransactionRunner = {
  transaction: async <T>(operation: () => Promise<T>): Promise<T> =>
    operation(),
};

const destinationDescriptor = {
  kind: "connector",
  type: "test-analysis-destination",
  version: "1",
  displayName: "Test analysis destination",
  description: "A test-only destination descriptor.",
  connectorCapabilities: ["analysisDestination"],
  aiCapabilities: [],
  supportedWireApis: [],
  supportedWebhookEventTypes: [],
  settingsSchema: { type: "object", additionalProperties: false },
  uiGroups: [],
  secretSlots: [],
  supportsConfigurationMigration: false,
  supportedTestOperations: [],
};

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE workspaces RESTART IDENTITY CASCADE");
  await pool.query(`
    INSERT INTO workspaces (id) VALUES ('workspace-a'), ('workspace-b');
    INSERT INTO principals (id, workspace_id) VALUES
      ('principal-a', 'workspace-a'), ('principal-b', 'workspace-b');
    INSERT INTO connector_registrations (id, workspace_id, lifecycle) VALUES
      ('destination-a', 'workspace-a', 'active'),
      ('destination-b', 'workspace-b', 'disabled');
    INSERT INTO connector_capabilities (
      workspace_id, connector_registration_id, capability
    ) VALUES
      ('workspace-a', 'destination-a', 'analysisDestination'),
      ('workspace-b', 'destination-b', 'analysisDestination');
  `);
  await pool.query(
    `INSERT INTO administration_descriptor_revisions (
       kind, type, version, descriptor, descriptor_hash
     ) VALUES ('connector', 'test-analysis-destination', '1', $1::jsonb, $2)
     ON CONFLICT (kind, type, version) DO NOTHING`,
    [JSON.stringify(destinationDescriptor), "d".repeat(64)],
  );
  await pool.query(`
    INSERT INTO administration_configurations (
      id, workspace_id, resource_type, lifecycle, revision
    ) VALUES ('destination-a', 'workspace-a', 'connector-instances', 'active', 1);
    INSERT INTO administration_configuration_versions (
      id, workspace_id, configuration_id, version, settings, secret_references,
      descriptor_kind, descriptor_type, descriptor_version
    ) VALUES (
      'destination-a-configuration-v1', 'workspace-a', 'destination-a', 1,
      '{}'::jsonb, '[]'::jsonb,
      'connector', 'test-analysis-destination', '1'
    );
    UPDATE administration_configurations
    SET current_version_id = 'destination-a-configuration-v1'
    WHERE workspace_id = 'workspace-a' AND id = 'destination-a';
  `);
});

afterAll(async () => {
  await pool.end();
});

describe("PostgreSQL publication profile administration projection", () => {
  it("activates a validated immutable PBI-012 profile and retains the shared configuration reference", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      const draft = await persistence.unitOfWork.transaction((transaction) =>
        manager(persistence, transaction, "workspace-a", "principal-a").create({
          workspaceId: "workspace-a",
          displayName: "Internal case publication",
          definition: profileDefinition("destination-a"),
          profile: { profileId: "publication-profile-a" },
          mutation: mutation("publicationProfile.create", "a"),
        }),
      );
      expect(draft.configuration).toMatchObject({
        lifecycle: "draft",
        revision: 1,
      });
      await expect(
        pool.query(
          "SELECT id FROM publication_profiles WHERE workspace_id = 'workspace-a'",
        ),
      ).resolves.toMatchObject({ rows: [] });

      const active = await persistence.unitOfWork.transaction((transaction) =>
        manager(
          persistence,
          transaction,
          "workspace-a",
          "principal-a",
        ).transition({
          workspaceId: "workspace-a",
          definition: profileDefinition("destination-a"),
          profile: { profileId: "publication-profile-a" },
          expectedRevision: draft.configuration.revision,
          lifecycle: "active",
          mutation: mutation("publicationProfile.activate", "b"),
        }),
      );
      await expect(
        pool.query<{
          readonly lifecycle: string;
          readonly version: string;
          readonly profile_version_id: string;
          readonly profile_id: string;
          readonly destination_id: string;
          readonly destination_configuration_version_id: string;
        }>(
          `SELECT profile.lifecycle, version.version,
                  version.id AS profile_version_id,
                  version.publication_profile_id AS profile_id,
                  version.definition #>> '{destination,connectorInstanceId}' AS destination_id,
                  version.destination_connector_configuration_version_id
                    AS destination_configuration_version_id
           FROM publication_profiles AS profile
           JOIN publication_profile_versions AS version
             ON version.workspace_id = profile.workspace_id
            AND version.publication_profile_id = profile.id
           WHERE profile.workspace_id = 'workspace-a'
             AND profile.id = 'publication-profile-a'`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            lifecycle: "active",
            version: "2",
            profile_version_id: active.version.id,
            profile_id: "publication-profile-a",
            destination_id: "destination-a",
            destination_configuration_version_id:
              "destination-a-configuration-v1",
          },
        ],
      });
      await expect(
        pool.query(
          `UPDATE publication_profile_versions
           SET definition = '{}'::jsonb
           WHERE id = $1`,
          [active.version.id],
        ),
      ).rejects.toThrow(/immutable/i);
      await expect(
        pool.query<{
          readonly action: string;
          readonly target_id: string;
          readonly outcome: string;
        }>(
          `SELECT action, target_id, outcome
           FROM audit_events
           WHERE workspace_id = 'workspace-a'
           ORDER BY action`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            action: "admin.publicationProfile.configuration.changed",
            target_id: "publication-profile-a",
            outcome: "succeeded",
          },
          {
            action: "admin.publicationProfile.draft.created",
            target_id: "publication-profile-a",
            outcome: "succeeded",
          },
        ],
      });
    } finally {
      await persistence.close();
    }
  });

  it("rejects a disabled destination and rolls back the candidate version, audit, and cache notice", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      const draft = await persistence.unitOfWork.transaction((transaction) =>
        manager(persistence, transaction, "workspace-b", "principal-b").create({
          workspaceId: "workspace-b",
          displayName: "Unavailable destination",
          definition: profileDefinition("destination-b"),
          profile: { profileId: "publication-profile-b" },
          mutation: mutation("publicationProfile.create", "c"),
        }),
      );
      await expect(
        persistence.unitOfWork.transaction((transaction) =>
          manager(
            persistence,
            transaction,
            "workspace-b",
            "principal-b",
          ).transition({
            workspaceId: "workspace-b",
            definition: profileDefinition("destination-b"),
            profile: { profileId: "publication-profile-b" },
            expectedRevision: draft.configuration.revision,
            lifecycle: "active",
            mutation: mutation("publicationProfile.activate", "d"),
          }),
        ),
      ).rejects.toMatchObject({ code: "administration.invalid" });
      await expect(
        pool.query<{
          readonly configurations: string;
          readonly versions: string;
          readonly profiles: string;
          readonly audits: string;
          readonly changes: string;
        }>(
          `SELECT
             (SELECT count(*)::text FROM administration_configurations WHERE workspace_id = 'workspace-b') AS configurations,
             (SELECT count(*)::text FROM administration_configuration_versions WHERE workspace_id = 'workspace-b') AS versions,
             (SELECT count(*)::text FROM publication_profiles WHERE workspace_id = 'workspace-b') AS profiles,
             (SELECT count(*)::text FROM audit_events WHERE workspace_id = 'workspace-b') AS audits,
             (SELECT count(*)::text FROM administration_configuration_change_outbox WHERE workspace_id = 'workspace-b') AS changes`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            configurations: "1",
            versions: "1",
            profiles: "0",
            audits: "1",
            changes: "1",
          },
        ],
      });
    } finally {
      await persistence.close();
    }
  });

  it("disables a profile without changing a retained immutable publication version", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      const draft = await persistence.unitOfWork.transaction((transaction) =>
        manager(persistence, transaction, "workspace-a", "principal-a").create({
          workspaceId: "workspace-a",
          displayName: "Internal case publication",
          definition: profileDefinition("destination-a"),
          profile: { profileId: "publication-profile-a" },
          mutation: mutation("publicationProfile.create", "e"),
        }),
      );
      const active = await persistence.unitOfWork.transaction((transaction) =>
        manager(
          persistence,
          transaction,
          "workspace-a",
          "principal-a",
        ).transition({
          workspaceId: "workspace-a",
          definition: profileDefinition("destination-a"),
          profile: { profileId: "publication-profile-a" },
          expectedRevision: draft.configuration.revision,
          lifecycle: "active",
          mutation: mutation("publicationProfile.activate", "f"),
        }),
      );
      await persistence.unitOfWork.transaction((transaction) =>
        manager(
          persistence,
          transaction,
          "workspace-a",
          "principal-a",
        ).transition({
          workspaceId: "workspace-a",
          definition: profileDefinition("destination-a"),
          profile: { profileId: "publication-profile-a" },
          expectedRevision: active.configuration.revision,
          lifecycle: "disabled",
          mutation: mutation("publicationProfile.disable", "g"),
        }),
      );
      await expect(
        pool.query<{
          readonly lifecycle: string;
          readonly version_count: string;
          readonly retained_version: string;
        }>(
          `SELECT profile.lifecycle, count(version.id)::text AS version_count,
                  min(version.version) AS retained_version
           FROM publication_profiles AS profile
           LEFT JOIN publication_profile_versions AS version
             ON version.workspace_id = profile.workspace_id
            AND version.publication_profile_id = profile.id
           WHERE profile.workspace_id = 'workspace-a'
             AND profile.id = 'publication-profile-a'
           GROUP BY profile.lifecycle`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            lifecycle: "disabled",
            version_count: "1",
            retained_version: "2",
          },
        ],
      });
    } finally {
      await persistence.close();
    }
  });

  it("rejects disabling a connector registration or configuration retained by an active profile", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      const draft = await persistence.unitOfWork.transaction((transaction) =>
        manager(persistence, transaction, "workspace-a", "principal-a").create({
          workspaceId: "workspace-a",
          displayName: "Internal case publication",
          definition: profileDefinition("destination-a"),
          profile: { profileId: "publication-profile-a" },
          mutation: mutation("publicationProfile.create", "h"),
        }),
      );
      await persistence.unitOfWork.transaction((transaction) =>
        manager(
          persistence,
          transaction,
          "workspace-a",
          "principal-a",
        ).transition({
          workspaceId: "workspace-a",
          definition: profileDefinition("destination-a"),
          profile: { profileId: "publication-profile-a" },
          expectedRevision: draft.configuration.revision,
          lifecycle: "active",
          mutation: mutation("publicationProfile.activate", "i"),
        }),
      );
      await expect(
        pool.query(
          `UPDATE connector_registrations
           SET lifecycle = 'disabled'
           WHERE workspace_id = 'workspace-a' AND id = 'destination-a'`,
        ),
      ).rejects.toThrow(/active publication profiles/i);
      await expect(
        pool.query(
          `UPDATE administration_configurations
           SET lifecycle = 'disabled'
           WHERE workspace_id = 'workspace-a' AND id = 'destination-a'`,
        ),
      ).rejects.toThrow(/active publication profiles/i);
    } finally {
      await persistence.close();
    }
  });
});

function manager(
  persistence: ReturnType<typeof createPostgresPersistence>,
  transaction: ApplicationTransaction,
  workspace: string,
  principal: string,
): ManagePublicationProfileConfiguration {
  return new ManagePublicationProfileConfiguration(
    transactions,
    new PostgresPublicationProfileConfigurationStore(
      persistence.unitOfWork as PostgresTransactionLookup,
      transaction,
    ),
    audit(persistence.auditStore, transaction, workspace, principal),
  );
}

function profileDefinition(destinationConnectorInstanceId: string) {
  return {
    destination: { connectorInstanceId: destinationConnectorInstanceId },
    renderer: { id: "structured", version: "1", format: "markdown" as const },
    notices: { disclaimers: [] },
    policy: {
      mode: "approvalRequired" as const,
      visibility: "internal" as const,
    },
    limits: { maximumBodyCharacters: 10_000 },
  };
}

function mutation(operation: string, suffix: string) {
  return {
    operation,
    keyDigest: `key-${suffix}`,
    requestDigest: `request-${suffix}`,
  };
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
