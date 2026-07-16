import { resolvePrices } from "@caseweaver/ai-config";
import { AiCapabilityError, AiConfigurationError } from "@caseweaver/ai-sdk";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresAiBindingResolver } from "./postgres-ai-binding-resolver.js";

const databaseUrl = process.env.DATABASE_URL;
if (
  databaseUrl === undefined ||
  !new URL(databaseUrl).pathname.toLowerCase().includes("test")
) {
  throw new Error(
    "AI binding resolver integration tests require a disposable test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});
const resolver = new PostgresAiBindingResolver(client);

const workspaceId = "binding-resolver-workspace-a";
const bindingVersionId = "binding-resolver-binding:1";

beforeEach(async () => {
  await pool.query(
    `TRUNCATE TABLE
      ai_price_override_components,
      ai_binding_price_overrides,
      ai_workspace_price_overrides,
      ai_installation_price_overrides,
      ai_catalog_snapshots,
      workspaces
    RESTART IDENTITY CASCADE`,
  );
  await seedConfiguration();
});

afterAll(async () => {
  await client.$disconnect();
  await pool.end();
});

describe("PostgresAiBindingResolver", () => {
  it("resolves an active workspace default with all immutable price scopes", async () => {
    const binding = await resolver.resolve({
      workspaceId,
      role: "analysis",
      requiredCapabilities: ["structuredOutput"],
      inputTokens: 100,
      outputTokens: 50,
    });

    expect(binding).toMatchObject({
      workspaceId,
      bindingId: "binding-resolver-binding",
      bindingVersionId,
      providerInstanceVersionId: "binding-resolver-provider-version",
      providerType: "test-provider",
      canonicalModel: "test-model",
      secretReference: "opaque:credential-reference",
    });
    expect(binding.pricing.catalogComponents).toMatchObject([
      { id: "catalog-price", amount: "0.001" },
    ]);
    expect(binding.pricing.installationOverrides).toMatchObject([
      { id: "installation-price", amount: "0.002" },
    ]);
    expect(binding.pricing.workspaceOverrides).toMatchObject([
      { id: "workspace-price", amount: "0.003" },
    ]);
    expect(binding.pricing.bindingOverrides).toMatchObject([
      { id: "binding-price", amount: "0.004" },
    ]);
    expect(
      resolvePrices(binding.pricing, ["input"], {
        at: "2026-07-15T12:00:00.000Z",
        currency: "USD",
      }),
    ).toMatchObject({
      status: "known",
      components: [{ component: { id: "binding-price" } }],
    });
  });

  it("enforces the immutable binding role, capability, and token bounds", async () => {
    await expect(
      resolver.resolve({
        workspaceId,
        role: "chat",
        bindingVersionId,
      }),
    ).rejects.toBeInstanceOf(AiCapabilityError);
    await expect(
      resolver.resolve({
        workspaceId,
        role: "analysis",
        requiredCapabilities: ["tools"],
      }),
    ).rejects.toBeInstanceOf(AiCapabilityError);
    await expect(
      resolver.resolve({
        workspaceId,
        role: "analysis",
        inputTokens: 101,
      }),
    ).rejects.toBeInstanceOf(AiCapabilityError);
  });

  it("resolves a retained explicitly pinned version after the default rotates", async () => {
    await pool.query(
      `INSERT INTO ai_model_binding_versions (
        id, workspace_id, model_binding_id, version, provider_instance_version_id,
        catalog_snapshot_id, catalog_model_id, canonical_model, wire_api,
        parameters, capabilities, maximum_input_tokens, maximum_output_tokens,
        secret_reference
      ) VALUES (
        'binding-resolver-binding:2', $1, 'binding-resolver-binding', 2,
        'binding-resolver-provider-version', 'binding-resolver-snapshot',
        'binding-resolver-model', 'test-model', 'chatCompletions', '{}'::jsonb,
        '["structuredOutput"]'::jsonb, 100, 50, 'opaque:credential-reference'
      )`,
      [workspaceId],
    );
    await pool.query(
      `UPDATE ai_model_bindings
       SET active_version_id = 'binding-resolver-binding:2'
       WHERE workspace_id = $1 AND id = 'binding-resolver-binding'`,
      [workspaceId],
    );
    await pool.query(
      `UPDATE ai_workspace_binding_defaults
       SET model_binding_version_id = 'binding-resolver-binding:2'
       WHERE workspace_id = $1 AND role = 'analysis'`,
      [workspaceId],
    );

    await expect(
      resolver.resolve({
        workspaceId,
        role: "analysis",
        bindingVersionId,
        requiredCapabilities: ["structuredOutput"],
      }),
    ).resolves.toMatchObject({ bindingVersionId });
    await expect(
      resolver.resolve({
        workspaceId,
        role: "analysis",
        requiredCapabilities: ["structuredOutput"],
      }),
    ).resolves.toMatchObject({
      bindingVersionId: "binding-resolver-binding:2",
    });
  });

  it("fails closed for another workspace, inactive providers or bindings, and revoked credentials", async () => {
    await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [
      "binding-resolver-workspace-b",
    ]);
    await expect(
      resolver.resolve({
        workspaceId: "binding-resolver-workspace-b",
        role: "analysis",
        bindingVersionId,
      }),
    ).rejects.toBeInstanceOf(AiConfigurationError);

    await pool.query(
      `UPDATE credential_registrations
       SET lifecycle = 'revoked'
       WHERE workspace_id = $1`,
      [workspaceId],
    );
    await expect(
      resolver.resolve({ workspaceId, role: "analysis" }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AiConfigurationError &&
        !error.message.includes("opaque:credential-reference"),
    );

    await pool.query(
      `UPDATE credential_registrations
       SET lifecycle = 'active'
       WHERE workspace_id = $1`,
      [workspaceId],
    );
    await pool.query(
      `UPDATE ai_provider_instances
       SET lifecycle = 'disabled'
       WHERE workspace_id = $1`,
      [workspaceId],
    );
    await expect(
      resolver.resolve({ workspaceId, role: "analysis" }),
    ).rejects.toBeInstanceOf(AiConfigurationError);

    await pool.query(
      `UPDATE ai_provider_instances
       SET lifecycle = 'active'
       WHERE workspace_id = $1`,
      [workspaceId],
    );
    await pool.query(
      `UPDATE ai_model_bindings
       SET lifecycle = 'disabled'
       WHERE workspace_id = $1`,
      [workspaceId],
    );
    await expect(
      resolver.resolve({ workspaceId, role: "analysis" }),
    ).rejects.toBeInstanceOf(AiConfigurationError);

    await pool.query(
      `UPDATE ai_model_bindings
       SET lifecycle = 'active', active_version_id = NULL
       WHERE workspace_id = $1`,
      [workspaceId],
    );
    await expect(
      resolver.resolve({ workspaceId, role: "analysis" }),
    ).rejects.toBeInstanceOf(AiConfigurationError);
  });
});

async function seedConfiguration(): Promise<void> {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("INSERT INTO workspaces (id) VALUES ($1)", [
      workspaceId,
    ]);
    await connection.query(
      `INSERT INTO credential_registrations (
        id, workspace_id, secret_reference, lifecycle
      ) VALUES (
        'binding-resolver-credential', $1, 'opaque:credential-reference', 'active'
      )`,
      [workspaceId],
    );
    await connection.query(`
      INSERT INTO ai_catalog_snapshots (
        id, upstream_url, upstream_commit_sha, fetched_at, sha256, raw_entries
      ) VALUES (
        'binding-resolver-snapshot', 'https://catalog.example/models.json',
        '1234567', '2026-07-15T12:00:00.000Z', repeat('a', 64), '{}'::jsonb
      )
    `);
    await connection.query(`
      INSERT INTO ai_catalog_models (
        id, catalog_snapshot_id, canonical_model, provider, supported_roles,
        capabilities, maximum_input_tokens, maximum_output_tokens, raw_entry
      ) VALUES (
        'binding-resolver-model', 'binding-resolver-snapshot', 'test-model',
        'test-provider', '["analysis"]'::jsonb, '["structuredOutput"]'::jsonb,
        200, 100, '{}'::jsonb
      )
    `);
    await connection.query(`
      INSERT INTO ai_catalog_price_components (
        id, catalog_model_id, component_kind, billing_unit, amount, currency,
        effective_from, conditions, source_revision, raw_entry
      ) VALUES (
        'catalog-price', 'binding-resolver-model', 'input', 'token', 0.001,
        'USD', '2026-01-01T00:00:00.000Z', '{}'::jsonb, 'catalog-revision',
        '{}'::jsonb
      )
    `);
    await connection.query(
      `INSERT INTO ai_provider_instances (id, workspace_id, provider_type, lifecycle)
       VALUES ('binding-resolver-provider', $1, 'test-provider', 'active')`,
      [workspaceId],
    );
    await connection.query(
      `INSERT INTO ai_provider_instance_versions (
        id, workspace_id, provider_instance_id, version, endpoint, wire_api,
        parameters, secret_reference
      ) VALUES (
        'binding-resolver-provider-version', $1, 'binding-resolver-provider', 1,
        'https://provider.example.test', 'chatCompletions', '{}'::jsonb,
        'opaque:credential-reference'
      )`,
      [workspaceId],
    );
    await connection.query(
      `INSERT INTO ai_model_bindings (id, workspace_id, role, lifecycle)
       VALUES ('binding-resolver-binding', $1, 'analysis', 'active')`,
      [workspaceId],
    );
    await connection.query(
      `INSERT INTO ai_model_binding_versions (
        id, workspace_id, model_binding_id, version, provider_instance_version_id,
        catalog_snapshot_id, catalog_model_id, canonical_model, wire_api,
        parameters, capabilities, maximum_input_tokens, maximum_output_tokens,
        secret_reference
      ) VALUES (
        $1, $2, 'binding-resolver-binding', 1,
        'binding-resolver-provider-version', 'binding-resolver-snapshot',
        'binding-resolver-model', 'test-model', 'chatCompletions', '{}'::jsonb,
        '["structuredOutput"]'::jsonb, 100, 50, 'opaque:credential-reference'
      )`,
      [bindingVersionId, workspaceId],
    );
    await connection.query(
      `UPDATE ai_model_bindings
       SET active_version_id = $1
       WHERE workspace_id = $2 AND id = 'binding-resolver-binding'`,
      [bindingVersionId, workspaceId],
    );
    await connection.query(
      `INSERT INTO ai_workspace_binding_defaults (
        workspace_id, role, model_binding_version_id
      ) VALUES ($1, 'analysis', $2)`,
      [workspaceId, bindingVersionId],
    );
    await seedInstallationOverride(connection);
    await seedWorkspaceOverride(connection);
    await seedBindingOverride(connection);
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function seedInstallationOverride(connection: PoolClient): Promise<void> {
  await connection.query(`
    INSERT INTO ai_installation_price_overrides (
      id, provider, canonical_model, source, effective_from
    ) VALUES (
      'installation-override', 'test-provider', 'test-model', 'operator',
      '2026-01-01T00:00:00.000Z'
    )
  `);
  await connection.query(`
    INSERT INTO ai_price_override_components (
      id, installation_price_override_id, component_kind, billing_unit, amount,
      currency, conditions, raw_entry
    ) VALUES (
      'installation-price', 'installation-override', 'input', 'token', 0.002,
      'USD', '{}'::jsonb, '{}'::jsonb
    )
  `);
}

async function seedWorkspaceOverride(connection: PoolClient): Promise<void> {
  await connection.query(
    `INSERT INTO ai_workspace_price_overrides (
      id, workspace_id, provider, canonical_model, source, effective_from
    ) VALUES (
      'workspace-override', $1, 'test-provider', 'test-model', 'operator',
      '2026-01-01T00:00:00.000Z'
    )`,
    [workspaceId],
  );
  await connection.query(
    `INSERT INTO ai_price_override_components (
      id, workspace_id, workspace_price_override_id, component_kind,
      billing_unit, amount, currency, conditions, raw_entry
    ) VALUES (
      'workspace-price', $1, 'workspace-override', 'input', 'token', 0.003,
      'USD', '{}'::jsonb, '{}'::jsonb
    )`,
    [workspaceId],
  );
}

async function seedBindingOverride(connection: PoolClient): Promise<void> {
  await connection.query(
    `INSERT INTO ai_binding_price_overrides (
      id, workspace_id, model_binding_version_id, source, effective_from
    ) VALUES (
      'binding-override', $1, $2, 'operator', '2026-01-01T00:00:00.000Z'
    )`,
    [workspaceId, bindingVersionId],
  );
  await connection.query(
    `INSERT INTO ai_price_override_components (
      id, workspace_id, binding_price_override_id, component_kind, billing_unit,
      amount, currency, conditions, raw_entry
    ) VALUES (
      'binding-price', $1, 'binding-override', 'input', 'token', 0.004, 'USD',
      '{}'::jsonb, '{}'::jsonb
    )`,
    [workspaceId],
  );
}
