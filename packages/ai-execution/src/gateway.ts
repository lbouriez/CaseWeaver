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
  AiProviderError,
  type AiRole,
  AiTimeoutError,
  type EmbeddingRequest,
  type GenerationRequest,
  type NormalizedUsage,
  type ProviderReportedCost,
  type ProviderResult,
  type RepositoryAgentMetering,
  type RepositoryAgentRequest,
  type RepositoryAgentTurn,
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
  BudgetReconciliationStatus,
  BudgetReservationScope,
  OperationFinalization,
  OperationStart,
} from "./ports.js";

interface MeteredRequestBase {
  readonly role: AiRole;
  readonly bindingVersionId?: string;
  readonly analysisId?: string;
  readonly attribution?: {
    readonly analysisJobId?: string;
    readonly connectorInstanceId?: string;
    readonly sourceId?: string;
  };
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
    case "repositoryAgentTurn":
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
  if (request.kind === "repositoryAgent") {
    return [...(request.requiredCapabilities ?? []), "repositoryAgent"];
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

interface RepositoryAgentTokenBounds {
  readonly maximumTurns: number;
  readonly maximumInputTokensPerTurn: number;
  readonly maximumOutputTokensPerTurn: number;
  readonly maximumInputTokens: number;
  readonly maximumOutputTokens: number;
}

interface RepositoryAgentAccounting {
  readonly metering: RepositoryAgentMetering["mode"];
  readonly usage?: NormalizedUsage;
  readonly turns: readonly RepositoryAgentTurn[];
}

interface ObservableChildOperation {
  readonly start: OperationStart;
  readonly finalization: OperationFinalization;
}

const usageFields = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "reasoningTokens",
  "imageUnits",
  "audioUnits",
] as const;

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function repositoryAgentTokenBounds(
  request: RepositoryAgentRequest,
  hardBudget: boolean,
): RepositoryAgentTokenBounds {
  if (
    !isPositiveInteger(request.maximumTurns) ||
    !isPositiveInteger(request.maximumInputTokensPerTurn) ||
    !isPositiveInteger(request.maximumOutputTokensPerTurn)
  ) {
    if (hardBudget) {
      throw new AiHardBudgetError(
        "A hard-budget repository agent requires safe per-turn token limits.",
      );
    }
    throw new AiConfigurationError(
      "Repository agents require safe per-turn token limits.",
    );
  }
  const maximumInputTokens =
    request.maximumTurns * request.maximumInputTokensPerTurn;
  const maximumOutputTokens =
    request.maximumTurns * request.maximumOutputTokensPerTurn;
  if (
    !Number.isSafeInteger(maximumInputTokens) ||
    !Number.isSafeInteger(maximumOutputTokens)
  ) {
    if (hardBudget) {
      throw new AiHardBudgetError(
        "A hard-budget repository agent requires safe aggregate token limits.",
      );
    }
    throw new AiConfigurationError(
      "Repository-agent aggregate token limits exceed the safe integer range.",
    );
  }
  return {
    maximumTurns: request.maximumTurns,
    maximumInputTokensPerTurn: request.maximumInputTokensPerTurn,
    maximumOutputTokensPerTurn: request.maximumOutputTokensPerTurn,
    maximumInputTokens,
    maximumOutputTokens,
  };
}

function requireRepositoryAgentTokenBounds(
  bounds: RepositoryAgentTokenBounds | undefined,
): RepositoryAgentTokenBounds {
  if (bounds === undefined) {
    throw new AiConfigurationError(
      "Repository-agent token bounds were not initialized.",
    );
  }
  return bounds;
}

function assertValidUsage(usage: NormalizedUsage): void {
  for (const field of usageFields) {
    const value = usage[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new AiProviderError("Repository agent returned invalid usage.", {
        provider: "repository-agent",
      });
    }
  }
}

function sumRepositoryAgentUsage(
  turns: readonly RepositoryAgentTurn[],
): NormalizedUsage {
  const totals: Record<(typeof usageFields)[number], number> = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    imageUnits: 0,
    audioUnits: 0,
  };
  for (const turn of turns) {
    assertValidUsage(turn.usage);
    for (const field of usageFields) {
      const total = totals[field] + (turn.usage[field] ?? 0);
      if (!Number.isSafeInteger(total)) {
        throw new AiProviderError(
          "Repository agent usage exceeds the safe integer range.",
          { provider: "repository-agent" },
        );
      }
      totals[field] = total;
    }
  }
  return Object.freeze(totals);
}

