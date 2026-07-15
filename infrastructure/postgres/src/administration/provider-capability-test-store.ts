import { createHash, randomUUID } from "node:crypto";
import {
  type ImmutableProviderCapabilityTestConfiguration,
  type ProviderCapabilityTestAuditRecord,
  type ProviderCapabilityTestClaim,
  type ProviderCapabilityTestClaimStore,
  type ProviderCapabilityTestConfigurationStore,
  type ProviderCapabilityTestConfirmationStore,
  type ProviderCapabilityTestCostEstimate,
  type ProviderCapabilityTestIssuedConfirmation,
  type ProviderCapabilityTestPreviewAuditRecord,
  type ProviderCapabilityTestRateLimiter,
  type ProviderCapabilityTestReasonCode,
  type ProviderCapabilityTestResultAuditStore,
  providerCapabilityTestAuditAction,
  providerCapabilityTestPermission,
  type StoredProviderCapabilityTestResult,
} from "@caseweaver/administration";
import type { MeteredAiRequest } from "@caseweaver/ai-execution";
import type { Prisma, PrismaClient } from "@prisma/client";

type Database = PrismaClient | Prisma.TransactionClient;

const previewAuditAction = "admin.provider.capabilityTest.preview" as const;
const confirmationTtlMs = 5 * 60 * 1_000;
const rateWindowMs = 10 * 60 * 1_000;
const rateLimit = 5;

/**
 * Trusted composition registers a safe, immutable test template per provider
 * descriptor type and operation. This seam deliberately contains no resolved
 * credential, endpoint, provider client, or browser-controlled input.
 */
export interface ProviderCapabilityTestTemplateLookup {
  load(
    input: Readonly<{
      readonly providerType: string;
      readonly testOperation: string;
    }>,
  ): Promise<
    | Readonly<{
        readonly templateDigest: string;
        readonly request: MeteredAiRequest;
        readonly timeoutMs: number;
      }>
    | undefined
  >;
}

/**
 * Resolves an active provider instance through its current immutable version,
 * a workspace role default bound to that exact provider version, a registered
 * safe test template, and an active persisted budget policy. The execution
 * gateway remains the authority for capability, price, and final policy checks.
 */
export class PostgresProviderCapabilityTestConfigurationStore
  implements ProviderCapabilityTestConfigurationStore
{
  public constructor(
    private readonly client: PrismaClient,
    private readonly templates: ProviderCapabilityTestTemplateLookup,
  ) {}

  public async load(
    input: Readonly<{
      readonly workspaceId: string;
      readonly providerInstanceId: string;
      readonly testOperation: string;
    }>,
  ): Promise<ImmutableProviderCapabilityTestConfiguration | undefined> {
    const provider = await this.client.aiProviderInstance.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: input.providerInstanceId,
        },
      },
      select: { providerType: true, lifecycle: true },
    });
    if (provider === null || provider.lifecycle !== "active") return undefined;

    const template = await this.templates.load({
      providerType: provider.providerType,
      testOperation: input.testOperation,
    });
    if (template === undefined) return undefined;

    const providerVersion =
      await this.client.aiProviderInstanceVersion.findFirst({
        where: {
          workspaceId: input.workspaceId,
          providerInstanceId: input.providerInstanceId,
        },
        orderBy: { version: "desc" },
        select: { id: true },
      });
    if (providerVersion === null) return undefined;

    const defaultBinding =
      await this.client.aiWorkspaceBindingDefault.findUnique({
        where: {
          workspaceId_role: {
            workspaceId: input.workspaceId,
            role: template.request.role,
          },
        },
        select: { modelBindingVersionId: true },
      });
    if (defaultBinding === null) return undefined;

    const bindingVersion = await this.client.aiModelBindingVersion.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: defaultBinding.modelBindingVersionId,
        },
      },
      select: {
        id: true,
        modelBindingId: true,
        providerInstanceVersionId: true,
      },
    });
    if (
      bindingVersion === null ||
      bindingVersion.providerInstanceVersionId !== providerVersion.id
    ) {
      return undefined;
    }

    const binding = await this.client.aiModelBinding.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: bindingVersion.modelBindingId,
        },
      },
      select: { lifecycle: true, activeVersionId: true },
    });
    if (
      binding === null ||
      binding.lifecycle !== "active" ||
      binding.activeVersionId !== bindingVersion.id
    ) {
      return undefined;
    }

    const budgetPolicyCount = await this.client.aiBudgetPolicy.count({
      where: {
        workspaceId: input.workspaceId,
        active: true,
        hard: true,
        currency: template.request.budget.currency,
      },
    });
    return Object.freeze({
      workspaceId: input.workspaceId,
      providerInstanceId: input.providerInstanceId,
      providerInstanceVersionId: providerVersion.id,
      bindingVersionId: bindingVersion.id,
      testOperation: input.testOperation,
      templateDigest: template.templateDigest,
      request: template.request,
      timeoutMs: template.timeoutMs,
      budgetPolicy: Object.freeze({
        status: budgetPolicyCount > 0 ? "configured" : "missing",
      }),
    });
  }
}

