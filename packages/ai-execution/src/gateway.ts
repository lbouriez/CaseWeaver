import {
  type AiBindingResolver,
  type CostCalculation,
  calculateCost,
  compareDecimals,
  conservativeReservationUsage,
  decimal,
  type PriceComponentKind,
  type PriceResolutionContext,
  resolvePrices,
} from "@caseweaver/ai-config";
import {
  AiCancelledError,
  type AiCapability,
  AiCapabilityError,
  AiConfigurationError,
  AiError,
  AiHardBudgetError,
  type AiOperationKind,
  type AiProviderDispatcher,
  type AiRole,
  AiTimeoutError,
  type EmbeddingRequest,
  type GenerationRequest,
  type NormalizedUsage,
  type ProviderReportedCost,
  type ProviderResult,
  type RepositoryAgentRequest,
  type RerankerRequest,
  type SecretResolver,
  type VisionRequest,
} from "@caseweaver/ai-sdk";

import type {
  AiBudgetPort,
  AiExecutionClock,
  AiExecutionUnitOfWork,
  AiOperationIdGenerator,
  AiOperationLedgerPort,
  AiOperationStatus,
  BudgetReservationScope,
  BudgetReconciliationStatus,
} from "./ports.js";

interface MeteredRequestBase {
  readonly role: AiRole;
  readonly bindingVersionId?: string;
  readonly analysisId?: string;
  readonly requiredCapabilities?: readonly AiCapability[];
  readonly maximumInputTokens?: number;
  readonly maximumOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly priceContext?: Omit<PriceResolutionContext, "at" | "currency">;
  readonly budget: {
    readonly currency: string;
    readonly hard: boolean;
    readonly allowUnknownPricing?: boolean;
  };
}

export interface MeteredEmbeddingRequest extends MeteredRequestBase {
  readonly kind: "embedding";
  readonly request: EmbeddingRequest;
}

export interface MeteredVisionRequest extends MeteredRequestBase {
  readonly kind: "vision";
  readonly request: VisionRequest;
}

export interface MeteredGenerationRequest extends MeteredRequestBase {
  readonly kind: "generation";
  readonly request: GenerationRequest;
}

export interface MeteredRerankerRequest extends MeteredRequestBase {
  readonly kind: "reranker";
  readonly request: RerankerRequest;
}

export interface MeteredRepositoryAgentRequest extends MeteredRequestBase {
  readonly kind: "repositoryAgent";
  readonly request: RepositoryAgentRequest;
}

export type MeteredAiRequest =
  | MeteredEmbeddingRequest
  | MeteredVisionRequest
  | MeteredGenerationRequest
  | MeteredRerankerRequest
  | MeteredRepositoryAgentRequest;

export interface AiExecutionContext {
  readonly workspaceId: string;
  readonly signal: AbortSignal;
}

export interface MeteredAiResult<TResult = unknown> {
  readonly operationId: string;
  readonly value: TResult;
  readonly usage?: NormalizedUsage;
  readonly providerCost?: ProviderReportedCost;
  readonly calculatedCost: CostCalculation;
}

export interface AiExecutionGateway {
  execute<TResult = unknown>(
    request: MeteredAiRequest,
    context: AiExecutionContext,
  ): Promise<MeteredAiResult<TResult>>;
}

export interface MeteredAiExecutionGatewayDependencies {
  readonly bindingResolver: AiBindingResolver;
  readonly providerDispatcher: AiProviderDispatcher;
  readonly secretResolver: SecretResolver;
  readonly ledger: AiOperationLedgerPort;
  readonly budget: AiBudgetPort;
  readonly unitOfWork: AiExecutionUnitOfWork;
  readonly operationIds: AiOperationIdGenerator;
  readonly clock: AiExecutionClock;
}

interface ComposedSignal {
  readonly signal: AbortSignal;
  readonly deadlineExceeded: () => boolean;
  readonly dispose: () => void;
}

