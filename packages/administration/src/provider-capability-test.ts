import type {
  AiExecutionGateway,
  AiExecutionPreflightGateway,
  MeteredAiRequest,
} from "@caseweaver/ai-execution";
import type { Permission } from "@caseweaver/security";

import {
  AdministrationAuditUnavailableError,
  AdministrationNotFoundError,
  AdministrationValidationError,
  IdempotencyConflictError,
} from "./errors.js";

/** The server-owned action recorded for every provider capability-test outcome. */
export const providerCapabilityTestAuditAction =
  "admin.provider.capabilityTest" as const;

/** Capability tests are configuration operations; callers cannot select this permission. */
export const providerCapabilityTestPermission: Permission =
  "configuration.manage";

/** A test is deliberately short enough that it cannot become an ad-hoc workload. */
export const maximumProviderCapabilityTestTimeoutMs = 30_000;

export type ProviderCapabilityTestPricingStatus =
  | "known"
  | "unknown"
  | "incomplete";

export type ProviderCapabilityTestOutcome =
  | "succeeded"
  | "failed"
  | "denied"
  | "outcome_unknown";

export type ProviderCapabilityTestReasonCode =
  | "pricing.unknown"
  | "budget.policy_missing"
  | "confirmation.required"
  | "rate_limited"
  | "execution.failed";

export interface ProviderCapabilityTestCostEstimate {
  /** A decimal string; known zero is valid and distinct from an unknown price. */
  readonly amount: string;
  readonly currency: string;
}

/**
 * Correlation values are derived and bounded by the API boundary. They make an
 * administrative action traceable without letting browser input choose actor,
 * workspace, permission, target, outcome, or any secret-bearing detail.
 */
export interface ProviderCapabilityTestAuditMetadata {
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly uiActionId?: string;
  readonly traceId?: string;
  readonly clientAddress?: string;
  readonly userAgent?: string;
}

/**
 * A provider/binding version resolved from immutable server-side configuration.
 * `request` originates from a trusted descriptor/test-operation registration; it
 * is never constructed from browser prompt, secret, model, or endpoint values.
 */
export interface ImmutableProviderCapabilityTestConfiguration {
  readonly workspaceId: string;
  readonly providerInstanceId: string;
  readonly providerInstanceVersionId: string;
  readonly bindingVersionId: string;
  readonly testOperation: string;
  /**
   * SHA-256 of the immutable descriptor-owned test template. The configuration
   * adapter derives it from the persisted template; no browser input supplies
   * or selects it.
   */
  readonly templateDigest: string;
  readonly request: MeteredAiRequest;
  readonly timeoutMs: number;
  /** A capability test is unavailable until an applicable budget policy exists. */
  readonly budgetPolicy: Readonly<{
    readonly status: "configured" | "missing";
  }>;
}

/** Loads only immutable identity, metering, and safe test-template data. */
export interface ProviderCapabilityTestConfigurationStore {
  load(
    input: Readonly<{
      readonly workspaceId: string;
      readonly providerInstanceId: string;
      readonly testOperation: string;
    }>,
  ): Promise<ImmutableProviderCapabilityTestConfiguration | undefined>;
}

/**
 * The preview service owns impact computation and confirmation issuance. Consumption
 * must atomically bind one confirmation and its authoritative preview audit to
 * the current session, immutable binding, server-derived template digest, and
 * known conservative estimate.
 */
export interface ProviderCapabilityTestConfirmationStore {
  issueAndRecord(
    input: Readonly<{
      readonly workspaceId: string;
      readonly principalId: string;
      readonly sessionId: string;
      readonly providerInstanceId: string;
      readonly providerInstanceVersionId: string;
      readonly bindingVersionId: string;
      readonly testOperation: string;
      readonly templateDigest: string;
      readonly estimatedCost: ProviderCapabilityTestCostEstimate;
      readonly now: string;
      readonly audit: ProviderCapabilityTestPreviewAuditRecord;
    }>,
  ): Promise<ProviderCapabilityTestIssuedConfirmation>;
  /** Records a denied preview when no confirmation may be issued. */
  recordPreviewAudit(
    audit: ProviderCapabilityTestPreviewAuditRecord,
  ): Promise<void>;
  consume(
    input: Readonly<{
      readonly confirmationId: string;
      readonly workspaceId: string;
      readonly principalId: string;
      readonly sessionId: string;
      readonly providerInstanceId: string;
      readonly providerInstanceVersionId: string;
      readonly bindingVersionId: string;
      readonly testOperation: string;
      readonly templateDigest: string;
      readonly estimatedCost: ProviderCapabilityTestCostEstimate;
      readonly now: string;
    }>,
  ): Promise<boolean>;
}

