import { createHash } from "node:crypto";
import {
  type CatalogModel,
  type CreateBindingInput,
  createImmutableBinding,
  decimal,
  type ImportedCatalogSnapshot,
  importLiteLlmCatalog,
  type LiteLlmImportInput,
  type PriceComponent,
  type PriceComponentKind,
  type PriceConditions,
  resolvePrices,
} from "@caseweaver/ai-config";
import type { Permission } from "@caseweaver/security";

import {
  AdministrationConflictError,
  AdministrationValidationError,
  IdempotencyConflictError,
} from "./errors.js";

/** Server-owned action codes. Browser input never selects an action or permission. */
export const aiConfigurationActions = {
  catalogImport: "admin.aiCatalog.import",
  bindingDraftCreate: "admin.aiBinding.draft.create",
  bindingVersionDraftCreate: "admin.aiBinding.version.draft.create",
  bindingActivate: "admin.aiBinding.activate",
  bindingDisable: "admin.aiBinding.disable",
  roleDefaultSet: "admin.aiRoleDefault.set",
  priceOverrideCreate: "admin.aiPriceOverride.create",
  budgetPolicyReplace: "admin.aiBudgetPolicy.replace",
} as const;

export type AiConfigurationAction =
  (typeof aiConfigurationActions)[keyof typeof aiConfigurationActions];

export const aiConfigurationPermission: Permission = "configuration.manage";

type AiRole = CreateBindingInput["role"];
type AiCapability = NonNullable<
  CreateBindingInput["requiredCapabilities"]
>[number];
type AiWireApi = CreateBindingInput["wireApi"];

export type AiBindingLifecycle = "draft" | "active" | "disabled";
export type AiBudgetScope = "operation" | "analysis" | "day" | "workspace";

/**
 * The HTTP boundary derives this context from a validated server session. It is
 * kept separate from browser commands so actor, workspace, audit origin, and
 * correlation metadata cannot become client authority.
 */
export interface TrustedAiConfigurationContext {
  readonly workspaceId: string;
  readonly actorPrincipalId: string;
  readonly occurredAt: string;
  readonly origin: "admin_ui" | "api" | "cli";
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly uiActionId?: string;
}

/** Raw browser idempotency keys are hashed at the HTTP boundary before this contract. */
export interface AiConfigurationMutation {
  readonly keyDigest: string;
  readonly requestDigest: string;
}

export interface AiConfigurationAuditRecord {
  readonly workspaceId: string;
  readonly actorPrincipalId: string;
  readonly action: AiConfigurationAction;
  readonly targetType: string;
  readonly targetId: string;
  readonly permission: Permission;
  readonly outcome: "succeeded";
  readonly occurredAt: string;
  readonly origin: TrustedAiConfigurationContext["origin"];
  readonly idempotencyKeyDigest: string;
  readonly beforeHash?: string;
  readonly afterHash: string;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly uiActionId?: string;
}

export interface AiCatalogSnapshotSummary {
  readonly id: string;
  readonly sha256: string;
  readonly upstreamCommitSha: string;
  readonly fetchedAt: string;
  readonly modelCount: number;
}

export interface AiBindingSummary {
  readonly bindingId: string;
  readonly bindingVersionId: string;
  readonly workspaceId: string;
  readonly role: AiRole;
  readonly providerInstanceVersionId: string;
  readonly catalogSnapshotId: string;
  readonly canonicalModel: string;
  readonly version: number;
  /** Durable aggregate concurrency revision, never derived from browser data. */
  readonly revision: number;
  readonly lifecycle: AiBindingLifecycle;
}

export interface AiRoleDefaultSummary {
  readonly workspaceId: string;
  readonly role: AiRole;
  readonly bindingVersionId: string;
  readonly revision: number;
}

export interface AiPriceOverrideSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly scope: "workspace" | "binding";
  readonly provider: string;
  readonly canonicalModel: string;
  readonly bindingVersionId?: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly currency: string;
  readonly componentCount: number;
}

export interface AiBudgetPolicySummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly scope: AiBudgetScope;
  readonly scopeKey: string;
  readonly limitAmount: string;
  readonly currency: string;
  readonly hard: boolean;
  readonly active: boolean;
  readonly revision: number;
}

/**
 * A catalog import is fed by a deployment-owned fetcher or an already-pinned
 * server artifact. Raw bytes never originate in the browser or return in a DTO.
 */
