import type { ApplicationTransaction } from "@caseweaver/application";
import type { MutationIdentity } from "@caseweaver/administration";
import { principalId, sha256Digest, workspaceId } from "@caseweaver/domain";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createPostgresPersistence,
  type PostgresTransactionLookup,
} from "../index.js";
import {
  PostgresConfigurationChangeOutbox,
  PostgresConfigurationLifecycleStore,
} from "./configuration-store.js";
import { PostgresDescriptorRegistry } from "./descriptor-registry.js";

const databaseUrl = process.env.DATABASE_URL;
if (
  databaseUrl === undefined ||
  !new URL(databaseUrl).pathname.toLowerCase().includes("test")
) {
  throw new Error(
    "PostgreSQL configuration tests require a disposable test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE workspaces RESTART IDENTITY CASCADE");
  await pool.query(
    "INSERT INTO workspaces (id) VALUES ('workspace-a'), ('workspace-b')",
  );
});

const mutation: MutationIdentity = {
  operation: "connector.activate",
  keyDigest: "key-digest",
  requestDigest: "request-digest",
};

function store(
  persistence: ReturnType<typeof createPostgresPersistence>,
  transaction: ApplicationTransaction,
  identifiers = ["configuration-version", "configuration-change"],
): PostgresConfigurationLifecycleStore {
  let next = 0;
  return new PostgresConfigurationLifecycleStore(
    persistence.unitOfWork as PostgresTransactionLookup,
    transaction,
    () => identifiers[next++] ?? `configuration-id-${next}`,
  );
}