/** Server-owned audit plan atomically persisted while issuing a confirmation. */
export interface ProviderCapabilityTestPreviewAuditRecord
  extends ProviderCapabilityTestAuditMetadata {
  readonly workspaceId: string;
  readonly actorPrincipalId: string;
  readonly action: "admin.provider.capabilityTest.preview";
  readonly targetType: "ai-provider-instance";
  readonly targetId: string;
  readonly permission: Permission;
  readonly outcome: "succeeded" | "denied";
  readonly reasonCode?: "pricing.unknown" | "budget.policy_missing";
  readonly occurredAt: string;
}

/** Server-rendered confirmation text/impact; it contains no provider response or secret. */
export interface ProviderCapabilityTestIssuedConfirmation {
  readonly confirmationId: string;
  readonly confirmation: string;
  readonly impact: string;
  readonly expiresAt: string;
}

export interface ProviderCapabilityTestPreviewCommand {
  /** Server-derived active workspace, principal, and session; never browser authority. */
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly providerInstanceId: string;
  readonly testOperation: string;
  readonly auditMetadata?: ProviderCapabilityTestAuditMetadata;
}

/** Safe preflight payload consumed by a resource-specific confirmation UI. */
export interface ProviderCapabilityTestPreview {
  readonly providerInstanceId: string;
  readonly providerInstanceVersionId: string;
  readonly bindingVersionId: string;
  readonly testOperation: string;
  readonly pricingStatus: ProviderCapabilityTestPricingStatus;
  readonly canConfirm: boolean;
  readonly reasonCode?: "pricing.unknown" | "budget.policy_missing";
  readonly confirmationId?: string;
  readonly confirmation?: string;
  readonly impact?: string;
  readonly estimatedCost?: ProviderCapabilityTestCostEstimate;
  readonly expiresAt?: string;
}

/** A rate limit is consumed only after a valid, one-use confirmation. */
export interface ProviderCapabilityTestRateLimiter {
  acquire(
    input: Readonly<{
      readonly workspaceId: string;
      readonly principalId: string;
      readonly providerInstanceId: string;
      readonly providerInstanceVersionId: string;
      readonly now: string;
    }>,
  ): Promise<Readonly<{ readonly allowed: boolean }>>;
}

/** Raw idempotency keys never cross this application boundary. */
export interface ProviderCapabilityTestIdempotency {
  readonly keyDigest: string;
}

export interface StoredProviderCapabilityTestResult {
  readonly id: string;
  readonly workspaceId: string;
  readonly providerInstanceId: string;
  readonly providerInstanceVersionId: string;
  readonly bindingVersionId: string;
  readonly testOperation: string;
  readonly outcome: Exclude<ProviderCapabilityTestOutcome, "outcome_unknown">;
  readonly operationId?: string;
  readonly estimatedCost?: ProviderCapabilityTestCostEstimate;
  readonly actualCost?: ProviderCapabilityTestCostEstimate;
  readonly reasonCode?: ProviderCapabilityTestReasonCode;
  readonly completedAt: string;
}

export type ProviderCapabilityTestClaim =
  | Readonly<{ readonly kind: "acquired"; readonly id: string }>
  | Readonly<{
      readonly kind: "replayed";
      readonly result: StoredProviderCapabilityTestResult;
    }>
  | Readonly<{ readonly kind: "inProgress"; readonly id: string }>
  | Readonly<{ readonly kind: "conflict" }>;

/**
 * Claiming is the durable idempotency boundary. An acquired claim must remain
 * in-progress if completion/auditing fails so a retry cannot duplicate an AI call.
 */
export interface ProviderCapabilityTestClaimStore {
  claim(
    input: Readonly<{
      readonly workspaceId: string;
      readonly principalId: string;
      readonly providerInstanceId: string;
      readonly providerInstanceVersionId: string;
      readonly bindingVersionId: string;
      readonly testOperation: string;
      readonly idempotency: ProviderCapabilityTestIdempotency;
      readonly createdAt: string;
    }>,
  ): Promise<ProviderCapabilityTestClaim>;
}

