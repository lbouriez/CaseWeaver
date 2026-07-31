import { createHash } from "node:crypto";
import type {
  AiCapability,
  AiRole,
  AiWireApi,
  ProviderDiscoveredModel,
} from "@caseweaver/ai-sdk";
import {
  type AiConfigurationAuditRecord,
  type AiConfigurationMutation,
  aiConfigurationActions,
  aiConfigurationPermission,
  type TrustedAiConfigurationContext,
} from "./ai-configuration.js";
import { canonicalizeConfiguration } from "./configuration.js";
import { AdministrationValidationError } from "./errors.js";

export interface ProviderModelInventorySummary {
  readonly id: string;
  readonly providerInstanceId: string;
  readonly providerInstanceVersionId: string;
  readonly discoveredAt: string;
  readonly modelCount: number;
  /** Models with an exact trusted LiteLLM price match; all others remain unknown. */
  readonly pricedModelCount: number;
}

/**
 * Durable provider-inventory persistence boundary. A store must create the
 * immutable snapshot, its corresponding binding catalog entries, idempotency
 * result, cache invalidation, and success audit in one transaction.
 */
export interface ProviderModelInventoryStore {
  refreshAndRecord(
    input: Readonly<{
      readonly workspaceId: string;
      readonly providerInstanceId: string;
      readonly providerInstanceVersionId: string;
      readonly providerType: string;
      readonly wireApi: AiWireApi;
      readonly models: readonly ProviderDiscoveredModel[];
      readonly mutation: AiConfigurationMutation;
      readonly audit: AiConfigurationAuditRecord;
    }>,
  ): Promise<
    Readonly<{
      readonly summary: ProviderModelInventorySummary;
      readonly idempotency: "created" | "replayed";
    }>
  >;
}

export interface RefreshProviderModelInventoryCommand {
  readonly providerInstanceId: string;
  readonly providerInstanceVersionId: string;
  readonly providerType: string;
  readonly wireApi: AiWireApi;
  readonly models: readonly ProviderDiscoveredModel[];
  readonly mutation: AiConfigurationMutation;
}

const roles = new Set<AiRole>([
  "embedding",
  "vision",
  "analysis",
  "repositoryAgent",
  "keywordExtraction",
  "reranker",
  "chat",
]);
const capabilities = new Set<AiCapability>([
  "vision",
  "structuredOutput",
  "tools",
  "promptCaching",
  "reranking",
  "repositoryAgent",
]);

/**
 * Persists only normalized discovery metadata. The actual provider request is
 * intentionally performed in trusted outer composition before this use case,
 * so database work is short and no secret can enter the application contract.
 */
export class RefreshProviderModelInventory {
  public constructor(private readonly store: ProviderModelInventoryStore) {}

  public async execute(
    command: RefreshProviderModelInventoryCommand,
    context: TrustedAiConfigurationContext,
  ) {
    validateContext(context);
    validateCommand(command);
    const models = normalizedModels(command.models);
    const afterHash = createHash("sha256")
      .update(
        canonicalizeConfiguration({
          providerInstanceId: command.providerInstanceId,
          providerInstanceVersionId: command.providerInstanceVersionId,
          providerType: command.providerType,
          wireApi: command.wireApi,
          models,
        }),
        "utf8",
      )
      .digest("hex");
    return this.store.refreshAndRecord({
      workspaceId: context.workspaceId,
      providerInstanceId: command.providerInstanceId,
      providerInstanceVersionId: command.providerInstanceVersionId,
      providerType: command.providerType,
      wireApi: command.wireApi,
      models,
      mutation: command.mutation,
      audit: Object.freeze({
        workspaceId: context.workspaceId,
        actorPrincipalId: context.actorPrincipalId,
        action: aiConfigurationActions.providerModelInventoryRefresh,
        targetType: "ai-provider-instance",
        targetId: command.providerInstanceId,
        permission: aiConfigurationPermission,
        outcome: "succeeded",
        occurredAt: context.occurredAt,
        origin: context.origin,
        idempotencyKeyDigest: command.mutation.keyDigest,
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
      }),
    });
  }
}

function validateContext(context: TrustedAiConfigurationContext): void {
  if (
    context.workspaceId.length === 0 ||
    context.actorPrincipalId.length === 0 ||
    !Number.isFinite(new Date(context.occurredAt).getTime())
  ) {
    throw new AdministrationValidationError();
  }
}

function validateCommand(command: RefreshProviderModelInventoryCommand): void {
  for (const value of [
    command.providerInstanceId,
    command.providerInstanceVersionId,
    command.providerType,
  ]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)) {
      throw new AdministrationValidationError();
    }
  }
  if (
    command.wireApi !== "embeddings" &&
    command.wireApi !== "chatCompletions" &&
    command.wireApi !== "responses" &&
    command.wireApi !== "custom"
  ) {
    throw new AdministrationValidationError();
  }
  if (
    !/^[a-f0-9]{64}$/iu.test(command.mutation.keyDigest) ||
    !/^[a-f0-9]{64}$/iu.test(command.mutation.requestDigest) ||
    command.models.length > 2_000
  ) {
    throw new AdministrationValidationError();
  }
}

function normalizedModels(
  value: readonly ProviderDiscoveredModel[],
): readonly ProviderDiscoveredModel[] {
  const models = new Map<string, ProviderDiscoveredModel>();
  for (const model of value) {
    if (
      model.canonicalModel.trim().length === 0 ||
      model.canonicalModel.length > 500 ||
      hasControlCharacter(model.canonicalModel) ||
      model.supportedRoles.length === 0 ||
      model.supportedRoles.some((role) => !roles.has(role)) ||
      model.capabilities.some((capability) => !capabilities.has(capability)) ||
      (model.maximumInputTokens !== undefined &&
        (!Number.isSafeInteger(model.maximumInputTokens) ||
          model.maximumInputTokens < 1)) ||
      (model.maximumOutputTokens !== undefined &&
        (!Number.isSafeInteger(model.maximumOutputTokens) ||
          model.maximumOutputTokens < 1))
    ) {
      throw new AdministrationValidationError();
    }
    models.set(
      model.canonicalModel,
      Object.freeze({
        canonicalModel: model.canonicalModel,
        supportedRoles: Object.freeze(
          [...new Set(model.supportedRoles)].sort(),
        ),
        capabilities: Object.freeze([...new Set(model.capabilities)].sort()),
        ...(model.maximumInputTokens === undefined
          ? {}
          : { maximumInputTokens: model.maximumInputTokens }),
        ...(model.maximumOutputTokens === undefined
          ? {}
          : { maximumOutputTokens: model.maximumOutputTokens }),
      }),
    );
  }
  return Object.freeze(
    [...models.values()].sort((left, right) =>
      left.canonicalModel.localeCompare(right.canonicalModel),
    ),
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}