function sameUsage(left: NormalizedUsage, right: NormalizedUsage): boolean {
  return usageFields.every(
    (field) => (left[field] ?? 0) === (right[field] ?? 0),
  );
}

function assertUsageWithinRepositoryAgentBounds(
  usage: NormalizedUsage,
  bounds: RepositoryAgentTokenBounds,
): void {
  assertValidUsage(usage);
  if (
    (usage.inputTokens ?? 0) > bounds.maximumInputTokens ||
    (usage.outputTokens ?? 0) > bounds.maximumOutputTokens ||
    (usage.cacheReadInputTokens ?? 0) > bounds.maximumInputTokens ||
    (usage.cacheCreationInputTokens ?? 0) > bounds.maximumInputTokens ||
    (usage.reasoningTokens ?? 0) > bounds.maximumOutputTokens
  ) {
    throw new AiProviderError(
      "Repository agent exceeded its reserved aggregate token limit.",
      { provider: "repository-agent" },
    );
  }
}

function repositoryAgentAccounting(
  result: ProviderResult<unknown>,
  bounds: RepositoryAgentTokenBounds,
): RepositoryAgentAccounting {
  if (typeof result.value !== "object" || result.value === null) {
    throw new AiProviderError("Repository agent returned an invalid result.", {
      provider: "repository-agent",
    });
  }
  const value = result.value as {
    readonly metering?: RepositoryAgentMetering;
  };
  const metering = value.metering;
  if (metering === undefined || typeof metering !== "object") {
    throw new AiProviderError("Repository agent omitted metering metadata.", {
      provider: "repository-agent",
    });
  }
  if (metering.mode === "aggregate") {
    if (result.usage !== undefined) {
      assertUsageWithinRepositoryAgentBounds(result.usage, bounds);
    }
    return { metering: "aggregate", usage: result.usage, turns: [] };
  }
  if (metering.mode !== "observableTurns" || !Array.isArray(metering.turns)) {
    throw new AiProviderError("Repository agent metering is invalid.", {
      provider: "repository-agent",
    });
  }
  if (
    metering.turns.length === 0 ||
    metering.turns.length > bounds.maximumTurns
  ) {
    throw new AiProviderError(
      "Repository agent reported an invalid number of observable turns.",
      { provider: "repository-agent" },
    );
  }
  const seenTurns = new Set<number>();
  for (const candidate of metering.turns) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("turn" in candidate) ||
      !("usage" in candidate) ||
      typeof candidate.usage !== "object" ||
      candidate.usage === null
    ) {
      throw new AiProviderError("Repository agent turn metadata is invalid.", {
        provider: "repository-agent",
      });
    }
    const turn = candidate as RepositoryAgentTurn;
    if (
      !Number.isSafeInteger(turn.turn) ||
      turn.turn < 1 ||
      turn.turn > bounds.maximumTurns ||
      seenTurns.has(turn.turn)
    ) {
      throw new AiProviderError("Repository agent turn metadata is invalid.", {
        provider: "repository-agent",
      });
    }
    seenTurns.add(turn.turn);
  }
  const usage = sumRepositoryAgentUsage(metering.turns);
  assertUsageWithinRepositoryAgentBounds(usage, bounds);
  if (result.usage !== undefined && !sameUsage(result.usage, usage)) {
    throw new AiProviderError(
      "Repository agent aggregate usage disagrees with its observable turns.",
      { provider: "repository-agent" },
    );
  }
  return {
    metering: "observableTurns",
    usage,
    turns: Object.freeze([...metering.turns]),
  };
}

function repositoryAgentMetadata(
  metadata: ProviderResult<unknown>["metadata"],
  accounting: RepositoryAgentAccounting | undefined,
): ProviderResult<unknown>["metadata"] {
  if (accounting === undefined) return metadata;
  return {
    ...metadata,
    rawRedacted: {
      ...(metadata.rawRedacted ?? {}),
      repositoryAgentMetering: accounting.metering,
      observableTurnCount: accounting.turns.length,
    },
  };
}