/** Server-owned audit plan persisted in the exact transaction as the terminal result. */
export interface ProviderCapabilityTestAuditRecord
  extends ProviderCapabilityTestAuditMetadata {
  readonly workspaceId: string;
  readonly actorPrincipalId: string;
  readonly action: typeof providerCapabilityTestAuditAction;
  readonly targetType: "ai-provider-instance";
  readonly targetId: string;
  readonly permission: Permission;
  readonly outcome: Exclude<ProviderCapabilityTestOutcome, "outcome_unknown">;
  readonly reasonCode?: ProviderCapabilityTestReasonCode;
  readonly idempotencyKeyDigest: string;
  readonly occurredAt: string;
}

/**
 * PostgreSQL implementations commit the terminal test result and this audit record
 * in one transaction. Secret values, request templates, model output, provider errors,
 * and provider SDK response objects are intentionally not accepted by this port.
 */
export interface ProviderCapabilityTestResultAuditStore {
  completeAndRecord(
    input: Readonly<{
      readonly claimId: string;
      readonly result: StoredProviderCapabilityTestResult;
      readonly audit: ProviderCapabilityTestAuditRecord;
    }>,
  ): Promise<StoredProviderCapabilityTestResult>;
}

export interface ProviderCapabilityTestClock {
  now(): string;
}

export interface ProviderCapabilityTestCommand {
  /** Server-derived active workspace, principal, and session; never browser authority. */
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly providerInstanceId: string;
  /** A safe operation key declared by the provider descriptor. */
  readonly testOperation: string;
  readonly confirmationId: string;
  readonly idempotency: ProviderCapabilityTestIdempotency;
  /** Route lifecycle cancellation is forwarded to the exclusive gateway. */
  readonly signal: AbortSignal;
  readonly auditMetadata?: ProviderCapabilityTestAuditMetadata;
}

export interface ProviderCapabilityTestResult {
  readonly id: string;
  readonly providerInstanceId: string;
  readonly providerInstanceVersionId: string;
  readonly bindingVersionId: string;
  readonly testOperation: string;
  readonly outcome: ProviderCapabilityTestOutcome;
  readonly operationId?: string;
  readonly estimatedCost?: ProviderCapabilityTestCostEstimate;
  readonly actualCost?: ProviderCapabilityTestCostEstimate;
  readonly reasonCode?: ProviderCapabilityTestReasonCode;
  readonly completedAt?: string;
  readonly idempotency: "created" | "replayed" | "in_progress";
}

export interface ProviderCapabilityTestDependencies {
  readonly configurations: ProviderCapabilityTestConfigurationStore;
  readonly confirmations: ProviderCapabilityTestConfirmationStore;
  readonly rateLimiter: ProviderCapabilityTestRateLimiter;
  readonly claims: ProviderCapabilityTestClaimStore;
  readonly results: ProviderCapabilityTestResultAuditStore;
  readonly preflight: AiExecutionPreflightGateway;
  readonly gateway: AiExecutionGateway;
  readonly clock: ProviderCapabilityTestClock;
}

/**
 * Produces the server-owned impact/cost confirmation required before a metered
 * provider test can run. This never invokes an AI provider or consumes rate limit.
 */
export class PreviewProviderCapabilityTest {
  public constructor(
    private readonly configurations: ProviderCapabilityTestConfigurationStore,
    private readonly confirmations: ProviderCapabilityTestConfirmationStore,
    private readonly preflight: AiExecutionPreflightGateway,
    private readonly clock: ProviderCapabilityTestClock,
  ) {}

