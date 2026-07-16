import { randomUUID } from "node:crypto";

import {
  type AdministrationTransactionRunner,
  type ConfigurationLifecycleAudit,
  ManageWebhookEndpointConfiguration,
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
import { PostgresConfigurationLifecycleStore } from "./configuration-store.js";
import { PostgresWebhookEndpointConfigurationStore } from "./webhook-endpoint-configuration-store.js";
import { PostgresWebhookEndpointRuntimeStore } from "./webhook-endpoint-runtime-store.js";

const databaseUrl = process.env.DATABASE_URL;
if (
  databaseUrl === undefined ||
  !new URL(databaseUrl).pathname.toLowerCase().includes("test")
) {
  throw new Error(
    "PostgreSQL webhook-endpoint configuration tests require a disposable test database.",
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
    INSERT INTO connector_registrations (id, workspace_id, lifecycle)
      VALUES ('connector-a', 'workspace-a', 'active');
    INSERT INTO connector_capabilities (
      workspace_id, connector_registration_id, capability
    ) VALUES ('workspace-a', 'connector-a', 'webhookAdapter');
  `);
});

afterAll(async () => {
  await pool.end();
});

describe("PostgreSQL webhook endpoint administration projection", () => {
  it("activates a descriptor-safe endpoint with its exact immutable configuration version", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      await persistence.descriptorRegistry.register(connectorDescriptor());
      const connectorConfigurationVersionId =
        await activateConnectorConfiguration(persistence);
      const draft = await persistence.unitOfWork.transaction((transaction) =>
        manager(persistence, transaction).create({
          workspaceId: "workspace-a",
          displayName: "Case updates",
          projection: endpoint(),
          settings: { eventFilter: "case-updated" },
          secretReferenceLocators: ["vault:opaque/webhook-signing"],
          mutation: mutation("webhookEndpoint.create", "a"),
        }),
      );
      const active = await persistence.unitOfWork.transaction((transaction) =>
        manager(persistence, transaction).transition({
          workspaceId: "workspace-a",
          projection: endpoint(),
          settings: { eventFilter: "case-updated" },
          secretReferenceLocators: ["vault:opaque/webhook-signing"],
          expectedRevision: draft.configuration.revision,
          lifecycle: "active",
          automatedPrincipalId: "principal-a",
          mutation: mutation("webhookEndpoint.activate", "b"),
        }),
      );
      await expect(
        pool.query<{
          readonly lifecycle: string;
          readonly connector_instance_id: string;
          readonly endpoint_configuration_version_id: string;
          readonly connector_configuration_version_id: string;
          readonly verified_event_types: readonly string[];
          readonly maximum_body_bytes: number;
          readonly maximum_requests_per_minute: number;
          readonly analysis_trigger_id: string | null;
        }>(
          `SELECT lifecycle, connector_instance_id,
                  endpoint_configuration_version_id,
                  connector_configuration_version_id,
                  verified_event_types, maximum_body_bytes,
          maximum_requests_per_minute, analysis_trigger_id, automated_principal_id
           FROM webhook_endpoints
           WHERE workspace_id = 'workspace-a' AND id = 'opaque_endpoint-1'`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            lifecycle: "active",
            connector_instance_id: "connector-a",
            endpoint_configuration_version_id: active.version.id,
            connector_configuration_version_id: connectorConfigurationVersionId,
            verified_event_types: ["caseChanged"],
            maximum_body_bytes: 131_072,
            maximum_requests_per_minute: 120,
            analysis_trigger_id: "trigger-a",
            automated_principal_id: "principal-a",
          },
        ],
      });
      await expect(
        pool.query<{
          readonly action: string;
          readonly target_id: string;
          readonly outcome: string;
        }>(
          `SELECT action, target_id, outcome
           FROM audit_events
           WHERE workspace_id = 'workspace-a'
             AND target_id = 'opaque_endpoint-1'
           ORDER BY action`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            action: "admin.webhookEndpoint.configuration.changed",
            target_id: "opaque_endpoint-1",
            outcome: "succeeded",
          },
          {
            action: "admin.webhookEndpoint.draft.created",
            target_id: "opaque_endpoint-1",
            outcome: "succeeded",
          },
        ],
      });
    } finally {
      await persistence.close();
    }
  });

  it("rolls back a descriptor-unsafe activation with its candidate version, audit, mutation, and cache notice", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      await persistence.descriptorRegistry.register(connectorDescriptor());
      await activateConnectorConfiguration(persistence);
      const draft = await persistence.unitOfWork.transaction((transaction) =>
        manager(persistence, transaction).create({
          workspaceId: "workspace-a",
          displayName: "Unsupported event",
          projection: { ...endpoint(), verifiedEventTypes: ["ticketChanged"] },
          settings: { eventFilter: "ticket-updated" },
          secretReferenceLocators: ["vault:opaque/webhook-signing"],
          mutation: mutation("webhookEndpoint.create", "c"),
        }),
      );
      await expect(
        persistence.unitOfWork.transaction((transaction) =>
          manager(persistence, transaction).transition({
            workspaceId: "workspace-a",
            projection: {
              ...endpoint(),
              verifiedEventTypes: ["ticketChanged"],
            },
            settings: { eventFilter: "ticket-updated" },
            secretReferenceLocators: ["vault:opaque/webhook-signing"],
            expectedRevision: draft.configuration.revision,
            lifecycle: "active",
            automatedPrincipalId: "principal-a",
            mutation: mutation("webhookEndpoint.activate", "d"),
          }),
        ),
      ).rejects.toMatchObject({ code: "administration.invalid" });
      await expect(
        pool.query<{
          readonly versions: string;
          readonly mutations: string;
          readonly audits: string;
          readonly changes: string;
          readonly endpoints: string;
        }>(
          `SELECT
             (SELECT count(*)::text FROM administration_configuration_versions
              WHERE workspace_id = 'workspace-a' AND configuration_id = 'opaque_endpoint-1') AS versions,
             (SELECT count(*)::text FROM idempotency_records
              WHERE workspace_id = 'workspace-a' AND operation = 'webhookEndpoint.activate') AS mutations,
             (SELECT count(*)::text FROM audit_events
              WHERE workspace_id = 'workspace-a' AND target_id = 'opaque_endpoint-1') AS audits,
             (SELECT count(*)::text FROM administration_configuration_change_outbox
              WHERE workspace_id = 'workspace-a' AND configuration_id = 'opaque_endpoint-1') AS changes,
             (SELECT count(*)::text FROM webhook_endpoints
              WHERE workspace_id = 'workspace-a' AND id = 'opaque_endpoint-1') AS endpoints`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            versions: "1",
            mutations: "0",
            audits: "1",
            changes: "1",
            endpoints: "0",
          },
        ],
      });
    } finally {
      await persistence.close();
    }
  });

  it("enforces OCC while preserving inbox acceptance version when the endpoint is disabled", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      await persistence.descriptorRegistry.register(connectorDescriptor());
      const connectorConfigurationVersionId =
        await activateConnectorConfiguration(persistence);
      const draft = await persistence.unitOfWork.transaction((transaction) =>
        manager(persistence, transaction).create({
          workspaceId: "workspace-a",
          displayName: "Case updates",
          projection: endpoint(),
          settings: { eventFilter: "case-updated" },
          secretReferenceLocators: ["vault:opaque/webhook-signing"],
          mutation: mutation("webhookEndpoint.create", "e"),
        }),
      );
      const active = await persistence.unitOfWork.transaction((transaction) =>
        manager(persistence, transaction).transition({
          workspaceId: "workspace-a",
          projection: endpoint(),
          settings: { eventFilter: "case-updated" },
          secretReferenceLocators: ["vault:opaque/webhook-signing"],
          expectedRevision: draft.configuration.revision,
          lifecycle: "active",
          automatedPrincipalId: "principal-a",
          mutation: mutation("webhookEndpoint.activate", "f"),
        }),
      );
      await pool.query(
        `INSERT INTO webhook_inbox (
           id, workspace_id, endpoint_id, endpoint_configuration_version_id,
           connector_configuration_version_id,
           connector_instance_id, delivery_key, raw_body_digest,
           verification, signals, received_at
         ) VALUES (
           'inbox-a', 'workspace-a', 'opaque_endpoint-1', $1, $2,
           'connector-a', 'delivery-a', repeat('a', 64),
           '{"eventType":"caseChanged"}'::jsonb, '[]'::jsonb, now()
         )`,
        [active.version.id, connectorConfigurationVersionId],
      );
      await expect(
        persistence.unitOfWork.transaction((transaction) =>
          manager(persistence, transaction).transition({
            workspaceId: "workspace-a",
            projection: endpoint(),
            settings: { eventFilter: "stale" },
            secretReferenceLocators: ["vault:opaque/webhook-signing"],
            expectedRevision: draft.configuration.revision,
            lifecycle: "disabled",
            mutation: mutation("webhookEndpoint.disable", "g"),
          }),
        ),
      ).rejects.toMatchObject({ code: "administration.conflict" });
      const disabled = await persistence.unitOfWork.transaction((transaction) =>
        manager(persistence, transaction).transition({
          workspaceId: "workspace-a",
          projection: endpoint(),
          settings: { eventFilter: "case-updated" },
          secretReferenceLocators: ["vault:opaque/webhook-signing"],
          expectedRevision: active.configuration.revision,
          lifecycle: "disabled",
          mutation: mutation("webhookEndpoint.disable", "h"),
        }),
      );
      await expect(
        pool.query<{
          readonly lifecycle: string;
          readonly endpoint_version: string;
          readonly inbox_version: string;
        }>(
          `SELECT endpoint.lifecycle,
                  endpoint.endpoint_configuration_version_id AS endpoint_version,
                  inbox.endpoint_configuration_version_id AS inbox_version
           FROM webhook_endpoints AS endpoint
           JOIN webhook_inbox AS inbox
             ON inbox.workspace_id = endpoint.workspace_id
            AND inbox.endpoint_id = endpoint.id
           WHERE endpoint.workspace_id = 'workspace-a'
             AND endpoint.id = 'opaque_endpoint-1'`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            lifecycle: "disabled",
            endpoint_version: disabled.version.id,
            inbox_version: active.version.id,
          },
        ],
      });
      await expect(
        pool.query(
          "UPDATE webhook_inbox SET endpoint_configuration_version_id = $1 WHERE id = 'inbox-a'",
          [disabled.version.id],
        ),
      ).rejects.toThrow(/immutable/i);
    } finally {
      await persistence.close();
    }
  });

  it("resolves only active safe routing state and applies its database-time rate limit", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    const runtimeClient = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    try {
      await persistence.descriptorRegistry.register(connectorDescriptor());
      const connectorConfigurationVersionId =
        await activateConnectorConfiguration(persistence);
      const draft = await persistence.unitOfWork.transaction((transaction) =>
        manager(persistence, transaction).create({
          workspaceId: "workspace-a",
          displayName: "Rate-controlled events",
          projection: endpoint(1),
          settings: { eventFilter: "case-updated" },
          secretReferenceLocators: ["vault:opaque/webhook-signing"],
          mutation: mutation("webhookEndpoint.create", "i"),
        }),
      );
      const active = await persistence.unitOfWork.transaction((transaction) =>
        manager(persistence, transaction).transition({
          workspaceId: "workspace-a",
          projection: endpoint(1),
          settings: { eventFilter: "case-updated" },
          secretReferenceLocators: ["vault:opaque/webhook-signing"],
          expectedRevision: draft.configuration.revision,
          lifecycle: "active",
          automatedPrincipalId: "principal-a",
          mutation: mutation("webhookEndpoint.activate", "j"),
        }),
      );
      const runtime = new PostgresWebhookEndpointRuntimeStore(runtimeClient);

      await expect(
        runtime.findActive({ endpointId: "opaque_endpoint-1" }),
      ).resolves.toEqual({
        endpointId: "opaque_endpoint-1",
        workspaceId: "workspace-a",
        lifecycle: "active",
        connectorRegistrationId: "connector-a",
        endpointConfigurationVersionId: active.version.id,
        connectorConfigurationVersionId,
        verifiedEventTypes: ["caseChanged"],
        maximumBodyBytes: 131_072,
        maximumRequestsPerMinute: 1,
        analysisTriggerId: "trigger-a",
        automatedPrincipalId: "principal-a",
      });
      await expect(
        runtime.findActive({ endpointId: "absent" }),
      ).resolves.toBeUndefined();
      await expect(
        runtime.acquire({
          workspaceId: "workspace-a",
          endpointId: "opaque_endpoint-1",
        }),
      ).resolves.toEqual({ allowed: true });
      await expect(
        runtime.acquire({
          workspaceId: "workspace-a",
          endpointId: "opaque_endpoint-1",
        }),
      ).resolves.toEqual({ allowed: false });

      await persistence.unitOfWork.transaction((transaction) =>
        manager(persistence, transaction).transition({
          workspaceId: "workspace-a",
          projection: endpoint(1),
          settings: { eventFilter: "case-updated" },
          secretReferenceLocators: ["vault:opaque/webhook-signing"],
          expectedRevision: active.configuration.revision,
          lifecycle: "disabled",
          mutation: mutation("webhookEndpoint.disable", "k"),
        }),
      );
      await expect(
        runtime.findActive({ endpointId: "opaque_endpoint-1" }),
      ).resolves.toBeUndefined();
      await expect(
        runtime.acquire({
          workspaceId: "workspace-a",
          endpointId: "opaque_endpoint-1",
        }),
      ).resolves.toEqual({ allowed: false });
    } finally {
      await runtimeClient.$disconnect();
      await persistence.close();
    }
  });
});

function manager(
  persistence: ReturnType<typeof createPostgresPersistence>,
  transaction: ApplicationTransaction,
): ManageWebhookEndpointConfiguration {
  return new ManageWebhookEndpointConfiguration(
    transactions,
    new PostgresWebhookEndpointConfigurationStore(
      persistence.unitOfWork as PostgresTransactionLookup,
      transaction,
    ),
    audit(persistence.auditStore, transaction),
  );
}

async function activateConnectorConfiguration(
  persistence: ReturnType<typeof createPostgresPersistence>,
): Promise<string> {
  return persistence.unitOfWork.transaction(async (transaction) => {
    const store = new PostgresConfigurationLifecycleStore(
      persistence.unitOfWork as PostgresTransactionLookup,
      transaction,
    );
    await store.createDraft({
      workspaceId: "workspace-a",
      resourceType: "connector-instances",
      configurationId: "connector-a",
      displayName: "Webhook connector",
      canonicalSettings: '{"connectorInstanceId":"connector-a"}',
      secretReferenceIds: [],
      descriptor: {
        kind: "connector",
        type: "synthetic-webhook",
        version: "1",
      },
    });
    const active = await store.transition({
      workspaceId: "workspace-a",
      resourceType: "connector-instances",
      configurationId: "connector-a",
      expectedRevision: 1,
      canonicalSettings: '{"connectorInstanceId":"connector-a"}',
      secretReferenceIds: [],
      lifecycle: "active",
    });
    return active.version.id;
  });
}

function connectorDescriptor() {
  return {
    kind: "connector" as const,
    type: "synthetic-webhook",
    version: "1",
    displayName: "Synthetic webhook connector",
    description: "Integration fixture",
    connectorCapabilities: ["webhookAdapter"],
    aiCapabilities: [],
    supportedWireApis: [],
    supportedWebhookEventTypes: ["caseChanged"],
    settingsSchema: { type: "object" as const },
    uiGroups: [],
    secretSlots: [],
    supportsConfigurationMigration: false,
    supportedTestOperations: ["connectivity"],
  };
}

function endpoint(maximumRequestsPerMinute = 120) {
  return {
    endpointId: "opaque_endpoint-1",
    connectorRegistrationId: "connector-a",
    verifiedEventTypes: ["caseChanged"],
    maximumBodyBytes: 131_072,
    maximumRequestsPerMinute,
    analysisTriggerId: "trigger-a",
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