export interface ImportAiCatalogSnapshotCommand {
  readonly import: LiteLlmImportInput;
  readonly mutation: AiConfigurationMutation;
}

export interface CreateAiModelBindingDraftCommand {
  readonly binding: AiBindingDraftInput;
  readonly mutation: AiConfigurationMutation;
}

export interface CreateAiModelBindingVersionDraftCommand {
  readonly binding: AiBindingDraftInput;
  readonly expectedRevision: number;
  readonly mutation: AiConfigurationMutation;
}

/**
 * Values in this shape are resolved from selected persisted provider/catalog
 * records by composition. `secretReference` is only an opaque reference ID;
 * this package never resolves or returns secret material.
 */
export interface AiBindingDraftInput {
  readonly bindingId: string;
  readonly version: number;
  readonly role: AiRole;
  readonly providerInstanceVersionId: string;
  readonly providerType: string;
  readonly endpoint: string;
  readonly canonicalModel: string;
  readonly wireApi: AiWireApi;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly secretReference: string;
  readonly catalogModel: CatalogModel;
  readonly requiredCapabilities?: readonly AiCapability[];
  readonly maximumInputTokens?: number;
  readonly maximumOutputTokens?: number;
}

export interface TransitionAiModelBindingCommand {
  readonly bindingId: string;
  readonly expectedRevision: number;
  readonly lifecycle: "active" | "disabled";
  readonly mutation: AiConfigurationMutation;
}

export interface SetAiWorkspaceRoleDefaultCommand {
  readonly role: AiRole;
  readonly bindingVersionId: string;
  readonly expectedRevision: number;
  readonly mutation: AiConfigurationMutation;
}

export interface AiPriceOverrideComponentInput {
  readonly kind: PriceComponentKind;
  readonly unit: "token" | "image" | "audio";
  readonly amount: string;
  readonly currency: string;
  readonly conditions?: PriceConditions;
}

export interface CreateAiPriceOverrideCommand {
  readonly overrideId: string;
  readonly scope: "workspace" | "binding";
  readonly provider: string;
  readonly canonicalModel: string;
  readonly bindingVersionId?: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly components: readonly AiPriceOverrideComponentInput[];
  readonly mutation: AiConfigurationMutation;
}

export interface ReplaceAiBudgetPolicyCommand {
  readonly budgetPolicyId: string;
  readonly scope: AiBudgetScope;
  readonly scopeKey: string;
  readonly limitAmount: string;
  readonly currency: string;
  readonly hard: boolean;
  readonly expectedRevision: number;
  readonly mutation: AiConfigurationMutation;
}

/**
 * Every store method owns one transaction containing the state mutation,
 * idempotency result, authoritative audit record, and cache invalidation.
 */