  public async execute(
    command: ProviderCapabilityTestPreviewCommand,
  ): Promise<ProviderCapabilityTestPreview> {
    validatePreviewCommand(command);
    const configuration = await this.configurations.load({
      workspaceId: command.workspaceId,
      providerInstanceId: command.providerInstanceId,
      testOperation: command.testOperation,
    });
    if (configuration === undefined) throw new AdministrationNotFoundError();
    validateConfiguration(configuration, command);
    const now = requiredTimestamp(this.clock.now());
    if (configuration.budgetPolicy.status === "missing") {
      await this.recordDeniedPreview(
        command,
        configuration,
        now,
        "budget.policy_missing",
      );
      return Object.freeze({
        providerInstanceId: configuration.providerInstanceId,
        providerInstanceVersionId: configuration.providerInstanceVersionId,
        bindingVersionId: configuration.bindingVersionId,
        testOperation: configuration.testOperation,
        pricingStatus: "known",
        canConfirm: false,
        reasonCode: "budget.policy_missing",
      });
    }
    let preflight: Awaited<ReturnType<typeof preflightProviderCapabilityTest>>;
    try {
      preflight = await preflightProviderCapabilityTest(
        this.preflight,
        configuration,
        command.workspaceId,
      );
    } catch {
      await this.recordDeniedPreview(
        command,
        configuration,
        now,
        "pricing.unknown",
      );
      return deniedPreview(configuration, "unknown", "pricing.unknown");
    }
    if (preflight.pricingStatus !== "known") {
      await this.recordDeniedPreview(
        command,
        configuration,
        now,
        "pricing.unknown",
      );
      return deniedPreview(
        configuration,
        preflight.pricingStatus,
        "pricing.unknown",
      );
    }
    const estimatedCost = preflight.estimatedCost;
    let issued: ProviderCapabilityTestIssuedConfirmation;
    try {
      issued = await this.confirmations.issueAndRecord({
        workspaceId: command.workspaceId,
        principalId: command.principalId,
        sessionId: command.sessionId,
        providerInstanceId: configuration.providerInstanceId,
        providerInstanceVersionId: configuration.providerInstanceVersionId,
        bindingVersionId: configuration.bindingVersionId,
        testOperation: configuration.testOperation,
        templateDigest: configuration.templateDigest,
        estimatedCost,
        now,
        audit: previewAudit(command, configuration, now, "succeeded"),
      });
    } catch {
      throw new AdministrationAuditUnavailableError();
    }
    validateIssuedConfirmation(issued, now);
    return Object.freeze({
      providerInstanceId: configuration.providerInstanceId,
      providerInstanceVersionId: configuration.providerInstanceVersionId,
      bindingVersionId: configuration.bindingVersionId,
      testOperation: configuration.testOperation,
      pricingStatus: "known",
      canConfirm: true,
      confirmationId: issued.confirmationId,
      confirmation: issued.confirmation,
      impact: issued.impact,
      estimatedCost,
      expiresAt: issued.expiresAt,
    });
  }

  private async recordDeniedPreview(
    command: ProviderCapabilityTestPreviewCommand,
    configuration: ImmutableProviderCapabilityTestConfiguration,
    now: string,
    reasonCode: "pricing.unknown" | "budget.policy_missing",
  ): Promise<void> {
    try {
      await this.confirmations.recordPreviewAudit(
        previewAudit(command, configuration, now, "denied", reasonCode),
      );
    } catch {
      throw new AdministrationAuditUnavailableError();
    }
  }
}

/**
 * Executes one descriptor-declared provider test through the exclusive metered
 * AI gateway. The administration layer never resolves a secret, contacts a
 * provider directly, chooses a model, or treats unknown cost as zero.
 */
export class RunProviderCapabilityTest {
  public constructor(
    private readonly dependencies: ProviderCapabilityTestDependencies,
  ) {}