/**
 * Durable PostgreSQL boundaries for the provider-neutral capability-test use
 * case. Every mutation is workspace-scoped, uses server-owned values only, and
 * records its required audit event in the same database transaction.
 */
export class PostgresProviderCapabilityTestStore
  implements
    ProviderCapabilityTestConfirmationStore,
    ProviderCapabilityTestRateLimiter,
    ProviderCapabilityTestClaimStore,
    ProviderCapabilityTestResultAuditStore
{
  private readonly confirmationTtlMs: number;
  private readonly rateWindowMs: number;
  private readonly rateLimit: number;
  private readonly nextId: () => string;

  public constructor(
    private readonly client: PrismaClient,
    input: Readonly<{
      readonly confirmationTtlMs?: number;
      readonly rateWindowMs?: number;
      readonly rateLimit?: number;
      readonly nextId?: () => string;
    }> = {},
  ) {
    this.confirmationTtlMs = requirePositiveDuration(
      input.confirmationTtlMs ?? confirmationTtlMs,
      "Confirmation lifetime",
    );
    this.rateWindowMs = requirePositiveDuration(
      input.rateWindowMs ?? rateWindowMs,
      "Rate-limit window",
    );
    this.rateLimit = requirePositiveInteger(input.rateLimit ?? rateLimit);
    this.nextId = input.nextId ?? randomUUID;
  }

  public async issueAndRecord(
    input: Parameters<
      ProviderCapabilityTestConfirmationStore["issueAndRecord"]
    >[0],
  ): Promise<ProviderCapabilityTestIssuedConfirmation> {
    assertPreviewAudit(input);
    const now = asDate(input.now);
    const expiresAt = new Date(now.getTime() + this.confirmationTtlMs);
    const confirmationId = this.nextId();
    const confirmation = "Run provider capability test";
    const impact = `A metered provider capability test will run with a hard budget and a maximum 30-second timeout. Estimated cost: ${input.estimatedCost.amount} ${input.estimatedCost.currency}.`;
    return this.client.$transaction(async (database) => {
      await database.administrationProviderCapabilityTestConfirmation.create({
        data: {
          id: confirmationId,
          workspaceId: input.workspaceId,
          principalId: input.principalId,
          sessionId: input.sessionId,
          providerInstanceId: input.providerInstanceId,
          providerInstanceVersionId: input.providerInstanceVersionId,
          bindingVersionId: input.bindingVersionId,
          testOperation: input.testOperation,
          templateDigest: input.templateDigest,
          estimatedAmount: input.estimatedCost.amount,
          estimatedCurrency: input.estimatedCost.currency,
          confirmation,
          impact,
          expiresAt,
          createdAt: now,
        },
      });
      await database.auditEvent.create({
        data: {
          id: this.nextId(),
          workspaceId: input.audit.workspaceId,
          actorPrincipalId: input.audit.actorPrincipalId,
          action: input.audit.action,
          targetId: input.audit.targetId,
          targetType: input.audit.targetType,
          permission: input.audit.permission,
          outcome: input.audit.outcome,
          reasonCode: input.audit.reasonCode,
          requestId: input.audit.requestId,
          correlationId: input.audit.correlationId,
          uiActionId: input.audit.uiActionId,
          traceId: input.audit.traceId,
          clientAddress: input.audit.clientAddress,
          userAgent: input.audit.userAgent,
          origin: "admin_ui",
          occurredAt: asDate(input.audit.occurredAt),
        },
      });
      return Object.freeze({
        confirmationId,
        confirmation,
        impact,
        expiresAt: expiresAt.toISOString(),
      });
    });
  }

  public async recordPreviewAudit(
    audit: ProviderCapabilityTestPreviewAuditRecord,
  ): Promise<void> {
    assertDeniedPreviewAudit(audit);
    await this.client.$transaction(async (database) => {
      await database.auditEvent.create({
        data: {
          id: this.nextId(),
          workspaceId: audit.workspaceId,
          actorPrincipalId: audit.actorPrincipalId,
          action: audit.action,
          targetId: audit.targetId,
          targetType: audit.targetType,
          permission: audit.permission,
          outcome: audit.outcome,
          reasonCode: audit.reasonCode,
          requestId: audit.requestId,
          correlationId: audit.correlationId,
          uiActionId: audit.uiActionId,
          traceId: audit.traceId,
          clientAddress: audit.clientAddress,
          userAgent: audit.userAgent,
          origin: "admin_ui",
          occurredAt: asDate(audit.occurredAt),
        },
      });
    });
  }

  public async consume(
    input: Parameters<ProviderCapabilityTestConfirmationStore["consume"]>[0],
  ): Promise<boolean> {
    const consumed =
      await this.client.administrationProviderCapabilityTestConfirmation.updateMany(
        {
          where: {
            id: input.confirmationId,
            workspaceId: input.workspaceId,
            principalId: input.principalId,
            sessionId: input.sessionId,
            providerInstanceId: input.providerInstanceId,
            providerInstanceVersionId: input.providerInstanceVersionId,
            bindingVersionId: input.bindingVersionId,
            testOperation: input.testOperation,
            templateDigest: input.templateDigest,
            estimatedAmount: input.estimatedCost.amount,
            estimatedCurrency: input.estimatedCost.currency,
            expiresAt: { gt: asDate(input.now) },
            consumedAt: null,
          },
          data: { consumedAt: asDate(input.now) },
        },
      );
    return consumed.count === 1;
  }

  /**
   * The bucket uses `statement_timestamp()` inside PostgreSQL; a route clock
   * cannot grant additional capacity by presenting an old or future timestamp.
   */
  public async acquire(
    input: Parameters<ProviderCapabilityTestRateLimiter["acquire"]>[0],
  ): Promise<Readonly<{ readonly allowed: boolean }>> {
    const rows = await this.client.$queryRaw<
      readonly Readonly<{ readonly acquired_count: number }>[]
    >`
      WITH current_window AS (
        SELECT date_bin(
          (${this.rateWindowMs} * INTERVAL '1 millisecond'),
          statement_timestamp(),
          TIMESTAMPTZ '2000-01-01 00:00:00+00'
        ) AS window_started_at
      )
      INSERT INTO administration_provider_capability_test_rate_windows (
        workspace_id, principal_id, provider_instance_id,
        provider_instance_version_id, window_started_at, acquired_count
      )
      SELECT
        ${input.workspaceId}, ${input.principalId}, ${input.providerInstanceId},
        ${input.providerInstanceVersionId}, current_window.window_started_at, 1
      FROM current_window
      ON CONFLICT (
        workspace_id, principal_id, provider_instance_id,
        provider_instance_version_id, window_started_at
      ) DO UPDATE
      SET acquired_count = administration_provider_capability_test_rate_windows.acquired_count + 1
      WHERE administration_provider_capability_test_rate_windows.acquired_count < ${this.rateLimit}
      RETURNING acquired_count
    `;
    return Object.freeze({ allowed: rows.length === 1 });
  }

  public async claim(
    input: Parameters<ProviderCapabilityTestClaimStore["claim"]>[0],
  ): Promise<ProviderCapabilityTestClaim> {
    return this.client.$transaction(async (database) => {
      await database.$queryRaw`
        SELECT 1 AS locked
        FROM pg_advisory_xact_lock(
          hashtextextended(${claimLockKey(input.workspaceId, input.idempotency.keyDigest)}, 0)
        )
      `;
      const existing =
        await database.administrationProviderCapabilityTestClaim.findUnique({
          where: {
            workspaceId_keyDigest: {
              workspaceId: input.workspaceId,
              keyDigest: input.idempotency.keyDigest,
            },
          },
        });
      const fingerprint = requestFingerprint(input);
      if (existing !== null) {
        if (existing.requestFingerprint !== fingerprint) {
          return Object.freeze({ kind: "conflict" });
        }
        const result =
          await database.administrationProviderCapabilityTestResult.findUnique({
            where: { claimId: existing.id },
          });
        if (result !== null) {
          return Object.freeze({ kind: "replayed", result: asResult(result) });
        }
        return Object.freeze({ kind: "inProgress", id: existing.id });
      }
      const id = this.nextId();
      await database.administrationProviderCapabilityTestClaim.create({
        data: {
          id,
          workspaceId: input.workspaceId,
          principalId: input.principalId,
          providerInstanceId: input.providerInstanceId,
          providerInstanceVersionId: input.providerInstanceVersionId,
          bindingVersionId: input.bindingVersionId,
          testOperation: input.testOperation,
          keyDigest: input.idempotency.keyDigest,
          requestFingerprint: fingerprint,
          createdAt: asDate(input.createdAt),
        },
      });
      return Object.freeze({ kind: "acquired", id });
    });
  }

  public async completeAndRecord(
    input: Parameters<
      ProviderCapabilityTestResultAuditStore["completeAndRecord"]
    >[0],
  ): Promise<StoredProviderCapabilityTestResult> {
    return this.client.$transaction(async (database) => {
      const claim = await lockClaim(database, input.claimId);
      if (claim === undefined) {
        throw new Error("Provider capability-test claim was not found.");
      }
      assertResultMatchesClaim(input.result, claim);
      assertTerminalAudit(input.audit, input.result, claim);

      const existing =
        await database.administrationProviderCapabilityTestResult.findUnique({
          where: { claimId: input.claimId },
        });
      if (existing !== null) {
        const stored = asResult(existing);
        if (!sameResult(stored, input.result)) {
          throw new Error(
            "Provider capability-test result conflicts with its claim.",
          );
        }
        return stored;
      }
      if (claim.completed_at !== null) {
        throw new Error(
          "Provider capability-test claim completion is incomplete.",
        );
      }

      const created =
        await database.administrationProviderCapabilityTestResult.create({
          data: resultRecord(input.claimId, input.result),
        });
      await database.auditEvent.create({
        data: {
          id: this.nextId(),
          workspaceId: input.audit.workspaceId,
          actorPrincipalId: input.audit.actorPrincipalId,
          action: input.audit.action,
          targetId: input.audit.targetId,
          targetType: input.audit.targetType,
          permission: input.audit.permission,
          outcome: input.audit.outcome,
          reasonCode: input.audit.reasonCode,
          requestId: input.audit.requestId,
          correlationId: input.audit.correlationId,
          uiActionId: input.audit.uiActionId,
          traceId: input.audit.traceId,
          idempotencyKeyDigest: input.audit.idempotencyKeyDigest,
          clientAddress: input.audit.clientAddress,
          userAgent: input.audit.userAgent,
          origin: "admin_ui",
          occurredAt: asDate(input.audit.occurredAt),
        },
      });
      await database.administrationProviderCapabilityTestClaim.update({
        where: { id: input.claimId },
        data: { completedAt: asDate(input.result.completedAt) },
      });
      return asResult(created);
    });
  }
}

