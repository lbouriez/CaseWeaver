import type {
  CostCalculation,
  DecimalString,
  PriceResolution,
} from "@caseweaver/ai-config";
import type {
  AiOperationKind,
  AiRole,
  NormalizedUsage,
  ProviderReportedCost,
  ProviderResponseMetadata,
} from "@caseweaver/ai-sdk";

export interface AiExecutionTransaction {
  readonly aiExecutionTransaction: unique symbol;
}

export interface AiExecutionUnitOfWork {
  transaction<Result>(
    operation: (transaction: AiExecutionTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface AiOperationIdGenerator {
  next(): string;
}

export interface AiExecutionClock {
  now(): string;
}

export type AiOperationStatus =
  | "started"
  | "succeeded"
  | "failed"
  | "timedOut"
  | "cancelled"
  | "succeededUsageUnknown";

export interface OperationStart {
  readonly operationId: string;
  /**
   * Observable repository-agent turns are children of the one operation that
   * reserved the whole-run budget. Child operations never reserve again.
   */
  readonly parentOperationId?: string;
  readonly workspaceId: string;
  readonly role: AiRole;
  readonly operationKind: AiOperationKind;
  readonly bindingVersionId: string;
  readonly providerInstanceVersionId: string;
  readonly catalogSnapshotId: string;
  readonly configuredModel: string;
  /**
   * Immutable ownership captured at invocation time. These IDs are optional
   * only for installation-level calls; when present they are queryable without
   * parsing prompts, payloads, or diagnostic data.
   */
  readonly attribution?: {
    readonly analysisJobId?: string;
    readonly connectorInstanceId?: string;
    readonly sourceId?: string;
  };
  readonly startedAt: string;
  readonly pricing: PriceResolution;
  readonly reservation: CostCalculation;
}

export interface OperationFinalization {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly status: Exclude<AiOperationStatus, "started">;
  readonly finishedAt: string;
  readonly usage?: NormalizedUsage;
  readonly metadata?: ProviderResponseMetadata;
  readonly calculatedCost: CostCalculation;
  readonly providerCost?: ProviderReportedCost;
  readonly error?: {
    readonly code: string;
    readonly retryable: boolean;
  };
}

export interface AiOperationLedgerPort {
  start(
    transaction: AiExecutionTransaction,
    operation: OperationStart,
  ): Promise<void>;
  finalize(
    transaction: AiExecutionTransaction,
    operation: OperationFinalization,
  ): Promise<void>;
}

export interface BudgetReservation {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly scope: BudgetReservationScope;
  readonly currency: string;
  readonly estimatedAmount?: DecimalString;
  readonly calculationStatus: CostCalculation["status"];
  readonly hard: boolean;
  readonly unknownPriceBypass: boolean;
  readonly occurredAt: string;
}

export interface BudgetReservationScope {
  /** Canonical policy keys: operation ID, opaque analysis ID, UTC date, and `all`. */
  readonly operationId: string;
  readonly analysisId?: string;
  readonly day: string;
  readonly workspace: "all";
}

export type BudgetReconciliationStatus =
  | "reconciled"
  | "released"
  | "retainedUncertain"
  | "providerOverage";

export interface BudgetReconciliation {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly actualAmount?: DecimalString;
  readonly currency: string;
  readonly status: BudgetReconciliationStatus;
  readonly providerCost?: ProviderReportedCost;
  readonly occurredAt: string;
}

export interface AiBudgetPort {
  reserve(
    transaction: AiExecutionTransaction,
    reservation: BudgetReservation,
  ): Promise<void>;
  reconcile(
    transaction: AiExecutionTransaction,
    reconciliation: BudgetReconciliation,
  ): Promise<void>;
}
