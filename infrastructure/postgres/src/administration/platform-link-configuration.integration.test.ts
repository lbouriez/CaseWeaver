import { randomUUID } from "node:crypto";

import {
  type AdministrationTransactionRunner,
  type ConfigurationLifecycleAudit,
  ManagePlatformLinkConfiguration,
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
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPostgresPersistence,
  type PostgresTransactionLookup,
} from "../index.js";
import {
  PostgresPlatformLinkConfigurationReadStore,
  PostgresPlatformLinkConfigurationStore,
} from "./platform-link-configuration-store.js";

const databaseUrl = process.env.DATABASE_URL;
if (
  databaseUrl === undefined ||
  !new URL(databaseUrl).pathname.toLowerCase().includes("test")
) {
  throw new Error(
    "PostgreSQL platform-link configuration tests require a disposable test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const transactions: AdministrationTransactionRunner = {
  transaction: async <T>(operation: () => Promise<T>): Promise<T> =>
    operation(),
};

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE workspaces RESTART IDENTITY CASCADE");
  await pool.query(`
    INSERT INTO workspaces (id) VALUES ('workspace-a');
    INSERT INTO principals (id, workspace_id) VALUES ('principal-a', 'workspace-a');
  `);
});

afterAll(async () => {
  await pool.end();
});

describe("PostgreSQL platform-link configuration", () => {
  it("retains normalized public bases in immutable versions and reads their current state", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    const client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    try {
      const draft = await persistence.unitOfWork.transaction((transaction) =>
        manager(persistence, transaction).create({
          workspaceId: "workspace-a",
          settings: settings(),
          mutation: mutation("platformLinks.create", "a"),
        }),
      );
      const reader = new PostgresPlatformLinkConfigurationReadStore(client, {
        allowHttpLocalhost: false,
      });
      await expect(
        reader.find({ workspaceId: "workspace-a" }),
      ).resolves.toEqual({
        workspaceId: "workspace-a",
        configurationId: "platform-links:workspace-a",
        configurationVersionId: draft.version.id,
        revision: 1,
        lifecycle: "draft",
        settings: {
          apiPublicBaseUrl: "https://api.example.test/v1",
          webhookPublicBaseUrl: "https://hooks.example.test/ingress",
        },
      });

      const active = await persistence.unitOfWork.transaction((transaction) =>
        manager(persistence, transaction).transition({
          workspaceId: "workspace-a",
          settings: settings(),
          expectedRevision: draft.configuration.revision,
          mutation: mutation("platformLinks.activate", "b"),
        }),
      );
      await expect(
        reader.find({ workspaceId: "workspace-a" }),
      ).resolves.toEqual({
        workspaceId: "workspace-a",
        configurationId: "platform-links:workspace-a",
        configurationVersionId: active.version.id,
        revision: 2,
        lifecycle: "active",
        settings: {
          apiPublicBaseUrl: "https://api.example.test/v1",
          webhookPublicBaseUrl: "https://hooks.example.test/ingress",
        },
      });
      await expect(
        reader.find({ workspaceId: "workspace-b" }),
      ).resolves.toBeUndefined();
      await expect(
        pool.query<{
          readonly version_count: string;
          readonly secret_count: string;
          readonly activation_audit_count: string;
        }>(
          `SELECT
             (SELECT count(*)::text FROM administration_configuration_versions
              WHERE workspace_id = 'workspace-a'
                AND configuration_id = 'platform-links:workspace-a') AS version_count,
             (SELECT coalesce(sum(secret_reference_count), 0)::text
              FROM administration_configuration_versions
              WHERE workspace_id = 'workspace-a'
                AND configuration_id = 'platform-links:workspace-a') AS secret_count,
             (SELECT count(*) FILTER (
               WHERE action = 'admin.platformLink.configuration.changed'
             )::text FROM audit_events
              WHERE workspace_id = 'workspace-a'
                AND target_id = 'platform-links:workspace-a') AS activation_audit_count`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            version_count: "2",
            secret_count: "0",
            activation_audit_count: "1",
          },
        ],
      });
    } finally {
      await client.$disconnect();
      await persistence.close();
    }
  });
});

function manager(
  persistence: ReturnType<typeof createPostgresPersistence>,
  transaction: ApplicationTransaction,
): ManagePlatformLinkConfiguration {
  return new ManagePlatformLinkConfiguration(
    transactions,
    new PostgresPlatformLinkConfigurationStore(
      persistence.unitOfWork as PostgresTransactionLookup,
      transaction,
    ),
    audit(persistence.auditStore, transaction),
    { allowHttpLocalhost: false },
  );
}

function settings() {
  return {
    apiPublicBaseUrl: "https://api.example.test/v1/",
    webhookPublicBaseUrl: "https://hooks.example.test/ingress/",
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
): ConfigurationLifecycleAudit {
  return {
    append: async (input) => {
      await auditStore.append(transaction, {
        id: auditEventId(randomUUID()),
        workspaceId: workspaceId("workspace-a"),
        actorPrincipalId: principalId("principal-a"),
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