interface LockedClaim {
  readonly id: string;
  readonly workspace_id: string;
  readonly principal_id: string;
  readonly provider_instance_id: string;
  readonly provider_instance_version_id: string;
  readonly binding_version_id: string;
  readonly test_operation: string;
  readonly key_digest: string;
  readonly completed_at: Date | null;
}

async function lockClaim(
  database: Database,
  claimId: string,
): Promise<LockedClaim | undefined> {
  const rows = await database.$queryRaw<readonly LockedClaim[]>`
    SELECT
      id, workspace_id, principal_id, provider_instance_id,
      provider_instance_version_id, binding_version_id, test_operation,
      key_digest, completed_at
    FROM administration_provider_capability_test_claims
    WHERE id = ${claimId}
    FOR UPDATE
  `;
  return rows[0];
}

function assertPreviewAudit(
  input: Parameters<
    ProviderCapabilityTestConfirmationStore["issueAndRecord"]
  >[0],
): void {
  if (
    input.audit.workspaceId !== input.workspaceId ||
    input.audit.actorPrincipalId !== input.principalId ||
    input.audit.action !== previewAuditAction ||
    input.audit.targetType !== "ai-provider-instance" ||
    input.audit.targetId !== input.providerInstanceId ||
    input.audit.permission !== providerCapabilityTestPermission ||
    input.audit.outcome !== "succeeded"
  ) {
    throw new Error("Provider capability-test preview audit is invalid.");
  }
}