describe("PostgreSQL configuration lifecycle", () => {
  it("consumes a durable action preview once and only for its bound session scope", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      await persistence.administrationActionPreviewStore.create({
        id: "preview-1",
        workspaceId: workspaceId("workspace-a"),
        principalId: principalId("principal-a"),
        sessionId: "session-a",
        action: "retention.reap",
        target: { resource: "retention" },
        command: {
          action: "retention.reap",
          target: { resource: "retention" },
          parameters: { limit: 100 },
        },
        parameterDigest: sha256Digest("a".repeat(64)),
        permission: "retention.run",
        confirmation: "Queue bounded expired retention work?",
        impact: "At most the approved batch will be queued.",
        canConfirm: true,
        expiresAt: "2027-01-01T00:00:00.000Z",
      });
      await expect(
        persistence.administrationActionPreviewStore.consume({
          previewId: "preview-1",
          workspaceId: "workspace-a",
          principalId: "principal-a",
          sessionId: "session-b",
          now: "2026-01-01T00:00:00.000Z",
        }),
      ).resolves.toBeUndefined();
      await expect(
        persistence.administrationActionPreviewStore.consume({
          previewId: "preview-1",
          workspaceId: "workspace-a",
          principalId: "principal-a",
          sessionId: "session-a",
          now: "2026-01-01T00:00:00.000Z",
        }),
      ).resolves.toMatchObject({ action: "retention.reap", canConfirm: true });
      await expect(
        persistence.administrationActionPreviewStore.consume({
          previewId: "preview-1",
          workspaceId: "workspace-a",
          principalId: "principal-a",
          sessionId: "session-a",
          now: "2026-01-01T00:00:00.000Z",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await persistence.close();
    }
  });

  it("enforces workspace scope, revision concurrency, immutable versions, and idempotency storage", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      await persistence.unitOfWork.transaction(async (transaction) => {
        const configurations = store(persistence, transaction, [
          "draft-version",
          "draft-change",
          "active-version",
          "active-change",
        ]);
        await configurations.createDraft({
          workspaceId: "workspace-a",
          resourceType: "connector-instance",
          configurationId: "connector-a",
          displayName: "Documentation",
          canonicalSettings: '{"endpoint":"https://example.test"}',
          secretReferenceIds: ["secret-a"],
        });
        expect(
          await configurations.findMutation({
            workspaceId: "workspace-a",
            identity: mutation,
          }),
        ).toBeUndefined();
        const result = await configurations.transition({
          workspaceId: "workspace-a",
          resourceType: "connector-instance",
          configurationId: "connector-a",
          expectedRevision: 1,
          canonicalSettings: '{"endpoint":"https://example.test/v2"}',
          secretReferenceIds: ["secret-b", "secret-a", "secret-a"],
        });
        expect(result).toMatchObject({
          configuration: {
            revision: 2,
            lifecycle: "active",
            currentVersionId: "active-version",
          },
          version: {
            canonicalSettings: '{"endpoint":"https://example.test/v2"}',
            secretReferenceIds: ["secret-a", "secret-b"],
          },
        });
        const disabled = await configurations.transition({
          workspaceId: "workspace-a",
          resourceType: "connector-instance",
          configurationId: "connector-a",
          expectedRevision: 2,
          canonicalSettings: '{"endpoint":"https://example.test/v2"}',
          secretReferenceIds: ["secret-a", "secret-b"],
          lifecycle: "disabled",
        });
        expect(disabled).toMatchObject({
          configuration: { revision: 3, lifecycle: "disabled" },
          version: { version: 3 },
        });
        await configurations.recordMutation({
          workspaceId: "workspace-a",
          identity: mutation,
          result: {
            requestDigest: mutation.requestDigest,
            resourceId: "active-version",
          },
        });
      });

      await persistence.unitOfWork.transaction(async (transaction) => {
        const configurations = store(persistence, transaction);
        await expect(
          configurations.loadVersion({
            workspaceId: "workspace-b",
            resourceType: "connector-instance",
            configurationId: "connector-a",
            versionId: "active-version",
          }),
        ).resolves.toBeUndefined();
        await expect(
          configurations.findMutation({
            workspaceId: "workspace-a",
            identity: mutation,
          }),
        ).resolves.toEqual({
          requestDigest: "request-digest",
          resourceId: "active-version",
        });
      });

      const inspection =
        await persistence.administrationResourceReadStore.configurationInspection(
          {
            workspaceId: "workspace-a",
            configurationId: "connector-a",
          },
        );
      const history =
        await persistence.administrationResourceReadStore.configurationHistory({
          workspaceId: "workspace-a",
          configurationId: "connector-a",
          query: { limit: 2 },
        });
      expect(inspection).toMatchObject({
        id: "connector-a",
        currentVersionId: "configuration-id-5",
        currentVersion: {
          version: 3,
          secretReferenceCount: 2,
          canonicalSettingsSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      });
      expect(JSON.stringify(inspection)).not.toMatch(
        /endpoint|secret-a|secret-b/u,
      );
      expect(history?.items.map((value) => value.version)).toEqual([3, 2]);
      await expect(
        persistence.administrationResourceReadStore.configurationInspection({
          workspaceId: "workspace-b",
          configurationId: "connector-a",
        }),
      ).resolves.toBeUndefined();

      await expect(
        pool.query(
          "UPDATE administration_configuration_versions SET settings = '{}'::jsonb WHERE id = 'active-version'",
        ),
      ).rejects.toThrow(/immutable/i);
      await expect(
        pool.query(
          "DELETE FROM administration_configuration_versions WHERE id = 'active-version'",
        ),
      ).rejects.toThrow(/immutable/i);
    } finally {
      await persistence.close();
    }
  });

  it("allows exactly one concurrent transition for a revision", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      await persistence.unitOfWork.transaction(async (transaction) => {
        await store(persistence, transaction).createDraft({
          workspaceId: "workspace-a",
          resourceType: "connector-instance",
          configurationId: "connector-concurrent",
          displayName: "Concurrent connector",
          canonicalSettings: "{}",
          secretReferenceIds: [],
        });
      });
      const transition = (versionId: string) =>
        persistence.unitOfWork.transaction((transaction) =>
          store(persistence, transaction, [
            versionId,
            `${versionId}-change`,
          ]).transition({
            workspaceId: "workspace-a",
            resourceType: "connector-instance",
            configurationId: "connector-concurrent",
            expectedRevision: 1,
            canonicalSettings: "{}",
            secretReferenceIds: [],
          }),
        );
      const results = await Promise.all([
        transition("configuration-version-a"),
        transition("configuration-version-b"),
      ]);
      expect(results.filter((result) => result !== undefined)).toHaveLength(1);
      const versions = await pool.query<{ count: string }>(
        "SELECT count(*)::text FROM administration_configuration_versions WHERE configuration_id = 'connector-concurrent'",
      );
      expect(versions.rows[0]?.count).toBe("2");
    } finally {
      await persistence.close();
    }
  });

  it("reports bounded configuration dependencies for an opaque secret registration", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      await pool.query(
        "INSERT INTO credential_registrations (id, workspace_id, secret_reference, lifecycle) VALUES ('credential-a', 'workspace-a', 'vault:operator/connector-token', 'active')",
      );
      await persistence.unitOfWork.transaction(async (transaction) => {
        await store(persistence, transaction).createDraft({
          workspaceId: "workspace-a",
          resourceType: "connector-instances",
          configurationId: "connector-with-secret",
          displayName: "Connector with reference",
          canonicalSettings: '{"endpoint":"https://example.test"}',
          secretReferenceIds: ["vault:operator/connector-token"],
        });
      });

      await expect(
        persistence.administrationReadStore.secretReferenceDependencies({
          workspaceId: "workspace-a",
          secretReferenceId: "credential-a",
        }),
      ).resolves.toEqual([
        {
          configurationId: "connector-with-secret",
          resourceType: "connector-instances",
        },
      ]);
      await expect(
        persistence.administrationReadStore.secretReferenceDependencies({
          workspaceId: "workspace-b",
          secretReferenceId: "credential-a",
        }),
      ).resolves.toEqual([]);
    } finally {
      await persistence.close();
    }
  });

  it("rolls back the claimed aggregate revision when immutable-version insertion cannot begin", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      await persistence.unitOfWork.transaction(async (transaction) => {
        await store(persistence, transaction).createDraft({
          workspaceId: "workspace-a",
          resourceType: "connector-instance",
          configurationId: "connector-rollback",
          displayName: "Rollback connector",
          canonicalSettings: "{}",
          secretReferenceIds: [],
        });
      });
      await expect(
        persistence.unitOfWork.transaction((transaction) =>
          store(persistence, transaction).transition({
            workspaceId: "workspace-a",
            resourceType: "connector-instance",
            configurationId: "connector-rollback",
            expectedRevision: 1,
            canonicalSettings: "not-json",
            secretReferenceIds: [],
          }),
        ),
      ).rejects.toThrow();
      const configuration = await pool.query<{
        readonly revision: number;
        readonly lifecycle: string;
        readonly current_version_id: string | null;
      }>(
        "SELECT revision, lifecycle, current_version_id FROM administration_configurations WHERE id = 'connector-rollback'",
      );
      expect(configuration.rows).toEqual([
        {
          revision: 1,
          lifecycle: "draft",
          current_version_id: "configuration-version",
        },
      ]);
      const versions = await pool.query<{ readonly count: string }>(
        "SELECT count(*)::text FROM administration_configuration_versions WHERE configuration_id = 'connector-rollback'",
      );
      expect(versions.rows[0]?.count).toBe("1");
    } finally {
      await persistence.close();
    }
  });

  it("persists only safe immutable descriptor revisions and retains a descriptor-backed draft history", async () => {
    const client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    const registry = new PostgresDescriptorRegistry(client);
    const descriptor = {
      kind: "connector" as const,
      // This isolated registry test runs alongside feature integration tests
      // that seed valid-but-minimal descriptors directly for their own
      // projections. Keep this test's cursor range distinct from those
      // immutable fixtures; production registration remains strict.
      type: "000-synthetic-source",
      version: "1",
      displayName: "Synthetic source",
      description: "Safe test descriptor",
      connectorCapabilities: ["knowledgeSource"] as const,
      aiCapabilities: [],
      supportedWireApis: [],
      supportedWebhookEventTypes: [],
      settingsSchema: {
        type: "object" as const,
        properties: { endpoint: { type: "string" as const } },
      },
      uiGroups: [],
      secretSlots: [
        {
          name: "token",
          label: "Token",
          required: true,
          acceptedReferenceKinds: ["vault"],
          supportsRotation: true,
        },
      ],
      supportsConfigurationMigration: false,
      supportedTestOperations: [],
    };
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      await registry.register(descriptor);
      await registry.register({
        ...descriptor,
        type: "001-synthetic-source-second",
      });
      await expect(registry.register(descriptor)).resolves.toMatchObject({
        type: "000-synthetic-source",
      });
      await expect(
        registry.register({ ...descriptor, displayName: "Changed" }),
      ).rejects.toThrow(/different content/i);
      const firstPage = await registry.list({ limit: 1 });
      expect(firstPage).toMatchObject([{ type: "000-synthetic-source" }]);
      const first = firstPage[0];
      if (first === undefined)
        throw new Error("Expected descriptor page item.");
      await expect(
        registry.list({
          limit: 1,
          after: PostgresDescriptorRegistry.cursorFor(first),
        }),
      ).resolves.toMatchObject([{ type: "001-synthetic-source-second" }]);
      await expect(
        registry.find({ kind: "connector", type: "000-synthetic-source" }),
      ).resolves.toMatchObject({ version: "1" });

      await persistence.unitOfWork.transaction(async (transaction) => {
        const configurations = store(persistence, transaction, [
          "descriptor-version",
          "descriptor-change",
        ]);
        const created = await configurations.createDraft({
          workspaceId: "workspace-a",
          resourceType: "connector-instance",
          configurationId: "descriptor-connector",
          displayName: "Descriptor-backed connector",
          canonicalSettings: '{"endpoint":"https://example.test"}',
          secretReferenceIds: ["secret-reference-a"],
          descriptor: {
            kind: "connector",
            type: "000-synthetic-source",
            version: "1",
          },
        });
        expect(created.version).toMatchObject({
          displayName: "Descriptor-backed connector",
          descriptor: {
            kind: "connector",
            type: "000-synthetic-source",
            version: "1",
          },
          secretReferenceIds: ["secret-reference-a"],
        });
      });
      await persistence.unitOfWork.transaction(async (transaction) => {
        const configurations = store(persistence, transaction, [
          "descriptor-version-2",
          "descriptor-change-2",
        ]);
        const transitioned = await configurations.transition({
          workspaceId: "workspace-a",
          resourceType: "connector-instance",
          configurationId: "descriptor-connector",
          expectedRevision: 1,
          canonicalSettings: '{"endpoint":"https://example.test/v2"}',
          secretReferenceIds: ["secret-reference-a"],
        });
        expect(transitioned?.version).toMatchObject({
          descriptor: {
            kind: "connector",
            type: "000-synthetic-source",
            version: "1",
          },
          displayName: "Descriptor-backed connector",
        });
      });
      const persisted = await pool.query<{
        descriptor: unknown;
        secret_references: unknown;
      }>(
        "SELECT revision.descriptor, version.secret_references FROM administration_descriptor_revisions AS revision CROSS JOIN administration_configuration_versions AS version WHERE version.id = 'descriptor-version'",
      );
      expect(JSON.stringify(persisted.rows[0]?.descriptor)).not.toContain(
        "secret-reference-a",
      );
      expect(JSON.stringify(persisted.rows[0]?.descriptor)).not.toContain(
        "super-secret",
      );
      expect(persisted.rows[0]?.secret_references).toEqual([
        "secret-reference-a",
      ]);
      const changes = await pool.query<{ cache_scopes: unknown }>(
        "SELECT cache_scopes FROM administration_configuration_change_outbox WHERE configuration_id = 'descriptor-connector' ORDER BY created_at, id",
      );
      expect(changes.rows).toHaveLength(2);
      expect(JSON.stringify(changes.rows)).not.toContain("secret-reference-a");
      expect(JSON.stringify(changes.rows[0]?.cache_scopes)).toContain(
        "configuration:descriptor-connector",
      );
      const claimed = await persistence.unitOfWork.transaction(
        (transaction) => {
          const outbox = new PostgresConfigurationChangeOutbox(
            persistence.unitOfWork as PostgresTransactionLookup,
            transaction,
          );
          return outbox.claim({ limit: 10, leaseMs: 60_000 });
        },
      );
      expect(claimed).toHaveLength(2);
      expect(JSON.stringify(claimed)).not.toContain("secret-reference-a");
      await persistence.unitOfWork.transaction(async (transaction) => {
        const outbox = new PostgresConfigurationChangeOutbox(
          persistence.unitOfWork as PostgresTransactionLookup,
          transaction,
        );
        for (const claim of claimed) await outbox.acknowledge(claim);
      });
      await expect(
        pool.query(
          "DELETE FROM administration_descriptor_revisions WHERE type = '000-synthetic-source'",
        ),
      ).rejects.toThrow(/immutable/i);
    } finally {
      await persistence.close();
      await client.$disconnect();
    }
  });
});