export interface AiConfigurationStore {
  importCatalogAndRecord(
    input: Readonly<{
      readonly workspaceId: string;
      readonly catalog: ImportedCatalogSnapshot;
      readonly mutation: AiConfigurationMutation;
      readonly audit: AiConfigurationAuditRecord;
    }>,
  ): Promise<
    Readonly<{
      readonly summary: AiCatalogSnapshotSummary;
      readonly idempotency: "created" | "replayed";
    }>
  >;
  createBindingDraftAndRecord(
    input: Readonly<{
      readonly binding: ReturnType<typeof createImmutableBinding>;
      readonly mutation: AiConfigurationMutation;
      readonly audit: AiConfigurationAuditRecord;
    }>,
  ): Promise<
    Readonly<{
      readonly summary: AiBindingSummary;
      readonly idempotency: "created" | "replayed";
    }>
  >;
  createBindingVersionDraftAndRecord(
    input: Readonly<{
      readonly binding: ReturnType<typeof createImmutableBinding>;
      readonly expectedRevision: number;
      readonly mutation: AiConfigurationMutation;
      readonly audit: AiConfigurationAuditRecord;
    }>,
  ): Promise<
    Readonly<{
      readonly summary: AiBindingSummary;
      readonly idempotency: "created" | "replayed";
    }>
  >;
  transitionBindingAndRecord(
    input: Readonly<{
      readonly workspaceId: string;
      readonly bindingId: string;
      readonly expectedRevision: number;
      readonly lifecycle: "active" | "disabled";
      readonly mutation: AiConfigurationMutation;
      readonly audit: AiConfigurationAuditRecord;
    }>,
  ): Promise<
    Readonly<{
      readonly summary: AiBindingSummary;
      readonly idempotency: "created" | "replayed";
    }>
  >;
  setRoleDefaultAndRecord(
    input: Readonly<{
      readonly workspaceId: string;
      readonly role: AiRole;
      readonly bindingVersionId: string;
      readonly expectedRevision: number;
      readonly mutation: AiConfigurationMutation;
      readonly audit: AiConfigurationAuditRecord;
    }>,
  ): Promise<
    Readonly<{
      readonly summary: AiRoleDefaultSummary;
      readonly idempotency: "created" | "replayed";
    }>
  >;
  createPriceOverrideAndRecord(
    input: Readonly<{
      readonly workspaceId: string;
      readonly override: AiPriceOverrideSummary &
        Readonly<{ readonly components: readonly PriceComponent[] }>;
      readonly mutation: AiConfigurationMutation;
      readonly audit: AiConfigurationAuditRecord;
    }>,
  ): Promise<
    Readonly<{
      readonly summary: AiPriceOverrideSummary;
      readonly idempotency: "created" | "replayed";
    }>
  >;
  replaceBudgetPolicyAndRecord(
    input: Readonly<{
      readonly workspaceId: string;
      readonly policy: Omit<
        AiBudgetPolicySummary,
        "workspaceId" | "revision" | "active"
      >;
      readonly expectedRevision: number;
      readonly mutation: AiConfigurationMutation;
      readonly audit: AiConfigurationAuditRecord;
    }>,
  ): Promise<
    Readonly<{
      readonly summary: AiBudgetPolicySummary;
      readonly idempotency: "created" | "replayed";
    }>
  >;
}

export class ImportAiCatalogSnapshot {
  public constructor(private readonly store: AiConfigurationStore) {}

  public async execute(
    command: ImportAiCatalogSnapshotCommand,
    context: TrustedAiConfigurationContext,
  ) {
    validateContext(context);
    validateMutation(command.mutation);
    const catalog = importLiteLlmCatalog(command.import);
    return this.store.importCatalogAndRecord({
      workspaceId: context.workspaceId,
      catalog,
      mutation: command.mutation,
      audit: audit(
        context,
        aiConfigurationActions.catalogImport,
        "ai-catalog-snapshot",
        catalog.id,
        command.mutation,
        catalog.sha256,
      ),
    });
  }
}

export class CreateAiModelBindingDraft {
  public constructor(private readonly store: AiConfigurationStore) {}

  public async execute(
    command: CreateAiModelBindingDraftCommand,
    context: TrustedAiConfigurationContext,
  ) {
    validateContext(context);
    validateMutation(command.mutation);
    if (command.binding.version !== 1)
      throw new AdministrationValidationError();
    const binding = validatedBinding(context.workspaceId, command.binding);
    return this.store.createBindingDraftAndRecord({
      binding,
      mutation: command.mutation,
      audit: audit(
        context,
        aiConfigurationActions.bindingDraftCreate,
        "ai-model-binding",
        binding.bindingId,
        command.mutation,
        bindingHash(binding),
      ),
    });
  }
}

export class CreateAiModelBindingVersionDraft {
  public constructor(private readonly store: AiConfigurationStore) {}

  public async execute(
    command: CreateAiModelBindingVersionDraftCommand,
    context: TrustedAiConfigurationContext,
  ) {
    validateContext(context);
    validateMutation(command.mutation);
    validateRevision(command.expectedRevision);
    const binding = validatedBinding(context.workspaceId, command.binding);
    return this.store.createBindingVersionDraftAndRecord({
      binding,
      expectedRevision: command.expectedRevision,
      mutation: command.mutation,
      audit: audit(
        context,
        aiConfigurationActions.bindingVersionDraftCreate,
        "ai-model-binding",
        binding.bindingId,
        command.mutation,
        bindingHash(binding),
      ),
    });
  }
}

export class ActivateAiModelBinding {
  public constructor(private readonly store: AiConfigurationStore) {}

  public execute(
    command: Omit<TransitionAiModelBindingCommand, "lifecycle">,
    context: TrustedAiConfigurationContext,
  ) {
    return transitionBinding(this.store, command, context, "active");
  }
}