function assertDeniedPreviewAudit(
  audit: ProviderCapabilityTestPreviewAuditRecord,
): void {
  if (
    audit.action !== previewAuditAction ||
    audit.targetType !== "ai-provider-instance" ||
    audit.permission !== providerCapabilityTestPermission ||
    audit.outcome !== "denied" ||
    (audit.reasonCode !== "pricing.unknown" &&
      audit.reasonCode !== "budget.policy_missing")
  ) {
    throw new Error(
      "Provider capability-test denied preview audit is invalid.",
    );
  }
}

function assertTerminalAudit(
  audit: ProviderCapabilityTestAuditRecord,
  result: StoredProviderCapabilityTestResult,
  claim: LockedClaim,
): void {
  if (
    audit.workspaceId !== result.workspaceId ||
    audit.actorPrincipalId !== claim.principal_id ||
    audit.action !== providerCapabilityTestAuditAction ||
    audit.targetType !== "ai-provider-instance" ||
    audit.targetId !== result.providerInstanceId ||
    audit.permission !== providerCapabilityTestPermission ||
    audit.outcome !== result.outcome ||
    audit.reasonCode !== result.reasonCode ||
    audit.idempotencyKeyDigest !== claim.key_digest ||
    audit.occurredAt !== result.completedAt
  ) {
    throw new Error("Provider capability-test terminal audit is invalid.");
  }
}

