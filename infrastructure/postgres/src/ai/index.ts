import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type {
  AiBudgetPort,
  AiExecutionTransaction,
  AiExecutionUnitOfWork,
  AiOperationLedgerPort,
  BudgetReconciliation,
  BudgetReservation,
  OperationFinalization,
  OperationStart,
} from "@caseweaver/ai-execution";

export type PostgresAiTransaction = AiExecutionTransaction;
export type PostgresAiUnitOfWork = AiExecutionUnitOfWork;

interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: readonly Row[];
    readonly rowCount: number | null;
  }>;
}

class UnitOfWork implements AiExecutionUnitOfWork {
  private readonly transactions = new WeakMap<
    PostgresAiTransaction,
    PoolClient
  >();

  public constructor(private readonly pool: Pool) {}

  public async transaction<Result>(
    operation: (transaction: PostgresAiTransaction) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    const transaction = Object.freeze({}) as PostgresAiTransaction;
    this.transactions.set(transaction, client);
    try {
      await client.query("BEGIN");
      const result = await operation(transaction);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      this.transactions.delete(transaction);
      client.release();
    }
  }

  public get(transaction: PostgresAiTransaction): Queryable {
    const client = this.transactions.get(transaction);
    if (client === undefined) {
      throw new Error(
        "An AI PostgreSQL repository requires an active transaction.",
      );
    }
    return client;
  }
}

export class PostgresAiHardBudgetError extends Error {
  public readonly code = "ai.hardBudget";
  public readonly retryable = false;

  public constructor() {
    super("The AI operation exceeds a hard budget.");
    this.name = "PostgresAiHardBudgetError";
  }
}

export class PostgresAiBudgetCurrencyError extends Error {
  public readonly code = "ai.price";
  public readonly retryable = false;

  public constructor() {
    super("Active AI budget policies use a different currency.");
    this.name = "PostgresAiBudgetCurrencyError";
  }
}

interface PolicyRow extends QueryResultRow {
  readonly id: string;
  readonly scope: "operation" | "analysis" | "day" | "workspace";
  readonly scope_key: string;
}

interface BalanceRow extends QueryResultRow {
  readonly id: string;
}