export class DisableAiModelBinding {
  public constructor(private readonly store: AiConfigurationStore) {}

  public execute(
    command: Omit<TransitionAiModelBindingCommand, "lifecycle">,
    context: TrustedAiConfigurationContext,
  ) {
    return transitionBinding(this.store, command, context, "disabled");
  }
}

export class SetAiWorkspaceRoleDefault {
  public constructor(private readonly store: AiConfigurationStore) {}

  public async execute(
    command: SetAiWorkspaceRoleDefaultCommand,
    context: TrustedAiConfigurationContext,
  ) {
    validateContext(context);
    validateMutation(command.mutation);
    validateIdentifier(command.bindingVersionId);
    validateRole(command.role);
    validateRevision(command.expectedRevision, true);
    return this.store.setRoleDefaultAndRecord({
      workspaceId: context.workspaceId,
      role: command.role,
      bindingVersionId: command.bindingVersionId,
      expectedRevision: command.expectedRevision,
      mutation: command.mutation,
      audit: audit(
        context,
        aiConfigurationActions.roleDefaultSet,
        "ai-workspace-role-default",
        command.role,
        command.mutation,
        hash({
          role: command.role,
          bindingVersionId: command.bindingVersionId,
        }),
      ),
    });
  }
}

export class CreateAiPriceOverride {
  public constructor(private readonly store: AiConfigurationStore) {}

  public async execute(
    command: CreateAiPriceOverrideCommand,
    context: TrustedAiConfigurationContext,
  ) {
    validateContext(context);
    validateMutation(command.mutation);
    const override = validatedPriceOverride(context.workspaceId, command);
    return this.store.createPriceOverrideAndRecord({
      workspaceId: context.workspaceId,
      override,
      mutation: command.mutation,
      audit: audit(
        context,
        aiConfigurationActions.priceOverrideCreate,
        "ai-price-override",
        override.id,
        command.mutation,
        hash(override),
      ),
    });
  }
}

export class ReplaceAiBudgetPolicy {
  public constructor(private readonly store: AiConfigurationStore) {}

  public async execute(
    command: ReplaceAiBudgetPolicyCommand,
    context: TrustedAiConfigurationContext,
  ) {
    validateContext(context);
    validateMutation(command.mutation);
    validateRevision(command.expectedRevision, true);
    const policy = validatedBudgetPolicy(command);
    return this.store.replaceBudgetPolicyAndRecord({
      workspaceId: context.workspaceId,
      policy,
      expectedRevision: command.expectedRevision,
      mutation: command.mutation,
      audit: audit(
        context,
        aiConfigurationActions.budgetPolicyReplace,
        "ai-budget-policy",
        `${policy.scope}:${policy.scopeKey}`,
        command.mutation,
        hash(policy),
      ),
    });
  }
}

async function transitionBinding(
  store: AiConfigurationStore,
  command: Omit<TransitionAiModelBindingCommand, "lifecycle">,
  context: TrustedAiConfigurationContext,
  lifecycle: "active" | "disabled",
) {
  validateContext(context);
  validateMutation(command.mutation);
  validateIdentifier(command.bindingId);
  validateRevision(command.expectedRevision);
  return store.transitionBindingAndRecord({
    workspaceId: context.workspaceId,
    bindingId: command.bindingId,
    expectedRevision: command.expectedRevision,
    lifecycle,
    mutation: command.mutation,
    audit: audit(
      context,
      lifecycle === "active"
        ? aiConfigurationActions.bindingActivate
        : aiConfigurationActions.bindingDisable,
      "ai-model-binding",
      command.bindingId,
      command.mutation,
      hash({ lifecycle }),
    ),
  });
}

function validatedBinding(workspaceId: string, input: AiBindingDraftInput) {
  try {
    validateIdentifier(input.bindingId);
    validateIdentifier(input.providerInstanceVersionId);
    validateIdentifier(input.secretReference);
    validateRole(input.role);
    return createImmutableBinding({ workspaceId, ...input });
  } catch {
    throw new AdministrationValidationError();
  }
}