function assertResultMatchesClaim(
  result: StoredProviderCapabilityTestResult,
  claim: LockedClaim,
): void {
  if (
    result.id !== claim.id ||
    result.workspaceId !== claim.workspace_id ||
    result.providerInstanceId !== claim.provider_instance_id ||
    result.providerInstanceVersionId !== claim.provider_instance_version_id ||
    result.bindingVersionId !== claim.binding_version_id ||
    result.testOperation !== claim.test_operation
  ) {
    throw new Error(
      "Provider capability-test result is not bound to its claim.",
    );
  }
}

function resultRecord(
  claimId: string,
  result: StoredProviderCapabilityTestResult,
): Prisma.AdministrationProviderCapabilityTestResultCreateInput {
  const estimated = costRecord(result.estimatedCost);
  const actual = costRecord(result.actualCost);
  return {
    id: result.id,
    claimId,
    workspaceId: result.workspaceId,
    providerInstanceId: result.providerInstanceId,
    providerInstanceVersionId: result.providerInstanceVersionId,
    bindingVersionId: result.bindingVersionId,
    testOperation: result.testOperation,
    outcome: result.outcome,
    operationId: result.operationId,
    estimatedAmount: estimated?.amount,
    estimatedCurrency: estimated?.currency,
    actualAmount: actual?.amount,
    actualCurrency: actual?.currency,
    reasonCode: result.reasonCode,
    completedAt: asDate(result.completedAt),
  };
}