  public async execute(
    command: ProviderCapabilityTestCommand,
  ): Promise<ProviderCapabilityTestResult> {
    validateCommand(command);
    const configuration = await this.dependencies.configurations.load({
      workspaceId: command.workspaceId,
      providerInstanceId: command.providerInstanceId,
      testOperation: command.testOperation,
    });
    if (configuration === undefined) throw new AdministrationNotFoundError();
    validateConfiguration(configuration, command);
    const now = requiredTimestamp(this.dependencies.clock.now());
    const claim = await this.dependencies.claims.claim({
      workspaceId: command.workspaceId,
      principalId: command.principalId,
      providerInstanceId: configuration.providerInstanceId,
      providerInstanceVersionId: configuration.providerInstanceVersionId,
      bindingVersionId: configuration.bindingVersionId,
      testOperation: configuration.testOperation,
      idempotency: command.idempotency,
      createdAt: now,
    });
    if (claim.kind === "conflict") throw new IdempotencyConflictError();
    if (claim.kind === "replayed") return present(claim.result, "replayed");
    if (claim.kind === "inProgress") {
      return Object.freeze({
        id: claim.id,
        providerInstanceId: configuration.providerInstanceId,
        providerInstanceVersionId: configuration.providerInstanceVersionId,
        bindingVersionId: configuration.bindingVersionId,
        testOperation: configuration.testOperation,
        outcome: "outcome_unknown",
        idempotency: "in_progress",
      });
    }

    try {
      if (configuration.budgetPolicy.status === "missing") {
        return this.complete(
          claim.id,
          command,
          configuration,
          terminalResult({
            id: claim.id,
            configuration,
            outcome: "denied",
            reasonCode: "budget.policy_missing",
            completedAt: now,
          }),
        );
      }
      const preflight = await preflightProviderCapabilityTest(
        this.dependencies.preflight,
        configuration,
        command.workspaceId,
      );
      if (preflight.pricingStatus !== "known") {
        return this.complete(
          claim.id,
          command,
          configuration,
          terminalResult({
            id: claim.id,
            configuration,
            outcome: "denied",
            reasonCode: "pricing.unknown",
            completedAt: now,
          }),
        );
      }
      const estimatedCost = preflight.estimatedCost;
      const confirmed = await this.dependencies.confirmations.consume({
        confirmationId: command.confirmationId,
        workspaceId: command.workspaceId,
        principalId: command.principalId,
        sessionId: command.sessionId,
        providerInstanceId: configuration.providerInstanceId,
        providerInstanceVersionId: configuration.providerInstanceVersionId,
        bindingVersionId: configuration.bindingVersionId,
        testOperation: configuration.testOperation,
        templateDigest: configuration.templateDigest,
        estimatedCost,
        now,
      });
      if (!confirmed) {
        return this.complete(
          claim.id,
          command,
          configuration,
          terminalResult({
            id: claim.id,
            configuration,
            outcome: "denied",
            reasonCode: "confirmation.required",
            estimatedCost,
            completedAt: now,
          }),
        );
      }
      const rate = await this.dependencies.rateLimiter.acquire({
        workspaceId: command.workspaceId,
        principalId: command.principalId,
        providerInstanceId: configuration.providerInstanceId,
        providerInstanceVersionId: configuration.providerInstanceVersionId,
        now,
      });
      if (!rate.allowed) {
        return this.complete(
          claim.id,
          command,
          configuration,
          terminalResult({
            id: claim.id,
            configuration,
            outcome: "denied",
            reasonCode: "rate_limited",
            estimatedCost,
            completedAt: now,
          }),
        );
      }

      let execution: Awaited<ReturnType<AiExecutionGateway["execute"]>>;
      try {
        execution = await this.dependencies.gateway.execute(
          meteredTestRequest(configuration, estimatedCost),
          { workspaceId: command.workspaceId, signal: command.signal },
        );
      } catch {
        return this.complete(
          claim.id,
          command,
          configuration,
          terminalResult({
            id: claim.id,
            configuration,
            outcome: "failed",
            reasonCode: "execution.failed",
            estimatedCost,
            completedAt: requiredTimestamp(this.dependencies.clock.now()),
          }),
        );
      }
      const completedAt = requiredTimestamp(this.dependencies.clock.now());
      const actualCost = knownExecutionCost(execution.calculatedCost);
      if (
        actualCost === undefined ||
        actualCost.currency !== estimatedCost.currency
      ) {
        return this.complete(
          claim.id,
          command,
          configuration,
          terminalResult({
            id: claim.id,
            configuration,
            outcome: "failed",
            reasonCode: "pricing.unknown",
            estimatedCost,
            completedAt,
          }),
        );
      }
      return this.complete(
        claim.id,
        command,
        configuration,
        terminalResult({
          id: claim.id,
          configuration,
          outcome: "succeeded",
          operationId: execution.operationId,
          estimatedCost,
          actualCost,
          completedAt,
        }),
      );
    } catch (error) {
      if (error instanceof AdministrationAuditUnavailableError) throw error;
      // A pre-dispatch failure (preflight, confirmation, or rate persistence)
      // is terminal too. Completing it prevents an acquired idempotency claim
      // from becoming an unbounded in-progress record without invoking AI.
      return this.complete(
        claim.id,
        command,
        configuration,
        terminalResult({
          id: claim.id,
          configuration,
          outcome: "failed",
          reasonCode: "execution.failed",
          completedAt: now,
        }),
      );
    }
  }