function validatedPriceOverride(
  workspaceId: string,
  input: CreateAiPriceOverrideCommand,
): AiPriceOverrideSummary &
  Readonly<{ readonly components: readonly PriceComponent[] }> {
  try {
    validateIdentifier(input.overrideId);
    validateIdentifier(input.provider);
    if (
      input.canonicalModel.trim().length === 0 ||
      input.canonicalModel.length > 500
    )
      throw new Error();
    if (input.scope === "binding") {
      if (input.bindingVersionId === undefined) throw new Error();
      validateIdentifier(input.bindingVersionId);
    } else if (input.bindingVersionId !== undefined) throw new Error();
    const effectiveFrom = iso(input.effectiveFrom);
    const effectiveTo =
      input.effectiveTo === undefined ? undefined : iso(input.effectiveTo);
    if (effectiveTo !== undefined && effectiveTo <= effectiveFrom)
      throw new Error();
    if (input.components.length < 1 || input.components.length > 12)
      throw new Error();
    const currencies = new Set(
      input.components.map((component) => component.currency),
    );
    if (currencies.size !== 1) throw new Error();
    const currency = input.components[0]?.currency;
    if (currency === undefined || !/^[A-Z]{3}$/u.test(currency))
      throw new Error();
    const components = input.components.map((component) =>
      priceComponent(input.overrideId, effectiveFrom, effectiveTo, component),
    );
    for (const component of components) {
      const resolution = resolvePrices(
        {
          bindingOverrides: input.scope === "binding" ? [component] : [],
          workspaceOverrides: input.scope === "workspace" ? [component] : [],
          installationOverrides: [],
          catalogComponents: [],
        },
        [component.kind],
        matchingPriceContext(component),
      );
      if (resolution.status !== "known") throw new Error();
    }
    return Object.freeze({
      id: input.overrideId,
      workspaceId,
      scope: input.scope,
      provider: input.provider,
      canonicalModel: input.canonicalModel,
      ...(input.bindingVersionId === undefined
        ? {}
        : { bindingVersionId: input.bindingVersionId }),
      effectiveFrom,
      ...(effectiveTo === undefined ? {} : { effectiveTo }),
      currency,
      componentCount: components.length,
      components: Object.freeze(components),
    });
  } catch {
    throw new AdministrationValidationError();
  }
}

function priceComponent(
  id: string,
  effectiveFrom: string,
  effectiveTo: string | undefined,
  input: AiPriceOverrideComponentInput,
): PriceComponent {
  if (
    !validPriceKind(input.kind) ||
    !validPriceUnit(input.unit) ||
    !/^[A-Z]{3}$/u.test(input.currency)
  )
    throw new Error();
  if (
    (input.kind === "image" && input.unit !== "image") ||
    (input.kind === "audio" && input.unit !== "audio") ||
    (input.kind !== "image" && input.kind !== "audio" && input.unit !== "token")
  )
    throw new Error();
  if (
    typeof input.amount !== "string" ||
    !/^\d+(?:\.\d+)?$/u.test(input.amount)
  )
    throw new Error();
  const conditions = input.conditions ?? {};
  if (!isJsonRecord(conditions)) throw new Error();
  return Object.freeze({
    id: `${id}:${input.kind}:${createHash("sha256")
      .update(JSON.stringify(canonical(conditions)), "utf8")
      .digest("hex")}`,
    kind: input.kind,
    unit: input.unit,
    amount: decimal(input.amount),
    currency: input.currency,
    effectiveFrom,
    ...(effectiveTo === undefined ? {} : { effectiveTo }),
    sourceId: "administration",
    conditions: Object.freeze({ ...conditions }),
  });
}

function matchingPriceContext(component: PriceComponent) {
  const condition = component.conditions;
  const at = component.effectiveFrom;
  return Object.freeze({
    at,
    currency: component.currency,
    ...(typeof condition.providerRegion === "string"
      ? { providerRegion: condition.providerRegion }
      : {}),
    ...(typeof condition.serviceTier === "string"
      ? { serviceTier: condition.serviceTier }
      : {}),
    ...(typeof condition.batchMode === "boolean"
      ? { batchMode: condition.batchMode }
      : {}),
    ...(typeof condition.contextTier === "string"
      ? { contextTier: condition.contextTier }
      : {}),
    ...(typeof condition.mediaType === "string"
      ? { mediaType: condition.mediaType }
      : {}),
    ...(typeof condition.inputTokenThreshold === "number"
      ? { inputTokenCount: condition.inputTokenThreshold }
      : {}),
  });
}