function asResult(
  row: Readonly<{
    readonly id: string;
    readonly workspaceId: string;
    readonly providerInstanceId: string;
    readonly providerInstanceVersionId: string;
    readonly bindingVersionId: string;
    readonly testOperation: string;
    readonly outcome: string;
    readonly operationId: string | null;
    readonly estimatedAmount: { toString(): string } | null;
    readonly estimatedCurrency: string | null;
    readonly actualAmount: { toString(): string } | null;
    readonly actualCurrency: string | null;
    readonly reasonCode: string | null;
    readonly completedAt: Date;
  }>,
): StoredProviderCapabilityTestResult {
  if (
    row.outcome !== "succeeded" &&
    row.outcome !== "failed" &&
    row.outcome !== "denied"
  ) {
    throw new Error("Persisted provider capability-test outcome is invalid.");
  }
  const estimatedCost = persistedCost(
    row.estimatedAmount,
    row.estimatedCurrency,
  );
  const actualCost = persistedCost(row.actualAmount, row.actualCurrency);
  const reasonCode = persistedReasonCode(row.reasonCode);
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    providerInstanceId: row.providerInstanceId,
    providerInstanceVersionId: row.providerInstanceVersionId,
    bindingVersionId: row.bindingVersionId,
    testOperation: row.testOperation,
    outcome: row.outcome,
    ...(row.operationId === null ? {} : { operationId: row.operationId }),
    ...(estimatedCost === undefined ? {} : { estimatedCost }),
    ...(actualCost === undefined ? {} : { actualCost }),
    ...(reasonCode === undefined ? {} : { reasonCode }),
    completedAt: row.completedAt.toISOString(),
  });
}

function persistedReasonCode(
  value: string | null,
): ProviderCapabilityTestReasonCode | undefined {
  if (value === null) return undefined;
  if (
    value !== "pricing.unknown" &&
    value !== "budget.policy_missing" &&
    value !== "confirmation.required" &&
    value !== "rate_limited" &&
    value !== "execution.failed"
  ) {
    throw new Error("Persisted provider capability-test reason is invalid.");
  }
  return value;
}

function persistedCost(
  amount: { toString(): string } | null,
  currency: string | null,
): ProviderCapabilityTestCostEstimate | undefined {
  if (amount === null && currency === null) return undefined;
  if (amount === null || currency === null) {
    throw new Error("Persisted provider capability-test cost is incomplete.");
  }
  return costRecord({ amount: amount.toString(), currency });
}

function costRecord(
  value: ProviderCapabilityTestCostEstimate | undefined,
): ProviderCapabilityTestCostEstimate | undefined {
  if (value === undefined) return undefined;
  if (
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value.amount) ||
    !/^[A-Z]{3}$/u.test(value.currency)
  ) {
    throw new Error("Provider capability-test cost is invalid.");
  }
  return Object.freeze({ amount: value.amount, currency: value.currency });
}

function sameResult(
  left: StoredProviderCapabilityTestResult,
  right: StoredProviderCapabilityTestResult,
): boolean {
  return (
    left.id === right.id &&
    left.workspaceId === right.workspaceId &&
    left.providerInstanceId === right.providerInstanceId &&
    left.providerInstanceVersionId === right.providerInstanceVersionId &&
    left.bindingVersionId === right.bindingVersionId &&
    left.testOperation === right.testOperation &&
    left.outcome === right.outcome &&
    left.operationId === right.operationId &&
    left.reasonCode === right.reasonCode &&
    left.completedAt === right.completedAt &&
    sameCost(left.estimatedCost, right.estimatedCost) &&
    sameCost(left.actualCost, right.actualCost)
  );
}

function sameCost(
  left: ProviderCapabilityTestCostEstimate | undefined,
  right: ProviderCapabilityTestCostEstimate | undefined,
): boolean {
  return left?.amount === right?.amount && left?.currency === right?.currency;
}

function requestFingerprint(
  input: Parameters<ProviderCapabilityTestClaimStore["claim"]>[0],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: input.workspaceId,
        principalId: input.principalId,
        providerInstanceId: input.providerInstanceId,
        providerInstanceVersionId: input.providerInstanceVersionId,
        bindingVersionId: input.bindingVersionId,
        testOperation: input.testOperation,
      }),
      "utf8",
    )
    .digest("hex");
}

function claimLockKey(workspaceId: string, keyDigest: string): string {
  return `provider-capability-test:${workspaceId}:${keyDigest}`;
}

function requirePositiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(
      `${label} must be a positive whole number of milliseconds.`,
    );
  }
  return value;
}

function requirePositiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > rateLimit) {
    throw new RangeError(
      `Rate limit must be an integer from 1 through ${rateLimit}.`,
    );
  }
  return value;
}

function asDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Provider capability-test timestamp is invalid.");
  }
  return date;
}