interface ReservationRow extends QueryResultRow {
  readonly id: string;
  readonly budget_balance_id: string;
  readonly amount: string | null;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function balanceId(policyId: string, scopeKey: string): string {
  return `balance:${policyId}:${scopeKey}`;
}

function scopeOrder(scope: PolicyRow["scope"]): number {
  switch (scope) {
    case "operation":
      return 1;
    case "analysis":
      return 2;
    case "day":
      return 3;
    case "workspace":
      return 4;
  }
}

export class PostgresAiLedgerBudgetRepository
  implements AiOperationLedgerPort, AiBudgetPort
{
  public constructor(private readonly unitOfWork: UnitOfWork) {}

  public async start(
    transaction: PostgresAiTransaction,
    operation: OperationStart,
  ): Promise<void> {
    await this.unitOfWork.get(transaction).query(
      `INSERT INTO ai_operations (
        id, workspace_id, role, operation_kind, model_binding_version_id,
        provider_instance_version_id, catalog_snapshot_id, configured_model,
        status, started_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'started', $9)`,
      [
        operation.operationId,
        operation.workspaceId,
        operation.role,
        operation.operationKind,
        operation.bindingVersionId,
        operation.providerInstanceVersionId,
        operation.catalogSnapshotId,
        operation.configuredModel,
        operation.startedAt,
      ],
    );
    await this.unitOfWork.get(transaction).query(
      `INSERT INTO ai_operation_costs (
        id, workspace_id, operation_id, estimated_amount, currency,
        calculation_status, price_inputs
      ) VALUES ($1, $2, $3, $4::numeric, $5, $6, $7::jsonb)`,
      [
        `cost:${operation.operationId}`,
        operation.workspaceId,
        operation.operationId,
        this.estimateAmount(operation.reservation),
        this.estimateCurrency(operation.reservation),
        this.estimateStatus(operation.reservation),
        json({
          pricing: operation.pricing,
          reservation: operation.reservation,
        }),
      ],
    );
  }

  public async finalize(
    transaction: PostgresAiTransaction,
    operation: OperationFinalization,
  ): Promise<void> {
    const database = this.unitOfWork.get(transaction);
    const updated = await database.query(
      `UPDATE ai_operations
       SET status = $1, finished_at = $2, effective_model = $3,
           provider_request_id = $4, latency_ms = $5, retry_count = $6,
           raw_redacted = $7::jsonb, error_code = $8, error_retryable = $9
       WHERE id = $10 AND workspace_id = $11`,
      [
        operation.status,
        operation.finishedAt,
        operation.metadata?.effectiveModel ?? null,
        operation.metadata?.providerRequestId ?? null,
        operation.metadata?.latencyMs ?? null,
        operation.metadata?.retryCount ?? 0,
        operation.metadata?.rawRedacted === undefined
          ? null
          : json(operation.metadata.rawRedacted),
        operation.error?.code ?? null,
        operation.error?.retryable ?? null,
        operation.operationId,
        operation.workspaceId,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new Error("AI operation was not found.");
    }
    if (operation.usage !== undefined) {
      await database.query(
        `INSERT INTO ai_operation_usage (
          id, workspace_id, operation_id, input_tokens, output_tokens,
          cache_read_input_tokens, cache_creation_input_tokens, reasoning_tokens,
          image_units, audio_units, raw_usage
        )
        SELECT $1, workspace_id, id, $2, $3, $4, $5, $6, $7, $8, $9::jsonb
        FROM ai_operations WHERE id = $10 AND workspace_id = $11
        ON CONFLICT (workspace_id, operation_id) DO UPDATE SET
          input_tokens = EXCLUDED.input_tokens,
          output_tokens = EXCLUDED.output_tokens,
          cache_read_input_tokens = EXCLUDED.cache_read_input_tokens,
          cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens,
          reasoning_tokens = EXCLUDED.reasoning_tokens,
          image_units = EXCLUDED.image_units,
          audio_units = EXCLUDED.audio_units,
          raw_usage = EXCLUDED.raw_usage`,
        [
          `usage:${operation.operationId}`,
          operation.usage.inputTokens ?? null,
          operation.usage.outputTokens ?? null,
          operation.usage.cacheReadInputTokens ?? null,
          operation.usage.cacheCreationInputTokens ?? null,
          operation.usage.reasoningTokens ?? null,
          operation.usage.imageUnits ?? null,
          operation.usage.audioUnits ?? null,
          json(operation.usage),
          operation.operationId,
          operation.workspaceId,
        ],
      );
    }
    await database.query(
      `UPDATE ai_operation_costs
       SET calculated_amount = $1::numeric, currency = $2::char(3),
           provider_reported_amount = $3::numeric, provider_currency = $4,
           provider_currency_status = CASE
             WHEN $3::numeric IS NULL THEN 'notReported'
             WHEN $4::char(3) = $2::char(3) THEN 'matched'
             ELSE 'foreign'
           END,
           calculation_status = $5
       WHERE operation_id = $6 AND workspace_id = $7`,
      [
        operation.calculatedCost.amount ?? null,
        operation.calculatedCost.currency ?? null,
        operation.providerCost?.amount ?? null,
        operation.providerCost?.currency ?? null,
        operation.calculatedCost.status,
        operation.operationId,
        operation.workspaceId,
      ],
    );
  }

  public async reserve(
    transaction: PostgresAiTransaction,
    reservation: BudgetReservation,
  ): Promise<void> {
    const database = this.unitOfWork.get(transaction);
    const policies = await database.query<
      PolicyRow & { readonly currency: string }
    >(
      `SELECT id, scope, scope_key, currency
       FROM ai_budget_policies
       WHERE workspace_id = $1 AND active
         AND (
           (scope = 'operation' AND scope_key = $2)
           OR (scope = 'analysis' AND $3::text IS NOT NULL AND scope_key = $3)
           OR (scope = 'day' AND scope_key = $4)
           OR (scope = 'workspace' AND scope_key = $5)
         )
       ORDER BY
         CASE scope
           WHEN 'operation' THEN 1 WHEN 'analysis' THEN 2
           WHEN 'day' THEN 3 WHEN 'workspace' THEN 4
         END,
         scope_key,
         id`,
      [
        reservation.workspaceId,
        reservation.scope.operationId,
        reservation.scope.analysisId ?? null,
        reservation.scope.day,
        reservation.scope.workspace,
      ],
    );
    if (
      policies.rows.some((policy) => policy.currency !== reservation.currency)
    ) {
      throw new PostgresAiBudgetCurrencyError();
    }
    const orderedPolicies = [...policies.rows].sort(
      (left, right) =>
        scopeOrder(left.scope) - scopeOrder(right.scope) ||
        left.scope_key.localeCompare(right.scope_key) ||
        left.id.localeCompare(right.id),
    );
    for (const policy of orderedPolicies) {
      await database.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [
          `ai-budget-balance:${reservation.workspaceId}:${policy.id}:${policy.scope_key}`,
        ],
      );
    }
    for (const policy of orderedPolicies) {
      const id = balanceId(policy.id, policy.scope_key);
      await database.query(
        `INSERT INTO ai_budget_balances (
          id, workspace_id, budget_policy_id, scope_key, currency
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (workspace_id, budget_policy_id, scope_key) DO NOTHING`,
        [
          id,
          reservation.workspaceId,
          policy.id,
          policy.scope_key,
          reservation.currency,
        ],
      );
    }
    if (orderedPolicies.length === 0) return;
    const policyIds = orderedPolicies.map((policy) => policy.id);
    const balances = await database.query<BalanceRow>(
      `SELECT b.id
       FROM ai_budget_balances b
       JOIN ai_budget_policies p
         ON p.workspace_id = b.workspace_id AND p.id = b.budget_policy_id
       WHERE b.workspace_id = $1 AND b.budget_policy_id = ANY($2::text[])
       ORDER BY
         CASE p.scope
           WHEN 'operation' THEN 1 WHEN 'analysis' THEN 2
           WHEN 'day' THEN 3 WHEN 'workspace' THEN 4
         END,
         b.scope_key,
         p.id
       FOR UPDATE`,
      [reservation.workspaceId, policyIds],
    );
    if (
      reservation.estimatedAmount !== undefined &&
      reservation.hard &&
      !reservation.unknownPriceBypass
    ) {
      const exceeded = await database.query<{ readonly exceeded: boolean }>(
        `SELECT EXISTS (
          SELECT 1
          FROM ai_budget_balances b
          JOIN ai_budget_policies p
            ON p.workspace_id = b.workspace_id AND p.id = b.budget_policy_id
          WHERE b.id = ANY($1::text[])
            AND p.hard
            AND b.spent_amount + b.reserved_amount + $2::numeric > p.limit_amount
        ) AS exceeded`,
        [
          balances.rows.map((balance) => balance.id),
          reservation.estimatedAmount,
        ],
      );
      if (exceeded.rows[0]?.exceeded === true) {
        throw new PostgresAiHardBudgetError();
      }
    }
    for (const balance of balances.rows) {
      if (reservation.estimatedAmount !== undefined) {
        await database.query(
          `UPDATE ai_budget_balances
           SET reserved_amount = reserved_amount + $1::numeric, updated_at = now()
           WHERE id = $2`,
          [reservation.estimatedAmount, balance.id],
        );
      }
      await database.query(
        `INSERT INTO ai_budget_reservations (
          id, workspace_id, operation_id, budget_balance_id, amount, currency, status
        ) VALUES ($1, $2, $3, $4, $5::numeric, $6, 'reserved')`,
        [
          `reservation:${reservation.operationId}:${balance.id}`,
          reservation.workspaceId,
          reservation.operationId,
          balance.id,
          reservation.estimatedAmount ?? null,
          reservation.currency,
        ],
      );
    }
  }

  public async reconcile(
    transaction: PostgresAiTransaction,
    reconciliation: BudgetReconciliation,
  ): Promise<void> {
    const database = this.unitOfWork.get(transaction);
    const reservations = await database.query<ReservationRow>(
      `SELECT id, budget_balance_id, amount
       FROM ai_budget_reservations
       WHERE workspace_id = $1 AND operation_id = $2 AND status = 'reserved'
       ORDER BY budget_balance_id
       FOR UPDATE`,
      [reconciliation.workspaceId, reconciliation.operationId],
    );
    for (const reservation of reservations.rows) {
      if (
        reconciliation.status === "reconciled" ||
        reconciliation.status === "providerOverage"
      ) {
        if (reservation.amount !== null) {
          await database.query(
            `UPDATE ai_budget_balances
             SET reserved_amount = reserved_amount - $1::numeric,
                 spent_amount = spent_amount + $2::numeric,
                 updated_at = now()
             WHERE id = $3`,
            [
              reservation.amount,
              reconciliation.actualAmount ?? reservation.amount,
              reservation.budget_balance_id,
            ],
          );
        }
      } else if (
        reconciliation.status === "released" &&
        reservation.amount !== null
      ) {
        await database.query(
          `UPDATE ai_budget_balances
           SET reserved_amount = reserved_amount - $1::numeric, updated_at = now()
           WHERE id = $2`,
          [reservation.amount, reservation.budget_balance_id],
        );
      }
      await database.query(
        `UPDATE ai_budget_reservations
         SET status = $1,
             reconciled_at = now(),
             over_reservation_amount = CASE
               WHEN amount IS NULL OR $2::numeric IS NULL THEN NULL
               ELSE GREATEST(amount - $2::numeric, 0)
             END
         WHERE id = $3`,
        [
          reconciliation.status,
          reconciliation.status === "released"
            ? "0"
            : (reconciliation.actualAmount ?? null),
          reservation.id,
        ],
      );
    }
  }

  private estimateAmount(value: unknown): string | null {
    const record =
      typeof value === "object" && value !== null
        ? (value as Readonly<Record<string, unknown>>)
        : {};
    return typeof record.amount === "string" ? record.amount : null;
  }

  private estimateCurrency(value: unknown): string | null {
    const record =
      typeof value === "object" && value !== null
        ? (value as Readonly<Record<string, unknown>>)
        : {};
    return typeof record.currency === "string" ? record.currency : null;
  }

  private estimateStatus(value: unknown): string {
    const record =
      typeof value === "object" && value !== null
        ? (value as Readonly<Record<string, unknown>>)
        : {};
    return typeof record.status === "string" ? record.status : "unknown";
  }
}

export interface PostgresAiPersistence {
  readonly unitOfWork: AiExecutionUnitOfWork;
  readonly ledger: PostgresAiLedgerBudgetRepository;
  readonly budget: PostgresAiLedgerBudgetRepository;
  close(): Promise<void>;
}

export function createPostgresAiPersistence(input: {
  readonly databaseUrl: string;
}): PostgresAiPersistence {
  const pool = new Pool({ connectionString: input.databaseUrl });
  const unitOfWork = new UnitOfWork(pool);
  const repository = new PostgresAiLedgerBudgetRepository(unitOfWork);
  return Object.freeze({
    unitOfWork,
    ledger: repository,
    budget: repository,
    close: async () => pool.end(),
  });
}