  private async complete(
    claimId: string,
    command: ProviderCapabilityTestCommand,
    configuration: ImmutableProviderCapabilityTestConfiguration,
    result: StoredProviderCapabilityTestResult,
  ): Promise<ProviderCapabilityTestResult> {
    try {
      const stored = await this.dependencies.results.completeAndRecord({
        claimId,
        result,
        audit: Object.freeze({
          workspaceId: command.workspaceId,
          actorPrincipalId: command.principalId,
          action: providerCapabilityTestAuditAction,
          targetType: "ai-provider-instance",
          targetId: configuration.providerInstanceId,
          permission: providerCapabilityTestPermission,
          outcome: result.outcome,
          ...(result.reasonCode === undefined
            ? {}
            : { reasonCode: result.reasonCode }),
          idempotencyKeyDigest: command.idempotency.keyDigest,
          occurredAt: result.completedAt,
          ...auditMetadata(command.auditMetadata),
        }),
      });
      return present(stored, "created");
    } catch {
      // A state-changing AI call without its authoritative administration audit
      // must fail closed. Its claim remains in progress to prevent a duplicate call.
      throw new AdministrationAuditUnavailableError();
    }
  }
}

function previewAudit(
  command: ProviderCapabilityTestPreviewCommand,
  configuration: ImmutableProviderCapabilityTestConfiguration,
  occurredAt: string,
  outcome: ProviderCapabilityTestPreviewAuditRecord["outcome"],
  reasonCode?: "pricing.unknown" | "budget.policy_missing",
): ProviderCapabilityTestPreviewAuditRecord {
  return Object.freeze({
    workspaceId: command.workspaceId,
    actorPrincipalId: command.principalId,
    action: "admin.provider.capabilityTest.preview",
    targetType: "ai-provider-instance",
    targetId: configuration.providerInstanceId,
    permission: providerCapabilityTestPermission,
    outcome,
    ...(reasonCode === undefined ? {} : { reasonCode }),
    occurredAt,
    ...auditMetadata(command.auditMetadata),
  });
}

function deniedPreview(
  configuration: ImmutableProviderCapabilityTestConfiguration,
  pricingStatus: Exclude<ProviderCapabilityTestPricingStatus, "known">,
  reasonCode: "pricing.unknown" | "budget.policy_missing",
): ProviderCapabilityTestPreview {
  return Object.freeze({
    providerInstanceId: configuration.providerInstanceId,
    providerInstanceVersionId: configuration.providerInstanceVersionId,
    bindingVersionId: configuration.bindingVersionId,
    testOperation: configuration.testOperation,
    pricingStatus,
    canConfirm: false,
    reasonCode,
  });
}

function auditMetadata(
  metadata: ProviderCapabilityTestAuditMetadata | undefined,
): ProviderCapabilityTestAuditMetadata {
  return metadata === undefined ? {} : metadata;
}

function present(
  result: StoredProviderCapabilityTestResult,
  idempotency: ProviderCapabilityTestResult["idempotency"],
): ProviderCapabilityTestResult {
  return Object.freeze({
    id: result.id,
    providerInstanceId: result.providerInstanceId,
    providerInstanceVersionId: result.providerInstanceVersionId,
    bindingVersionId: result.bindingVersionId,
    testOperation: result.testOperation,
    outcome: result.outcome,
    ...(result.operationId === undefined
      ? {}
      : { operationId: result.operationId }),
    ...(result.estimatedCost === undefined
      ? {}
      : { estimatedCost: result.estimatedCost }),
    ...(result.actualCost === undefined
      ? {}
      : { actualCost: result.actualCost }),
    ...(result.reasonCode === undefined
      ? {}
      : { reasonCode: result.reasonCode }),
    completedAt: result.completedAt,
    idempotency,
  });
}

function terminalResult(
  input: Readonly<{
    readonly id: string;
    readonly configuration: ImmutableProviderCapabilityTestConfiguration;
    readonly outcome: Exclude<ProviderCapabilityTestOutcome, "outcome_unknown">;
    readonly operationId?: string;
    readonly estimatedCost?: ProviderCapabilityTestCostEstimate;
    readonly actualCost?: ProviderCapabilityTestCostEstimate;
    readonly reasonCode?: ProviderCapabilityTestReasonCode;
    readonly completedAt: string;
  }>,
): StoredProviderCapabilityTestResult {
  return Object.freeze({
    id: input.id,
    workspaceId: input.configuration.workspaceId,
    providerInstanceId: input.configuration.providerInstanceId,
    providerInstanceVersionId: input.configuration.providerInstanceVersionId,
    bindingVersionId: input.configuration.bindingVersionId,
    testOperation: input.configuration.testOperation,
    outcome: input.outcome,
    ...(input.operationId === undefined
      ? {}
      : { operationId: input.operationId }),
    ...(input.estimatedCost === undefined
      ? {}
      : { estimatedCost: input.estimatedCost }),
    ...(input.actualCost === undefined ? {} : { actualCost: input.actualCost }),
    ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
    completedAt: input.completedAt,
  });
}