function repositoryAgentTurnMetadata(
  metadata: RepositoryAgentTurn["metadata"],
  turn: number,
): ProviderResult<unknown>["metadata"] {
  return {
    ...(metadata ?? { retryCount: 0 }),
    rawRedacted: {
      ...(metadata?.rawRedacted ?? {}),
      repositoryAgentTurn: turn,
    },
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
    const repositoryBounds =
      request.kind === "repositoryAgent"
        ? repositoryAgentTokenBounds(request.request, request.budget.hard)
        : undefined;
    const startedAt = this.dependencies.clock.now();
    const binding = await this.dependencies.bindingResolver.resolve({
      workspaceId: context.workspaceId,
      role: request.role,
      bindingVersionId: request.bindingVersionId,
      requiredCapabilities: requestedCapabilities(request),
      inputTokens:
        repositoryBounds?.maximumInputTokensPerTurn ??
        request.maximumInputTokens,
      outputTokens:
        repositoryBounds?.maximumOutputTokensPerTurn ??
        request.maximumOutputTokens,
    });
    const maximumInputTokens =
      repositoryBounds?.maximumInputTokens ??
      request.maximumInputTokens ??
      binding.maximumInputTokens;
    const maximumOutputTokens =
      request.kind === "repositoryAgent"
        ? repositoryBounds?.maximumOutputTokens
        : request.kind === "embedding" || request.kind === "reranker"
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
        ...(request.attribution === undefined
          ? {}
          : { attribution: request.attribution }),
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
      const accounting =
        request.kind === "repositoryAgent"
          ? repositoryAgentAccounting(
              providerResult,
              requireRepositoryAgentTokenBounds(repositoryBounds),
            )
          : undefined;
      const usage = accounting?.usage ?? providerResult.usage;
      const calculatedCost =
        usage === undefined
          ? ({ status: "unknown", components: [] } satisfies CostCalculation)
          : calculateCost(pricing, actualUsage(usage));
      const reconciliation = this.successReconciliation(
        reservation,
        calculatedCost,
        providerResult.providerCost,
        usage,
        request.budget.currency,
      );
      const children =
        accounting === undefined
          ? []
          : accounting.turns.map((turn) => {
              const childCalculatedCost = calculateCost(
                pricing,
                actualUsage(turn.usage),
              );
              const childOperationId = this.dependencies.operationIds.next();
              return {
                start: {
                  operationId: childOperationId,
                  parentOperationId: operationId,
                  workspaceId: context.workspaceId,
                  role: request.role,
                  operationKind: "repositoryAgentTurn",
                  bindingVersionId: binding.bindingVersionId,
                  providerInstanceVersionId: binding.providerInstanceVersionId,
                  catalogSnapshotId: binding.catalogSnapshotId,
                  configuredModel: binding.canonicalModel,
                  ...(request.attribution === undefined
                    ? {}
                    : { attribution: request.attribution }),
                  startedAt,
                  pricing,
                  reservation: childCalculatedCost,
                },
                finalization: {
                  operationId: childOperationId,
                  workspaceId: context.workspaceId,
                  status: "succeeded",
                  finishedAt,
                  usage: turn.usage,
                  metadata: repositoryAgentTurnMetadata(
                    turn.metadata,
                    turn.turn,
                  ),
                  calculatedCost: childCalculatedCost,
                },
              } satisfies ObservableChildOperation;
            });
      await this.finalize({
        operationId,
        workspaceId: context.workspaceId,
        status: usage === undefined ? "succeededUsageUnknown" : "succeeded",
        finishedAt,
        usage,
        metadata: repositoryAgentMetadata(providerResult.metadata, accounting),
        calculatedCost,
        providerCost: providerResult.providerCost,
        reconciliation,
        children,
      });
      return {
        operationId,
        value: providerResult.value as TResult,
        usage,
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
    readonly children?: readonly ObservableChildOperation[];
  }): Promise<void> {
    await this.dependencies.unitOfWork.transaction(async (transaction) => {
      for (const child of input.children ?? []) {
        await this.dependencies.ledger.start(transaction, child.start);
        await this.dependencies.ledger.finalize(
          transaction,
          child.finalization,
        );
      }
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