function composeAbortSignal(
  supplied: AbortSignal,
  timeoutMs: number | undefined,
): ComposedSignal {
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
  ) {
    throw new AiConfigurationError("AI timeout must be a positive integer.");
  }
  const controller = new AbortController();
  let deadlineExceeded = false;
  const cancel = () => controller.abort(supplied.reason);
  supplied.addEventListener("abort", cancel, { once: true });
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          deadlineExceeded = true;
          controller.abort();
        }, timeoutMs);
  if (supplied.aborted) cancel();
  return {
    signal: controller.signal,
    deadlineExceeded: () => deadlineExceeded,
    dispose: () => {
      supplied.removeEventListener("abort", cancel);
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function expectedRole(kind: AiOperationKind, role: AiRole): boolean {
  switch (kind) {
    case "embedding":
      return role === "embedding";
    case "vision":
      return role === "vision";
    case "generation":
      return (
        role === "analysis" || role === "chat" || role === "keywordExtraction"
      );
    case "reranker":
      return role === "reranker";
    case "repositoryAgent":
      return role === "repositoryAgent";
  }
}

function kindsFor(request: MeteredAiRequest): readonly PriceComponentKind[] {
  const kinds: PriceComponentKind[] =
    request.kind === "embedding" || request.kind === "reranker"
      ? ["input"]
      : ["input", "output"];
  if (request.kind === "vision") kinds.push("image");
  return kinds;
}

function requestedCapabilities(
  request: MeteredAiRequest,
): readonly AiCapability[] {
  if (request.kind === "vision") {
    return [...(request.requiredCapabilities ?? []), "vision"];
  }
  return request.requiredCapabilities ?? [];
}

function actualUsage(
  usage: NormalizedUsage,
): Record<PriceComponentKind, number> {
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cacheRead: usage.cacheReadInputTokens ?? 0,
    cacheCreation: usage.cacheCreationInputTokens ?? 0,
    image: usage.imageUnits ?? 0,
    audio: usage.audioUnits ?? 0,
  };
}

function errorDetails(error: unknown): {
  readonly code: string;
  readonly retryable: boolean;
} {
  if (error instanceof AiError) {
    return { code: error.code, retryable: error.retryable };
  }
  return { code: "ai.unexpected", retryable: false };
}

function reservationScope(
  operationId: string,
  analysisId: string | undefined,
  occurredAt: string,
): BudgetReservationScope {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) {
    throw new AiConfigurationError(
      "The AI execution clock must return a valid UTC instant.",
    );
  }
  return {
    operationId,
    ...(analysisId === undefined ? {} : { analysisId }),
    day: date.toISOString().slice(0, 10),
    workspace: "all",
  };
}

export class DefaultAiExecutionGateway implements AiExecutionGateway {
  public constructor(
    private readonly dependencies: MeteredAiExecutionGatewayDependencies,
  ) {}