function meteredTestRequest(
  configuration: ImmutableProviderCapabilityTestConfiguration,
  estimatedCost: ProviderCapabilityTestCostEstimate,
): MeteredAiRequest {
  return boundMeteredTestRequest(
    configuration,
    Object.freeze({
      currency: estimatedCost.currency,
      hard: true,
      requireBudgetPolicy: true,
      // Do not add an unknown-pricing bypass. The exclusive gateway rejects it.
    }),
  );
}

function boundMeteredTestRequest(
  configuration: ImmutableProviderCapabilityTestConfiguration,
  budget: MeteredAiRequest["budget"],
): MeteredAiRequest {
  const request = configuration.request;
  const common = Object.freeze({
    role: request.role,
    ...(request.requiredCapabilities === undefined
      ? {}
      : { requiredCapabilities: request.requiredCapabilities }),
    ...(request.maximumInputTokens === undefined
      ? {}
      : { maximumInputTokens: request.maximumInputTokens }),
    ...(request.maximumOutputTokens === undefined
      ? {}
      : { maximumOutputTokens: request.maximumOutputTokens }),
    ...(request.priceContext === undefined
      ? {}
      : { priceContext: request.priceContext }),
    bindingVersionId: configuration.bindingVersionId,
    timeoutMs: configuration.timeoutMs,
    budget,
  });
  switch (request.kind) {
    case "embedding":
      return Object.freeze({
        kind: "embedding",
        request: request.request,
        ...common,
      });
    case "vision":
      return Object.freeze({
        kind: "vision",
        request: request.request,
        ...common,
      });
    case "generation":
      return Object.freeze({
        kind: "generation",
        request: request.request,
        ...common,
      });
    case "reranker":
      return Object.freeze({
        kind: "reranker",
        request: request.request,
        ...common,
      });
    case "repositoryAgent":
      return Object.freeze({
        kind: "repositoryAgent",
        request: request.request,
        ...common,
      });
  }
}

function knownExecutionCost(
  calculated: Readonly<{
    readonly status: ProviderCapabilityTestPricingStatus;
    readonly amount?: string;
    readonly currency?: string;
  }>,
): ProviderCapabilityTestCostEstimate | undefined {
  if (
    calculated.status !== "known" ||
    calculated.amount === undefined ||
    calculated.currency === undefined
  ) {
    return undefined;
  }
  return validCostEstimate({
    amount: calculated.amount,
    currency: calculated.currency,
  });
}

async function preflightProviderCapabilityTest(
  gateway: AiExecutionPreflightGateway,
  configuration: ImmutableProviderCapabilityTestConfiguration,
  workspaceId: string,
): Promise<
  | Readonly<{
      readonly pricingStatus: Exclude<
        ProviderCapabilityTestPricingStatus,
        "known"
      >;
    }>
  | Readonly<{
      readonly pricingStatus: "known";
      readonly estimatedCost: ProviderCapabilityTestCostEstimate;
    }>
> {
  const preflight = await gateway.preflight(
    boundMeteredTestRequest(
      configuration,
      Object.freeze({
        currency: configuration.request.budget.currency,
        hard: true,
        requireBudgetPolicy: true,
      }),
    ),
    { workspaceId },
  );
  if (
    preflight.bindingVersionId !== configuration.bindingVersionId ||
    preflight.providerInstanceVersionId !==
      configuration.providerInstanceVersionId
  ) {
    throw new AdministrationValidationError();
  }
  if (preflight.conservativeCost.status !== "known") {
    return Object.freeze({ pricingStatus: preflight.conservativeCost.status });
  }
  if (
    preflight.conservativeCost.amount === undefined ||
    preflight.conservativeCost.currency === undefined
  ) {
    throw new AdministrationValidationError();
  }
  return Object.freeze({
    pricingStatus: "known",
    estimatedCost: validCostEstimate({
      amount: preflight.conservativeCost.amount,
      currency: preflight.conservativeCost.currency,
    }),
  });
}

