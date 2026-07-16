import { RuntimeConnectorConfigurationError } from "@caseweaver/administration";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createPostgresPersistence } from "../index.js";
import { PostgresRuntimeConnectorConfigurationResolver } from "./runtime-connector-configuration-resolver.js";

const databaseUrl = process.env.DATABASE_URL;
if (
  databaseUrl === undefined ||
  !new URL(databaseUrl).pathname.toLowerCase().includes("test")
) {
  throw new Error(
    "PostgreSQL runtime connector configuration tests require a disposable test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});
const resolver = new PostgresRuntimeConnectorConfigurationResolver(client);

beforeEach(async () => {
  await pool.query(
    "TRUNCATE TABLE administration_descriptor_revisions, workspaces RESTART IDENTITY CASCADE",
  );
  await seed();
});

afterAll(async () => {
  await client.$disconnect();
  await pool.end();
});

describe("PostgresRuntimeConnectorConfigurationResolver", () => {
  it("resolves the active current version and explicitly pinned immutable versions", async () => {
    await expect(resolve()).resolves.toMatchObject({
      workspaceId: "workspace-a",
      connectorRegistrationId: "connector-a",
      configurationVersionId: "connector-version-current",
      descriptor: {
        kind: "connector",
        type: "test-connector",
        version: "v1",
      },
      settings: { endpoint: "https://current.example" },
      secretReferences: [{ locator: "vault://runtime-credential" }],
    });
    await expect(
      resolve({ configurationVersionId: "connector-version-current" }),
    ).resolves.toMatchObject({
      configurationVersionId: "connector-version-current",
      settings: { endpoint: "https://current.example" },
    });
    await expect(
      resolve({ configurationVersionId: "connector-version-previous" }),
    ).resolves.toMatchObject({
      configurationVersionId: "connector-version-previous",
      settings: { endpoint: "https://previous.example" },
    });
  });

  it("fails closed for a cross-workspace request, disabled state, revoked credentials, and missing capabilities", async () => {
    await expect(
      resolve({ workspaceId: "workspace-b" }),
    ).resolves.toBeUndefined();

    await pool.query(
      "UPDATE connector_registrations SET lifecycle = 'disabled' WHERE id = 'connector-a'",
    );
    await expect(resolve()).resolves.toBeUndefined();
    await pool.query(
      "UPDATE connector_registrations SET lifecycle = 'active' WHERE id = 'connector-a'",
    );

    await pool.query(
      "UPDATE administration_configurations SET lifecycle = 'disabled' WHERE id = 'connector-a'",
    );
    await expect(resolve()).resolves.toBeUndefined();
    await pool.query(
      "UPDATE administration_configurations SET lifecycle = 'active' WHERE id = 'connector-a'",
    );

    await pool.query(
      "UPDATE credential_registrations SET lifecycle = 'revoked' WHERE id = 'credential-a'",
    );
    await expect(resolve()).resolves.toBeUndefined();
    await pool.query(
      "UPDATE credential_registrations SET lifecycle = 'active' WHERE id = 'credential-a'",
    );

    await pool.query(
      `DELETE FROM connector_capabilities
       WHERE workspace_id = 'workspace-a'
         AND connector_registration_id = 'connector-a'
         AND capability = 'knowledgeSource'`,
    );
    await expect(resolve()).resolves.toBeUndefined();
  });

  it("fails closed when the immutable descriptor snapshot lacks the requested capability", async () => {
    await replaceCurrentDescriptor({ connectorCapabilities: [] });

    await expect(resolve()).resolves.toBeUndefined();
  });

  it("raises only the safe runtime configuration error for malformed persisted state", async () => {
    await replaceCurrentDescriptor({ malformed: true });

    const attempt = resolve();
    await expect(attempt).rejects.toBeInstanceOf(
      RuntimeConnectorConfigurationError,
    );
    await attempt.catch((error: unknown) => {
      expect(error).toMatchObject({
        code: "runtime.connectorConfigurationUnavailable",
        message: "Runtime connector configuration is unavailable.",
      });
      expect(String(error)).not.toContain("vault://runtime-credential");
      expect(String(error)).not.toContain("current.example");
    });
  });

  it("exposes the private resolver through the persistence facade while safe administration reads remain metadata-only", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      await expect(
        persistence.runtimeConnectorConfigurationResolver.resolve({
          workspaceId: "workspace-a",
          connectorRegistrationId: "connector-a",
          requiredCapability: "knowledgeSource",
        }),
      ).resolves.toMatchObject({
        configurationVersionId: "connector-version-current",
        settings: { endpoint: "https://current.example" },
        secretReferences: [{ locator: "vault://runtime-credential" }],
      });
      await expect(
        persistence.runtimeConnectorConfigurationResolver.resolve({
          workspaceId: "workspace-a",
          connectorRegistrationId: "connector-a",
          configurationVersionId: "missing-immutable-version",
          requiredCapability: "knowledgeSource",
        }),
      ).resolves.toBeUndefined();

      const inspection =
        await persistence.administrationResourceReadStore.configurationInspection(
          {
            workspaceId: "workspace-a",
            configurationId: "connector-a",
          },
        );
      expect(inspection).toMatchObject({
        id: "connector-a",
        currentVersion: {
          id: "connector-version-current",
          secretReferenceCount: 1,
        },
      });
      expect(JSON.stringify(inspection)).not.toContain("current.example");
      expect(JSON.stringify(inspection)).not.toContain(
        "vault://runtime-credential",
      );
    } finally {
      await persistence.close();
    }
  });
});