  public async execute<TResult = unknown>(
    request: MeteredAiRequest,
    context: AiExecutionContext,
  ): Promise<MeteredAiResult<TResult>> {
    if (!expectedRole(request.kind, request.role)) {
      throw new AiCapabilityError(
        "AI request kind does not match the selected role.",
      );
    }
    const startedAt = this.dependencies.clock.now();
    const binding = await this.dependencies.bindingResolver.resolve({
      workspaceId: context.workspaceId,
      role: request.role,
      bindingVersionId: request.bindingVersionId,
      requiredCapabilities: requestedCapabilities(request),
      inputTokens: request.maximumInputTokens,
      outputTokens: request.maximumOutputTokens,
    });
    const maximumInputTokens =
      request.maximumInputTokens ?? binding.maximumInputTokens;
    const maximumOutputTokens =
      request.kind === "embedding" || request.kind === "reranker"
        ? 0
        : (request.maximumOutputTokens ?? binding.maximumOutputTokens);
    if (
      maximumInputTokens === undefined ||
      (request.kind !== "embedding" &&
        request.kind !== "reranker" &&
        maximumOutputTokens === undefined)
    ) {
      throw new AiConfigurationError(
        "A configured maximum input and output limit is required for metered execution.",
      );
    }
    if (maximumInputTokens === undefined) {
      throw new AiConfigurationError(
        "A configured maximum input limit is required for metered execution.",
      );
    }
    const boundedOutputTokens = maximumOutputTokens ?? 0;
    const requestedImageUnits =
      request.kind === "vision" ? request.request.images.length : 0;
    const priceContext: PriceResolutionContext = {
      at: startedAt,
      currency: request.budget.currency,
      ...(request.priceContext ?? {}),
      inputTokenCount: maximumInputTokens,
    };
    const cachePricingKinds = binding.capabilities.has("promptCaching")
      ? (["cacheRead", "cacheCreation"] as const)
      : [];
    const pricing = resolvePrices(
      binding.pricing,
      [...kindsFor(request), ...cachePricingKinds],
      priceContext,
    );
    const reservation = calculateCost(
      pricing,
      conservativeReservationUsage({
        maximumInputTokens,
        maximumOutputTokens: boundedOutputTokens,
        mayUsePromptCache: binding.capabilities.has("promptCaching"),
        maximumImageUnits: requestedImageUnits,
      }),
    );
    const bypass = request.budget.allowUnknownPricing === true;
    if (request.budget.hard && reservation.status !== "known" && !bypass) {
      throw new AiHardBudgetError(
        "A hard budget cannot execute with unknown or incomplete pricing.",
      );
    }
    const operationId = this.dependencies.operationIds.next();
    await this.dependencies.unitOfWork.transaction(async (transaction) => {
      await this.dependencies.ledger.start(transaction, {
        operationId,
        workspaceId: context.workspaceId,
        role: request.role,
        operationKind: request.kind,
        bindingVersionId: binding.bindingVersionId,
        providerInstanceVersionId: binding.providerInstanceVersionId,
        catalogSnapshotId: binding.catalogSnapshotId,
        configuredModel: binding.canonicalModel,
        startedAt,
        pricing,
        reservation,
      });
      await this.dependencies.budget.reserve(transaction, {
        operationId,
        workspaceId: context.workspaceId,
        scope: reservationScope(operationId, request.analysisId, startedAt),
        currency: request.budget.currency,
        estimatedAmount: reservation.amount,
        calculationStatus: reservation.status,
        hard: request.budget.hard,
        unknownPriceBypass: bypass,
        occurredAt: startedAt,
      });
    });

    const composed = composeAbortSignal(context.signal, request.timeoutMs);
    let dispatched = false;
    try {
      const secret = await this.dependencies.secretResolver.resolve(
        binding.secretReference,
        composed.signal,
      );
      if (composed.deadlineExceeded())
        throw new AiTimeoutError(request.timeoutMs ?? 0);
      if (context.signal.aborted) throw new AiCancelledError();
      dispatched = true;
      const providerResult = await this.dispatch(request, {
        binding,
        secret,
        signal: composed.signal,
      });
      const finishedAt = this.dependencies.clock.now();
      const calculatedCost =
        providerResult.usage === undefined
          ? ({ status: "unknown", components: [] } satisfies CostCalculation)
          : calculateCost(pricing, actualUsage(providerResult.usage));
      const reconciliation = this.successReconciliation(
        reservation,
        calculatedCost,
        providerResult.providerCost,
        providerResult.usage,
        request.budget.currency,
      );
      await this.finalize({
        operationId,
        workspaceId: context.workspaceId,
        status:
          providerResult.usage === undefined
            ? "succeededUsageUnknown"
            : "succeeded",
        finishedAt,
        usage: providerResult.usage,
        metadata: providerResult.metadata,
        calculatedCost,
        providerCost: providerResult.providerCost,
        reconciliation,
      });
      return {
        operationId,
        value: providerResult.value as TResult,
        usage: providerResult.usage,
        providerCost: providerResult.providerCost,
        calculatedCost,
      };
    } catch (caught) {
      const error = composed.deadlineExceeded()
        ? new AiTimeoutError(request.timeoutMs ?? 0)
        : context.signal.aborted
          ? new AiCancelledError()
          : caught;
      const status: Exclude<
        AiOperationStatus,
        "started" | "succeeded" | "succeededUsageUnknown"
      > =
        error instanceof AiTimeoutError
          ? "timedOut"
          : error instanceof AiCancelledError
            ? "cancelled"
            : "failed";
      await this.finalize({
        operationId,
        workspaceId: context.workspaceId,
        status,
        finishedAt: this.dependencies.clock.now(),
        calculatedCost: { status: "unknown", components: [] },
        error: errorDetails(error),
        reconciliation: {
          status: dispatched ? "retainedUncertain" : "released",
          currency: request.budget.currency,
        },
      });
      throw error;
    } finally {
      composed.dispose();
    }
  }

