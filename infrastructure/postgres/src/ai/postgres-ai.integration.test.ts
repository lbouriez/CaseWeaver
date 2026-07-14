import {
  createImmutableBinding,
  decimal,
  type PriceComponent,
} from "@caseweaver/ai-config";
import { DefaultAiExecutionGateway } from "@caseweaver/ai-execution";
import {
  AiProviderError,
  DeterministicAiProviderDispatcher,
} from "@caseweaver/ai-sdk";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPostgresAiPersistence,
  PostgresAiHardBudgetError,
} from "./index.js";

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
const persistence = createPostgresAiPersistence({ databaseUrl });

async function resetAi(): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      ai_budget_reservations,
      ai_operation_usage,
      ai_operation_costs,
      ai_operations,
      ai_budget_balances,
      ai_budget_policies,
      ai_price_override_components,
      ai_binding_price_overrides,
      ai_workspace_price_overrides,
      ai_installation_price_overrides,
      ai_workspace_binding_defaults,
      ai_model_binding_versions,
      ai_model_bindings,
      ai_provider_instance_versions,
      ai_provider_instances,
      ai_catalog_price_components,
      ai_catalog_models,
      ai_catalog_snapshots
    RESTART IDENTITY CASCADE
  `);
  await pool.query("DELETE FROM workspaces WHERE id LIKE 'ai-workspace-%'");
}

async function seedConfiguration(
  workspaceId = "ai-workspace-a",
): Promise<void> {
  await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [workspaceId]);
  await pool.query(
    `INSERT INTO ai_catalog_snapshots (
      id, upstream_url, upstream_commit_sha, fetched_at, sha256, raw_entries
    ) VALUES (
      'ai-snapshot', 'https://catalog.example/prices.json', 'abcdef0', now(),
      repeat('a', 64), '{}'::jsonb
    )`,
  );
  await pool.query(
    `INSERT INTO ai_catalog_models (
      id, catalog_snapshot_id, canonical_model, provider, supported_roles,
      capabilities, raw_entry
    ) VALUES (
      'ai-model', 'ai-snapshot', 'model-1', 'fake', '["analysis"]'::jsonb,
      '[]'::jsonb, '{}'::jsonb
    )`,
  );
  await pool.query(
    `INSERT INTO ai_provider_instances (
      id, workspace_id, provider_type, lifecycle
    ) VALUES ('ai-provider', $1, 'fake', 'active')`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO ai_provider_instance_versions (
      id, workspace_id, provider_instance_id, version, endpoint, wire_api,
      parameters, secret_reference
    ) VALUES (
      'ai-provider-version', $1, 'ai-provider', 1, 'https://fake.example',
      'chatCompletions', '{}'::jsonb, 'vault:fake'
    )`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO ai_model_bindings (id, workspace_id, role, lifecycle)
     VALUES ('ai-binding', $1, 'analysis', 'active')`,
    [workspaceId],
  );
  await pool.query(
    `INSERT INTO ai_model_binding_versions (
      id, workspace_id, model_binding_id, version, provider_instance_version_id,
      catalog_snapshot_id, catalog_model_id, canonical_model, wire_api,
      parameters, capabilities, secret_reference
    ) VALUES (
      'ai-binding:1', $1, 'ai-binding', 1, 'ai-provider-version',
      'ai-snapshot', 'ai-model', 'model-1', 'chatCompletions',
      '{}'::jsonb, '[]'::jsonb, 'vault:fake'
    )`,
    [workspaceId],
  );
}

async function start(operationId: string, workspaceId = "ai-workspace-a") {
  await persistence.unitOfWork.transaction((transaction) =>
    persistence.ledger.start(transaction, {
      operationId,
      workspaceId,
      role: "analysis",
      operationKind: "generation",
      bindingVersionId: "ai-binding:1",
      providerInstanceVersionId: "ai-provider-version",
      catalogSnapshotId: "ai-snapshot",
      configuredModel: "model-1",
      startedAt: "2026-07-13T19:00:00.000Z",
      pricing: { status: "known", components: [] },
      reservation: {
        status: "known",
        amount: decimal("0.75"),
        currency: "USD",
        components: [],
      },
    }),
  );
}

async function reserve(
  operationId: string,
  amount = "0.75",
  workspaceId = "ai-workspace-a",
  scope: {
    readonly analysisId?: string;
    readonly day?: string;
  } = {},
) {
  return persistence.unitOfWork.transaction((transaction) =>
    persistence.budget.reserve(transaction, {
      operationId,
      workspaceId,
      scope: {
        operationId,
        ...(scope.analysisId === undefined
          ? {}
          : { analysisId: scope.analysisId }),
        day: scope.day ?? "2026-07-13",
        workspace: "all",
      },
      currency: "USD",
      estimatedAmount: decimal(amount),
      calculationStatus: "known",
      hard: true,
      unknownPriceBypass: false,
      occurredAt: "2026-07-13T19:00:00.000Z",
    }),
  );
}

async function reconcile(
  operationId: string,
  status: "reconciled" | "released" | "retainedUncertain" | "providerOverage",
  actualAmount?: string,
) {
  await persistence.unitOfWork.transaction((transaction) =>
    persistence.budget.reconcile(transaction, {
      operationId,
      workspaceId: "ai-workspace-a",
      currency: "USD",
      status,
      actualAmount:
        actualAmount === undefined ? undefined : decimal(actualAmount),
      occurredAt: "2026-07-13T19:01:00.000Z",
    }),
  );
}

function gatewayBinding(role: "analysis" | "repositoryAgent" = "analysis") {
  const input: PriceComponent = {
    id: "gateway-input",
    kind: "input",
    unit: "token",
    amount: decimal("0.001"),
    currency: "USD",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    sourceId: "ai-snapshot",
    conditions: {},
  };
  return createImmutableBinding({
    workspaceId: "ai-workspace-a",
    bindingId: "ai-binding",
    version: 1,
    role,
    providerInstanceVersionId: "ai-provider-version",
    providerType: "fake",
    endpoint: "https://fake.example",
    canonicalModel: "model-1",
    wireApi: "chatCompletions",
    secretReference: "vault:fake",
    maximumInputTokens: 10,
    maximumOutputTokens: 5,
    catalogModel: {
      id: "ai-model",
      snapshotId: "ai-snapshot",
      canonicalModel: "model-1",
      provider: "fake",
      supportedRoles: new Set([role]),
      capabilities:
        role === "repositoryAgent" ? new Set(["repositoryAgent"]) : new Set(),
      maximumInputTokens: 10,
      maximumOutputTokens: 5,
      priceComponents: [
        input,
        {
          ...input,
          id: "gateway-output",
          kind: "output",
          amount: decimal("0.002"),
        },
      ],
      rawEntry: {},
    },
  });
}

beforeEach(async () => resetAi());
afterAll(async () => {
  await persistence.close();
  await pool.end();
});

describe("PBI-003 PostgreSQL AI ledger and budget repository", () => {
  it("migrates the catalog, binding, ledger, and budget tables", async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name IN (
         'ai_catalog_snapshots', 'ai_model_binding_versions',
         'ai_operations', 'ai_budget_reservations'
       )`,
    );
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
      "ai_budget_reservations",
      "ai_catalog_snapshots",
      "ai_model_binding_versions",
      "ai_operations",
    ]);
  });

  it("persists observable repository-agent turns under one parent budget operation", async () => {
    await seedConfiguration();
    await pool.query(
      `INSERT INTO ai_budget_policies (
        id, workspace_id, scope, scope_key, limit_amount, currency, hard
      ) VALUES (
        'repository-agent-policy', 'ai-workspace-a', 'workspace', 'all', 10, 'USD', true
      )`,
    );
    const operationIds = [
      "repository-agent-parent",
      "repository-agent-turn-1",
      "repository-agent-turn-2",
    ];
    const gateway = new DefaultAiExecutionGateway({
      bindingResolver: {
        resolve: async () => gatewayBinding("repositoryAgent"),
      },
      providerDispatcher: new DeterministicAiProviderDispatcher({
        runRepositoryAgent: async () => ({
          value: {
            summary: "The configured source handles the error.",
            metering: {
              mode: "observableTurns",
              turns: [
                { turn: 1, usage: { inputTokens: 2, outputTokens: 1 } },
                { turn: 2, usage: { inputTokens: 3, outputTokens: 1 } },
              ],
            },
          },
          metadata: { retryCount: 0 },
        }),
      }),
      secretResolver: { resolve: async () => ({ value: "secret" }) },
      unitOfWork: persistence.unitOfWork,
      ledger: persistence.ledger,
      budget: persistence.budget,
      operationIds: {
        next: () => {
          const operationId = operationIds.shift();
          if (operationId === undefined)
            throw new Error("Unexpected operation");
          return operationId;
        },
      },
      clock: { now: () => "2026-07-13T19:00:00.000Z" },
    });

    await expect(
      gateway.execute(
        {
          kind: "repositoryAgent",
          role: "repositoryAgent",
          request: {
            instruction: "Inspect the configured pinned repository.",
            maximumTurns: 2,
            maximumInputTokensPerTurn: 10,
            maximumOutputTokensPerTurn: 5,
          },
          budget: { currency: "USD", hard: true },
        },
        {
          workspaceId: "ai-workspace-a",
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toMatchObject({
      operationId: "repository-agent-parent",
      calculatedCost: { status: "known", amount: "0.009", currency: "USD" },
    });

    const operations = await pool.query<{
      id: string;
      parent_operation_id: string | null;
      operation_kind: string;
      status: string;
    }>(
      `SELECT id, parent_operation_id, operation_kind, status
       FROM ai_operations
       WHERE id LIKE 'repository-agent-%'
       ORDER BY id`,
    );
    expect(operations.rows).toEqual([
      {
        id: "repository-agent-parent",
        parent_operation_id: null,
        operation_kind: "repositoryAgent",
        status: "succeeded",
      },
      {
        id: "repository-agent-turn-1",
        parent_operation_id: "repository-agent-parent",
        operation_kind: "repositoryAgentTurn",
        status: "succeeded",
      },
      {
        id: "repository-agent-turn-2",
        parent_operation_id: "repository-agent-parent",
        operation_kind: "repositoryAgentTurn",
        status: "succeeded",
      },
    ]);
    const reservations = await pool.query<{
      operation_id: string;
      status: string;
    }>(
      `SELECT operation_id, status FROM ai_budget_reservations
       WHERE operation_id LIKE 'repository-agent-%'`,
    );
    expect(reservations.rows).toEqual([
      { operation_id: "repository-agent-parent", status: "reconciled" },
    ]);
    const childCosts = await pool.query<{
      operation_id: string;
      calculated_amount: string;
    }>(
      `SELECT operation_id, calculated_amount FROM ai_operation_costs
       WHERE operation_id LIKE 'repository-agent-turn-%'
       ORDER BY operation_id`,
    );
    expect(childCosts.rows).toEqual([
      {
        operation_id: "repository-agent-turn-1",
        calculated_amount: "0.004000000000000000",
      },
      {
        operation_id: "repository-agent-turn-2",
        calculated_amount: "0.005000000000000000",
      },
    ]);
  });

  it("enforces composite workspace ownership for immutable provider versions", async () => {
    await seedConfiguration();
    await pool.query("INSERT INTO workspaces (id) VALUES ('ai-workspace-b')");
    await expect(
      pool.query(
        `INSERT INTO ai_provider_instance_versions (
          id, workspace_id, provider_instance_id, version, endpoint, wire_api,
          parameters, secret_reference
        ) VALUES (
          'cross-workspace-provider-version', 'ai-workspace-b', 'ai-provider',
          1, 'https://fake.example', 'chatCompletions', '{}'::jsonb, 'vault:fake'
        )`,
      ),
    ).rejects.toThrow();
  });

  it("atomically rejects one of concurrent hard-budget reservations", async () => {
    await seedConfiguration();
    await pool.query(
      `INSERT INTO ai_budget_policies (
        id, workspace_id, scope, scope_key, limit_amount, currency, hard
      ) VALUES ('ai-policy', 'ai-workspace-a', 'workspace', 'all', 1, 'USD', true)`,
    );
    await Promise.all([start("ai-operation-one"), start("ai-operation-two")]);

    const results = await Promise.allSettled([
      reserve("ai-operation-one"),
      reserve("ai-operation-two"),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(
      rejected?.status === "rejected" ? rejected.reason : undefined,
    ).toBeInstanceOf(PostgresAiHardBudgetError);
    const balance = await pool.query<{
      reserved_amount: string;
      spent_amount: string;
    }>("SELECT reserved_amount, spent_amount FROM ai_budget_balances");
    expect(balance.rows).toEqual([
      {
        reserved_amount: "0.750000000000000000",
        spent_amount: "0.000000000000000000",
      },
    ]);
  });

  it("records a reservation above a soft-policy limit without blocking execution", async () => {
    await seedConfiguration();
    await pool.query(
      `INSERT INTO ai_budget_policies (
        id, workspace_id, scope, scope_key, limit_amount, currency, hard
      ) VALUES ('ai-soft-policy', 'ai-workspace-a', 'workspace', 'all', 0.5, 'USD', false)`,
    );
    await start("ai-operation-soft-policy");

    await expect(reserve("ai-operation-soft-policy")).resolves.toBeUndefined();

    const balance = await pool.query<{
      reserved_amount: string;
      spent_amount: string;
    }>("SELECT reserved_amount, spent_amount FROM ai_budget_balances");
    expect(balance.rows).toEqual([
      {
        reserved_amount: "0.750000000000000000",
        spent_amount: "0.000000000000000000",
      },
    ]);
  });

  it("reserves only policies whose canonical scope key applies", async () => {
    await seedConfiguration();
    await pool.query(
      `INSERT INTO ai_budget_policies (
        id, workspace_id, scope, scope_key, limit_amount, currency, hard
      ) VALUES
        ('scope-operation', 'ai-workspace-a', 'operation', 'ai-operation-scoped', 10, 'USD', true),
        ('scope-analysis', 'ai-workspace-a', 'analysis', 'analysis-opaque-id', 10, 'USD', true),
        ('scope-day', 'ai-workspace-a', 'day', '2026-07-13', 10, 'USD', true),
        ('scope-workspace', 'ai-workspace-a', 'workspace', 'all', 10, 'USD', true),
        ('scope-other-operation', 'ai-workspace-a', 'operation', 'other-operation', 10, 'USD', true),
        ('scope-other-day', 'ai-workspace-a', 'day', '2026-07-14', 10, 'USD', true),
        ('scope-foreign-other', 'ai-workspace-a', 'operation', 'other-operation', 10, 'EUR', true)`,
    );
    await start("ai-operation-scoped");
    await reserve("ai-operation-scoped", "0.25", "ai-workspace-a", {
      analysisId: "analysis-opaque-id",
    });

    const balances = await pool.query<{ budget_policy_id: string }>(
      `SELECT budget_policy_id FROM ai_budget_balances
       ORDER BY budget_policy_id`,
    );
    expect(balances.rows).toEqual([
      { budget_policy_id: "scope-analysis" },
      { budget_policy_id: "scope-day" },
      { budget_policy_id: "scope-operation" },
      { budget_policy_id: "scope-workspace" },
    ]);
  });

  it("reconciles actual cost, releases unused reservations, and retains ambiguity", async () => {
    await seedConfiguration();
    await pool.query(
      `INSERT INTO ai_budget_policies (
        id, workspace_id, scope, scope_key, limit_amount, currency, hard
      ) VALUES ('ai-policy', 'ai-workspace-a', 'workspace', 'all', 10, 'USD', true)`,
    );
    await start("ai-operation-reconcile");
    await reserve("ai-operation-reconcile");
    await reconcile("ai-operation-reconcile", "reconciled", "0.2");

    await start("ai-operation-release");
    await reserve("ai-operation-release");
    await reconcile("ai-operation-release", "released");

    await start("ai-operation-retained");
    await reserve("ai-operation-retained");
    await reconcile("ai-operation-retained", "retainedUncertain");

    const balance = await pool.query<{
      reserved_amount: string;
      spent_amount: string;
    }>("SELECT reserved_amount, spent_amount FROM ai_budget_balances");
    expect(balance.rows).toEqual([
      {
        reserved_amount: "0.750000000000000000",
        spent_amount: "0.200000000000000000",
      },
    ]);
    const statuses = await pool.query<{
      status: string;
      over_reservation_amount: string | null;
    }>(
      "SELECT status, over_reservation_amount FROM ai_budget_reservations ORDER BY operation_id",
    );
    expect(statuses.rows).toEqual([
      { status: "reconciled", over_reservation_amount: "0.550000000000000000" },
      { status: "released", over_reservation_amount: "0.750000000000000000" },
      { status: "retainedUncertain", over_reservation_amount: null },
    ]);
  });

  it("durably separates missing usage, timeout, cancellation, and provider overage", async () => {
    await seedConfiguration();
    await pool.query(
      `INSERT INTO ai_budget_policies (
        id, workspace_id, scope, scope_key, limit_amount, currency, hard
      ) VALUES ('ai-policy', 'ai-workspace-a', 'workspace', 'all', 10, 'USD', true)`,
    );
    for (const operationId of [
      "ai-operation-missing",
      "ai-operation-timeout",
      "ai-operation-cancelled",
      "ai-operation-overage",
      "ai-operation-foreign",
    ]) {
      await start(operationId);
      await reserve(operationId);
    }
    await persistence.unitOfWork.transaction(async (transaction) => {
      await persistence.ledger.finalize(transaction, {
        operationId: "ai-operation-missing",
        workspaceId: "ai-workspace-a",
        status: "succeededUsageUnknown",
        finishedAt: "2026-07-13T19:01:00.000Z",
        calculatedCost: { status: "unknown", components: [] },
      });
      await persistence.ledger.finalize(transaction, {
        operationId: "ai-operation-timeout",
        workspaceId: "ai-workspace-a",
        status: "timedOut",
        finishedAt: "2026-07-13T19:01:00.000Z",
        calculatedCost: { status: "unknown", components: [] },
        error: { code: "ai.timeout", retryable: true },
      });
      await persistence.ledger.finalize(transaction, {
        operationId: "ai-operation-cancelled",
        workspaceId: "ai-workspace-a",
        status: "cancelled",
        finishedAt: "2026-07-13T19:01:00.000Z",
        calculatedCost: { status: "unknown", components: [] },
        error: { code: "ai.cancelled", retryable: false },
      });
      await persistence.ledger.finalize(transaction, {
        operationId: "ai-operation-overage",
        workspaceId: "ai-workspace-a",
        status: "succeeded",
        finishedAt: "2026-07-13T19:01:00.000Z",
        usage: { inputTokens: 1, outputTokens: 1 },
        calculatedCost: {
          status: "known",
          amount: decimal("1.5"),
          currency: "USD",
          components: [],
        },
        providerCost: { amount: "2", currency: "USD" },
      });
      await persistence.ledger.finalize(transaction, {
        operationId: "ai-operation-foreign",
        workspaceId: "ai-workspace-a",
        status: "succeeded",
        finishedAt: "2026-07-13T19:01:00.000Z",
        usage: { inputTokens: 1 },
        calculatedCost: {
          status: "known",
          amount: decimal("0.2"),
          currency: "USD",
          components: [],
        },
        providerCost: { amount: "1", currency: "EUR" },
      });
    });
    await reconcile("ai-operation-missing", "retainedUncertain");
    await reconcile("ai-operation-timeout", "retainedUncertain");
    await reconcile("ai-operation-cancelled", "retainedUncertain");
    await reconcile("ai-operation-overage", "providerOverage", "2");
    await reconcile("ai-operation-foreign", "reconciled", "0.2");

    const operations = await pool.query<{
      status: string;
      error_code: string | null;
    }>("SELECT status, error_code FROM ai_operations ORDER BY id");
    expect(operations.rows).toContainEqual({
      status: "timedOut",
      error_code: "ai.timeout",
    });
    expect(operations.rows).toContainEqual({
      status: "cancelled",
      error_code: "ai.cancelled",
    });
    const costs = await pool.query<{
      provider_reported_amount: string | null;
      calculated_amount: string | null;
      provider_currency_status: string;
    }>(
      `SELECT provider_reported_amount, calculated_amount, provider_currency_status
       FROM ai_operation_costs WHERE operation_id = 'ai-operation-overage'`,
    );
    expect(costs.rows).toEqual([
      {
        provider_reported_amount: "2.000000000000000000",
        calculated_amount: "1.500000000000000000",
        provider_currency_status: "matched",
      },
    ]);
    const foreign = await pool.query<{ provider_currency_status: string }>(
      `SELECT provider_currency_status
       FROM ai_operation_costs WHERE operation_id = 'ai-operation-foreign'`,
    );
    expect(foreign.rows).toEqual([{ provider_currency_status: "foreign" }]);
    const reservations = await pool.query<{
      status: string;
      over_reservation_amount: string | null;
    }>(
      `SELECT status, over_reservation_amount FROM ai_budget_reservations
       WHERE operation_id = 'ai-operation-overage'`,
    );
    expect(reservations.rows).toEqual([
      {
        status: "providerOverage",
        over_reservation_amount: "0.000000000000000000",
      },
    ]);
  });

  it("persists a typed failed provider dispatch and retains its reservation", async () => {
    await seedConfiguration();
    await pool.query(
      `INSERT INTO ai_budget_policies (
        id, workspace_id, scope, scope_key, limit_amount, currency, hard
      ) VALUES ('ai-failure-policy', 'ai-workspace-a', 'workspace', 'all', 10, 'USD', true)`,
    );
    const provider = new DeterministicAiProviderDispatcher({
      generate: async () => {
        throw new AiProviderError("provider unavailable", { retryable: true });
      },
    });
    const gateway = new DefaultAiExecutionGateway({
      bindingResolver: { resolve: async () => gatewayBinding() },
      providerDispatcher: provider,
      secretResolver: { resolve: async () => ({ value: "secret" }) },
      unitOfWork: persistence.unitOfWork,
      ledger: persistence.ledger,
      budget: persistence.budget,
      operationIds: { next: () => "ai-operation-provider-failure" },
      clock: { now: () => "2026-07-13T19:00:00.000Z" },
    });

    await expect(
      gateway.execute(
        {
          kind: "generation",
          role: "analysis",
          request: { messages: [{ role: "user", content: "prompt" }] },
          maximumInputTokens: 10,
          maximumOutputTokens: 5,
          budget: { currency: "USD", hard: true },
        },
        {
          workspaceId: "ai-workspace-a",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({
      code: "ai.provider",
      retryable: true,
    });
    expect(provider.calls).toHaveLength(1);

    const operation = await pool.query<{
      status: string;
      error_code: string;
      error_retryable: boolean;
    }>(
      `SELECT status, error_code, error_retryable
       FROM ai_operations WHERE id = 'ai-operation-provider-failure'`,
    );
    expect(operation.rows).toEqual([
      {
        status: "failed",
        error_code: "ai.provider",
        error_retryable: true,
      },
    ]);
    const reservation = await pool.query<{ status: string }>(
      `SELECT status FROM ai_budget_reservations
       WHERE operation_id = 'ai-operation-provider-failure'`,
    );
    expect(reservation.rows).toEqual([{ status: "retainedUncertain" }]);
  });

  it("persists a cancellation before dispatch and releases its reservation", async () => {
    await seedConfiguration();
    await pool.query(
      `INSERT INTO ai_budget_policies (
        id, workspace_id, scope, scope_key, limit_amount, currency, hard
      ) VALUES ('ai-cancellation-policy', 'ai-workspace-a', 'workspace', 'all', 10, 'USD', true)`,
    );
    const provider = new DeterministicAiProviderDispatcher({
      generate: async () => ({
        value: { text: "must not run" },
        metadata: { retryCount: 0 },
      }),
    });
    const gateway = new DefaultAiExecutionGateway({
      bindingResolver: { resolve: async () => gatewayBinding() },
      providerDispatcher: provider,
      secretResolver: { resolve: async () => ({ value: "secret" }) },
      unitOfWork: persistence.unitOfWork,
      ledger: persistence.ledger,
      budget: persistence.budget,
      operationIds: { next: () => "ai-operation-pre-dispatch-cancellation" },
      clock: { now: () => "2026-07-13T19:00:00.000Z" },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      gateway.execute(
        {
          kind: "generation",
          role: "analysis",
          request: { messages: [{ role: "user", content: "prompt" }] },
          maximumInputTokens: 10,
          maximumOutputTokens: 5,
          budget: { currency: "USD", hard: true },
        },
        {
          workspaceId: "ai-workspace-a",
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ code: "ai.cancelled" });
    expect(provider.calls).toHaveLength(0);

    const operation = await pool.query<{
      status: string;
      error_code: string;
    }>(
      `SELECT status, error_code
       FROM ai_operations WHERE id = 'ai-operation-pre-dispatch-cancellation'`,
    );
    expect(operation.rows).toEqual([
      { status: "cancelled", error_code: "ai.cancelled" },
    ]);
    const reservation = await pool.query<{ status: string }>(
      `SELECT status FROM ai_budget_reservations
       WHERE operation_id = 'ai-operation-pre-dispatch-cancellation'`,
    );
    expect(reservation.rows).toEqual([{ status: "released" }]);
  });

  it("composes the gateway with PostgreSQL persistence and reconciles provider overage", async () => {
    await seedConfiguration();
    await pool.query(
      `INSERT INTO ai_budget_policies (
        id, workspace_id, scope, scope_key, limit_amount, currency, hard
      ) VALUES ('ai-gateway-policy', 'ai-workspace-a', 'workspace', 'all', 10, 'USD', true)`,
    );
    const binding = gatewayBinding();
    const gateway = new DefaultAiExecutionGateway({
      bindingResolver: { resolve: async () => binding },
      providerDispatcher: new DeterministicAiProviderDispatcher({
        generate: async () => ({
          value: { text: "ok" },
          usage: { inputTokens: 2, outputTokens: 1 },
          providerCost: { amount: "0.03", currency: "USD" },
          metadata: { providerRequestId: "fake-request", retryCount: 0 },
        }),
      }),
      secretResolver: { resolve: async () => ({ value: "secret" }) },
      unitOfWork: persistence.unitOfWork,
      ledger: persistence.ledger,
      budget: persistence.budget,
      operationIds: { next: () => "ai-operation-gateway" },
      clock: { now: () => "2026-07-13T19:00:00.000Z" },
    });

    await expect(
      gateway.execute(
        {
          kind: "generation",
          role: "analysis",
          request: { messages: [{ role: "user", content: "prompt" }] },
          maximumInputTokens: 10,
          maximumOutputTokens: 5,
          budget: { currency: "USD", hard: true },
        },
        {
          workspaceId: "ai-workspace-a",
          signal: new AbortController().signal,
        },
      ),
    ).resolves.toMatchObject({
      operationId: "ai-operation-gateway",
      calculatedCost: { status: "known", amount: "0.004", currency: "USD" },
    });

    const operation = await pool.query<{ status: string }>(
      "SELECT status FROM ai_operations WHERE id = 'ai-operation-gateway'",
    );
    expect(operation.rows).toEqual([{ status: "succeeded" }]);
    const costs = await pool.query<{
      calculated_amount: string;
      provider_reported_amount: string;
      provider_currency_status: string;
    }>(
      `SELECT calculated_amount, provider_reported_amount, provider_currency_status
       FROM ai_operation_costs WHERE operation_id = 'ai-operation-gateway'`,
    );
    expect(costs.rows).toEqual([
      {
        calculated_amount: "0.004000000000000000",
        provider_reported_amount: "0.030000000000000000",
        provider_currency_status: "matched",
      },
    ]);
    const reservation = await pool.query<{
      status: string;
      over_reservation_amount: string;
    }>(
      `SELECT status, over_reservation_amount FROM ai_budget_reservations
       WHERE operation_id = 'ai-operation-gateway'`,
    );
    expect(reservation.rows).toEqual([
      {
        status: "providerOverage",
        over_reservation_amount: "0.000000000000000000",
      },
    ]);
    const balance = await pool.query<{
      reserved_amount: string;
      spent_amount: string;
    }>("SELECT reserved_amount, spent_amount FROM ai_budget_balances");
    expect(balance.rows).toEqual([
      {
        reserved_amount: "0.000000000000000000",
        spent_amount: "0.030000000000000000",
      },
    ]);
  });
});