function resolve(
  overrides: Readonly<{
    readonly workspaceId?: string;
    readonly configurationVersionId?: string;
  }> = {},
) {
  return resolver.resolve({
    workspaceId: overrides.workspaceId ?? "workspace-a",
    connectorRegistrationId: "connector-a",
    ...(overrides.configurationVersionId === undefined
      ? {}
      : { configurationVersionId: overrides.configurationVersionId }),
    requiredCapability: "knowledgeSource",
  });
}

async function seed(): Promise<void> {
  const descriptor = connectorDescriptor({
    connectorCapabilities: ["knowledgeSource"],
  });
  await pool.query(
    "INSERT INTO workspaces (id) VALUES ('workspace-a'), ('workspace-b')",
  );
  await pool.query(
    `INSERT INTO connector_registrations (id, workspace_id, lifecycle)
     VALUES ('connector-a', 'workspace-a', 'active')`,
  );
  await pool.query(
    `INSERT INTO connector_capabilities (workspace_id, connector_registration_id, capability)
     VALUES ('workspace-a', 'connector-a', 'knowledgeSource')`,
  );
  await pool.query(
    `INSERT INTO credential_registrations (id, workspace_id, secret_reference, lifecycle)
     VALUES ('credential-a', 'workspace-a', 'vault://runtime-credential', 'active')`,
  );
  await pool.query(
    `INSERT INTO administration_descriptor_revisions (
       kind, type, version, descriptor, descriptor_hash
     ) VALUES ('connector', 'test-connector', 'v1', $1::jsonb, repeat('a', 64))`,
    [JSON.stringify(descriptor)],
  );
  await pool.query(
    `INSERT INTO administration_configurations (
       id, workspace_id, resource_type, lifecycle, revision
     ) VALUES ('connector-a', 'workspace-a', 'connector-instances', 'active', 2)`,
  );
  await insertVersion({
    id: "connector-version-previous",
    version: 1,
    endpoint: "https://previous.example",
  });
  await insertVersion({
    id: "connector-version-current",
    version: 2,
    endpoint: "https://current.example",
  });
  await pool.query(
    `UPDATE administration_configurations
     SET current_version_id = 'connector-version-current'
     WHERE workspace_id = 'workspace-a' AND id = 'connector-a'`,
  );
}

async function insertVersion(
  input: Readonly<{
    readonly id: string;
    readonly version: number;
    readonly endpoint: string;
    readonly descriptorType?: string;
    readonly descriptorVersion?: string;
  }>,
): Promise<void> {
  await pool.query(
    `INSERT INTO administration_configuration_versions (
       id, workspace_id, configuration_id, version, settings, secret_references,
       descriptor_kind, descriptor_type, descriptor_version
     ) VALUES (
       $1, 'workspace-a', 'connector-a', $2, $3::jsonb, $4::jsonb,
       'connector', $5, $6
     )`,
    [
      input.id,
      input.version,
      JSON.stringify({ endpoint: input.endpoint }),
      JSON.stringify(["vault://runtime-credential"]),
      input.descriptorType ?? "test-connector",
      input.descriptorVersion ?? "v1",
    ],
  );
}

async function replaceCurrentDescriptor(
  input:
    | Readonly<{ readonly connectorCapabilities: readonly string[] }>
    | Readonly<{ readonly malformed: true }>,
): Promise<void> {
  const descriptorType =
    "malformed" in input
      ? "test-connector-malformed"
      : "test-connector-no-capability";
  const descriptor =
    "malformed" in input
      ? { invalid: true }
      : connectorDescriptor({
          type: descriptorType,
          connectorCapabilities: input.connectorCapabilities,
        });
  await pool.query(
    `INSERT INTO administration_descriptor_revisions (
       kind, type, version, descriptor, descriptor_hash
     ) VALUES ('connector', $1, 'v1', $2::jsonb, repeat('b', 64))`,
    [descriptorType, JSON.stringify(descriptor)],
  );
  await insertVersion({
    id: `connector-version-${descriptorType}`,
    version: 3,
    endpoint: "https://replacement.example",
    descriptorType,
  });
  await pool.query(
    `UPDATE administration_configurations
     SET current_version_id = $1
     WHERE workspace_id = 'workspace-a' AND id = 'connector-a'`,
    [`connector-version-${descriptorType}`],
  );
}

function connectorDescriptor(input: {
  readonly type?: string;
  readonly connectorCapabilities: readonly string[];
}) {
  return {
    kind: "connector",
    type: input.type ?? "test-connector",
    version: "v1",
    displayName: "Test connector",
    description: "A test-only connector descriptor.",
    connectorCapabilities: input.connectorCapabilities,
    aiCapabilities: [],
    supportedWireApis: [],
    supportedWebhookEventTypes: [],
    settingsSchema: {
      type: "object",
      properties: { endpoint: { type: "string" } },
      required: ["endpoint"],
      additionalProperties: false,
    },
    uiGroups: [],
    secretSlots: [],
    supportsConfigurationMigration: false,
    supportedTestOperations: [],
  };
}