  private async dispatch(
    request: MeteredAiRequest,
    base: {
      readonly binding: Awaited<ReturnType<AiBindingResolver["resolve"]>>;
      readonly secret: Awaited<ReturnType<SecretResolver["resolve"]>>;
      readonly signal: AbortSignal;
    },
  ): Promise<ProviderResult<unknown>> {
    switch (request.kind) {
      case "embedding":
        return this.dependencies.providerDispatcher.embed({
          ...base,
          request: request.request,
        });
      case "vision":
        return this.dependencies.providerDispatcher.analyzeVision({
          ...base,
          request: request.request,
        });
      case "generation":
        return this.dependencies.providerDispatcher.generate({
          ...base,
          request: request.request,
        });
      case "reranker":
        return this.dependencies.providerDispatcher.rerank({
          ...base,
          request: request.request,
        });
      case "repositoryAgent":
        return this.dependencies.providerDispatcher.runRepositoryAgent({
          ...base,
          request: request.request,
        });
    }
  }

  private successReconciliation(
    reservation: CostCalculation,
    calculated: CostCalculation,
    providerCost: ProviderReportedCost | undefined,
    usage: NormalizedUsage | undefined,
    currency: string,
  ): {
    readonly status: BudgetReconciliationStatus;
    readonly currency: string;
    readonly actualAmount?: CostCalculation["amount"];
    readonly providerCost?: ProviderReportedCost;
  } {
    if (usage === undefined || calculated.status !== "known") {
      return { status: "retainedUncertain", currency, providerCost };
    }
    if (
      providerCost !== undefined &&
      reservation.amount !== undefined &&
      providerCost.currency === currency &&
      compareDecimals(decimal(providerCost.amount), reservation.amount) > 0
    ) {
      return {
        status: "providerOverage",
        currency,
        actualAmount: decimal(providerCost.amount),
        providerCost,
      };
    }
    if (providerCost !== undefined && providerCost.currency !== currency) {
      return { status: "retainedUncertain", currency, providerCost };
    }
    return {
      status: "reconciled",
      currency,
      actualAmount: calculated.amount,
      providerCost,
    };
  }

  private async finalize(input: {
    readonly operationId: string;
    readonly workspaceId: string;
    readonly status: Exclude<AiOperationStatus, "started">;
    readonly finishedAt: string;
    readonly usage?: NormalizedUsage;
    readonly metadata?: ProviderResult<unknown>["metadata"];
    readonly calculatedCost: CostCalculation;
    readonly providerCost?: ProviderReportedCost;
    readonly error?: { readonly code: string; readonly retryable: boolean };
    readonly reconciliation: {
      readonly status: BudgetReconciliationStatus;
      readonly currency: string;
      readonly actualAmount?: CostCalculation["amount"];
      readonly providerCost?: ProviderReportedCost;
    };
  }): Promise<void> {
    await this.dependencies.unitOfWork.transaction(async (transaction) => {
      await this.dependencies.ledger.finalize(transaction, {
        operationId: input.operationId,
        workspaceId: input.workspaceId,
        status: input.status,
        finishedAt: input.finishedAt,
        usage: input.usage,
        metadata: input.metadata,
        calculatedCost: input.calculatedCost,
        providerCost: input.providerCost,
        error: input.error,
      });
      await this.dependencies.budget.reconcile(transaction, {
        operationId: input.operationId,
        workspaceId: input.workspaceId,
        actualAmount: input.reconciliation.actualAmount,
        currency: input.reconciliation.currency,
        status: input.reconciliation.status,
        providerCost: input.reconciliation.providerCost,
        occurredAt: input.finishedAt,
      });
    });
  }
}