function validatedBudgetPolicy(
  input: ReplaceAiBudgetPolicyCommand,
): Omit<AiBudgetPolicySummary, "workspaceId" | "revision" | "active"> {
  try {
    validateIdentifier(input.budgetPolicyId);
    if (
      !(["operation", "analysis", "day", "workspace"] as const).includes(
        input.scope,
      )
    )
      throw new Error();
    validateIdentifier(input.scopeKey);
    if (
      typeof input.limitAmount !== "string" ||
      !/^\d+(?:\.\d+)?$/u.test(input.limitAmount)
    )
      throw new Error();
    if (!/^[A-Z]{3}$/u.test(input.currency) || typeof input.hard !== "boolean")
      throw new Error();
    return Object.freeze({
      id: input.budgetPolicyId,
      scope: input.scope,
      scopeKey: input.scopeKey,
      limitAmount: input.limitAmount,
      currency: input.currency,
      hard: input.hard,
    });
  } catch {
    throw new AdministrationValidationError();
  }
}

function audit(
  context: TrustedAiConfigurationContext,
  action: AiConfigurationAction,
  targetType: string,
  targetId: string,
  mutation: AiConfigurationMutation,
  afterHash: string,
): AiConfigurationAuditRecord {
  return Object.freeze({
    workspaceId: context.workspaceId,
    actorPrincipalId: context.actorPrincipalId,
    action,
    targetType,
    targetId,
    permission: aiConfigurationPermission,
    outcome: "succeeded",
    occurredAt: context.occurredAt,
    origin: context.origin,
    idempotencyKeyDigest: mutation.keyDigest,
    afterHash,
    ...(context.requestId === undefined
      ? {}
      : { requestId: context.requestId }),
    ...(context.correlationId === undefined
      ? {}
      : { correlationId: context.correlationId }),
    ...(context.uiActionId === undefined
      ? {}
      : { uiActionId: context.uiActionId }),
  });
}

function bindingHash(
  binding: ReturnType<typeof createImmutableBinding>,
): string {
  return hash({
    bindingId: binding.bindingId,
    bindingVersionId: binding.bindingVersionId,
    role: binding.role,
    providerInstanceVersionId: binding.providerInstanceVersionId,
    catalogSnapshotId: binding.catalogSnapshotId,
    canonicalModel: binding.canonicalModel,
    parameters: binding.parameters,
    capabilities: [...binding.capabilities].sort(),
    maximumInputTokens: binding.maximumInputTokens,
    maximumOutputTokens: binding.maximumOutputTokens,
  });
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)), "utf8")
    .digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isJsonRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function validateContext(context: TrustedAiConfigurationContext): void {
  try {
    if (
      !isIdentifier(context.workspaceId) ||
      !isIdentifier(context.actorPrincipalId) ||
      !(["admin_ui", "api", "cli"] as const).includes(context.origin)
    ) {
      throw new Error();
    }
    iso(context.occurredAt);
  } catch {
    throw new AdministrationValidationError();
  }
}

function validateMutation(mutation: AiConfigurationMutation): void {
  if (!digest(mutation.keyDigest) || !digest(mutation.requestDigest))
    throw new AdministrationValidationError();
}

function validateIdentifier(value: string): void {
  if (!isIdentifier(value)) throw new AdministrationValidationError();
}

function validateRole(value: string): void {
  if (
    !(
      [
        "embedding",
        "vision",
        "analysis",
        "repositoryAgent",
        "reranker",
        "keywordExtraction",
        "chat",
      ] as const
    ).includes(value as AiRole)
  )
    throw new AdministrationValidationError();
}

function validateRevision(value: number, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1))
    throw new AdministrationValidationError();
}

function iso(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
    throw new Error("invalid timestamp");
  return value;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)
  );
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value);
}

function isJsonRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validPriceKind(value: string): value is PriceComponentKind {
  return (
    ["input", "output", "cacheRead", "cacheCreation", "image", "audio"] as const
  ).includes(value as PriceComponentKind);
}

function validPriceUnit(value: string): value is "token" | "image" | "audio" {
  return (["token", "image", "audio"] as const).includes(
    value as "token" | "image" | "audio",
  );
}

export function requireDistinctAiConfigurationMutation(
  expected: string,
  actual: string,
): void {
  if (expected !== actual) throw new IdempotencyConflictError();
}

export function requireAiConfigurationRevision(
  expected: number,
  actual: number,
): void {
  if (expected !== actual) throw new AdministrationConflictError();
}