function validateConfiguration(
  configuration: ImmutableProviderCapabilityTestConfiguration,
  command: Pick<
    ProviderCapabilityTestCommand,
    "workspaceId" | "providerInstanceId" | "testOperation"
  >,
): void {
  requireIdentifier(configuration.workspaceId);
  requireIdentifier(configuration.providerInstanceId);
  requireIdentifier(configuration.providerInstanceVersionId);
  requireIdentifier(configuration.bindingVersionId);
  requireIdentifier(configuration.testOperation);
  requireDigest(configuration.templateDigest);
  if (
    configuration.workspaceId !== command.workspaceId ||
    configuration.providerInstanceId !== command.providerInstanceId ||
    configuration.testOperation !== command.testOperation
  ) {
    throw new AdministrationValidationError();
  }
  if (
    configuration.request.bindingVersionId !== undefined &&
    configuration.request.bindingVersionId !== configuration.bindingVersionId
  ) {
    throw new AdministrationValidationError();
  }
  if (
    !Number.isSafeInteger(configuration.timeoutMs) ||
    configuration.timeoutMs < 1 ||
    configuration.timeoutMs > maximumProviderCapabilityTestTimeoutMs
  ) {
    throw new AdministrationValidationError();
  }
  if (
    configuration.budgetPolicy.status !== "configured" &&
    configuration.budgetPolicy.status !== "missing"
  ) {
    throw new AdministrationValidationError();
  }
}

function validateCommand(command: ProviderCapabilityTestCommand): void {
  requireIdentifier(command.workspaceId);
  requireIdentifier(command.principalId);
  requireIdentifier(command.sessionId);
  requireIdentifier(command.providerInstanceId);
  requireIdentifier(command.testOperation);
  requireIdentifier(command.confirmationId);
  requireDigest(command.idempotency.keyDigest);
  validateAuditMetadata(command.auditMetadata);
}

function validatePreviewCommand(
  command: ProviderCapabilityTestPreviewCommand,
): void {
  requireIdentifier(command.workspaceId);
  requireIdentifier(command.principalId);
  requireIdentifier(command.sessionId);
  requireIdentifier(command.providerInstanceId);
  requireIdentifier(command.testOperation);
  validateAuditMetadata(command.auditMetadata);
}

function validateAuditMetadata(
  metadata: ProviderCapabilityTestAuditMetadata | undefined,
): void {
  if (metadata === undefined) return;
  for (const value of [
    metadata.requestId,
    metadata.correlationId,
    metadata.uiActionId,
    metadata.traceId,
  ]) {
    if (value !== undefined) requireIdentifier(value);
  }
  for (const value of [metadata.clientAddress, metadata.userAgent]) {
    if (
      value !== undefined &&
      (value.length < 1 ||
        value.length > 512 ||
        containsAsciiControlCharacter(value))
    ) {
      throw new AdministrationValidationError();
    }
  }
}

function containsAsciiControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function validateIssuedConfirmation(
  issued: ProviderCapabilityTestIssuedConfirmation,
  now: string,
): void {
  requireIdentifier(issued.confirmationId);
  requireBoundedText(issued.confirmation);
  requireBoundedText(issued.impact);
  const expiry = requiredTimestamp(issued.expiresAt);
  if (new Date(expiry).getTime() <= new Date(now).getTime()) {
    throw new AdministrationValidationError();
  }
}

function requireBoundedText(value: string): void {
  if (
    value.trim().length < 1 ||
    value.length > 2_000 ||
    /[\r\n]/u.test(value)
  ) {
    throw new AdministrationValidationError();
  }
}

function validCostEstimate(
  estimate: ProviderCapabilityTestCostEstimate,
): ProviderCapabilityTestCostEstimate {
  if (
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(estimate.amount) ||
    !/^[A-Z]{3}$/u.test(estimate.currency)
  ) {
    throw new AdministrationValidationError();
  }
  return Object.freeze({
    amount: estimate.amount,
    currency: estimate.currency,
  });
}

function requireIdentifier(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)) {
    throw new AdministrationValidationError();
  }
}

function requireDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/iu.test(value)) {
    throw new AdministrationValidationError();
  }
}

function requiredTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (
    !Number.isFinite(timestamp.getTime()) ||
    timestamp.toISOString() !== value
  ) {
    throw new AdministrationValidationError();
  }
  return value;
}
