import { createHash, randomUUID } from "node:crypto";

import type {
  AiBindingSummary,
  AiBudgetPolicySummary,
  AiCatalogSnapshotSummary,
  AiConfigurationAuditRecord,
  AiConfigurationMutation,
  AiConfigurationStore,
  AiPriceOverrideSummary,
  AiRoleDefaultSummary,
} from "@caseweaver/administration";
import {
  AdministrationConflictError,
  AdministrationNotFoundError,
  IdempotencyConflictError,
  requireAiConfigurationRevision,
} from "@caseweaver/administration";
import type { Prisma, PrismaClient } from "@prisma/client";

type Database = PrismaClient | Prisma.TransactionClient;

/**
 * PostgreSQL persistence for immutable AI catalog/binding configuration. It uses
 * the PBI-003 runtime tables and the dedicated AI configuration relay. Explicit
 * aggregate revisions plus active/draft pointers are the concurrency boundary;
 * no provider SDK, resolved secret, model prompt, or model response is accepted.
 */
export class PostgresAiConfigurationStore implements AiConfigurationStore {
  public constructor(
    private readonly client: PrismaClient,
    private readonly nextId: () => string = randomUUID,
  ) {}

  public async importCatalogAndRecord(
    input: Parameters<AiConfigurationStore["importCatalogAndRecord"]>[0],
  ) {
    return this.client.$transaction(async (database) => {
      await requireActor(database, input.audit);
      await lockMutation(
        database,
        input.workspaceId,
        input.audit.action,
        input.mutation.keyDigest,
      );
      const replay = await existingMutation(
        database,
        input.workspaceId,
        input.audit.action,
        input.mutation,
        input.catalog.id,
      );
      if (replay) {
        return Object.freeze({
          summary: await catalogSummary(database, input.catalog.id),
          idempotency: "replayed" as const,
        });
      }
      const existing = await database.aiCatalogSnapshot.findUnique({
        where: { id: input.catalog.id },
        select: { sha256: true },
      });
      if (existing !== null && existing.sha256 !== input.catalog.sha256) {
        throw new AdministrationConflictError();
      }
      if (existing === null) {
        await database.aiCatalogSnapshot.create({
          data: {
            id: input.catalog.id,
            upstreamUrl: input.catalog.upstreamUrl,
            upstreamCommitSha: input.catalog.upstreamCommitSha,
            fetchedAt: at(input.catalog.fetchedAt),
            sha256: input.catalog.sha256,
            rawEntries: input.catalog.rawEntries as Prisma.InputJsonObject,
          },
        });
        for (const model of input.catalog.models) {
          await database.aiCatalogModel.create({
            data: {
              id: model.id,
              catalogSnapshotId: input.catalog.id,
              canonicalModel: model.canonicalModel,
              provider: model.provider,
              supportedRoles: [...model.supportedRoles],
              capabilities: [...model.capabilities],
              maximumInputTokens: model.maximumInputTokens,
              maximumOutputTokens: model.maximumOutputTokens,
              rawEntry: model.rawEntry as Prisma.InputJsonObject,
            },
          });
          for (const component of model.priceComponents) {
            await database.aiCatalogPriceComponent.create({
              data: {
                id: component.id,
                catalogModelId: model.id,
                componentKind: component.kind,
                billingUnit: component.unit,
                amount: component.amount,
                currency: component.currency,
                effectiveFrom: at(component.effectiveFrom),
                effectiveTo:
                  component.effectiveTo === undefined
                    ? undefined
                    : at(component.effectiveTo),
                conditions: component.conditions as Prisma.InputJsonObject,
                sourceRevision: input.catalog.upstreamCommitSha,
                rawEntry: model.rawEntry as Prisma.InputJsonObject,
              },
            });
          }
        }
      }
      await recordMutation(
        database,
        input.workspaceId,
        input.audit.action,
        input.mutation,
        input.catalog.id,
      );
      await appendAudit(database, input.audit, this.nextId);
      await this.recordChange(
        database,
        input.workspaceId,
        "ai-catalog-snapshots",
        input.catalog.id,
        input.catalog.id,
      );
      return Object.freeze({
        summary: await catalogSummary(database, input.catalog.id),
        idempotency: "created" as const,
      });
    });
  }

  public async createBindingDraftAndRecord(
    input: Parameters<AiConfigurationStore["createBindingDraftAndRecord"]>[0],
  ) {
    return this.client.$transaction(async (database) => {
      await requireActor(database, input.audit);
      const binding = input.binding;
      await lockAggregate(
        database,
        input.binding.workspaceId,
        "ai-binding",
        binding.bindingId,
      );
      const replay = await existingMutation(
        database,
        binding.workspaceId,
        input.audit.action,
        input.mutation,
        binding.bindingId,
      );
      if (replay) {
        return Object.freeze({
          summary: await bindingSummary(
            database,
            binding.workspaceId,
            binding.bindingVersionId,
          ),
          idempotency: "replayed" as const,
        });
      }
      await requireProviderAndCatalog(database, binding);
      const exists = await database.aiModelBinding.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: binding.workspaceId,
            id: binding.bindingId,
          },
        },
        select: { id: true },
      });
      if (exists !== null) throw new AdministrationConflictError();
      await database.aiModelBinding.create({
        data: {
          id: binding.bindingId,
          workspaceId: binding.workspaceId,
          role: binding.role,
          lifecycle: "draft",
          revision: 1,
        },
      });
      await createBindingVersion(database, binding);
      await database.aiModelBinding.update({
        where: {
          workspaceId_id: {
            workspaceId: binding.workspaceId,
            id: binding.bindingId,
          },
        },
        data: { draftVersionId: binding.bindingVersionId },
      });
      await recordMutation(
        database,
        binding.workspaceId,
        input.audit.action,
        input.mutation,
        binding.bindingId,
      );
      await appendAudit(database, input.audit, this.nextId);
      await this.recordChange(
        database,
        binding.workspaceId,
        "ai-bindings",
        binding.bindingId,
        changeVersion(binding.bindingVersionId, 1),
      );
      return Object.freeze({
        summary: await bindingSummary(
          database,
          binding.workspaceId,
          binding.bindingVersionId,
        ),
        idempotency: "created" as const,
      });
    });
  }

  public async createBindingVersionDraftAndRecord(
    input: Parameters<
      AiConfigurationStore["createBindingVersionDraftAndRecord"]
    >[0],
  ) {
    return this.client.$transaction(async (database) => {
      await requireActor(database, input.audit);
      const binding = input.binding;
      await lockAggregate(
        database,
        binding.workspaceId,
        "ai-binding",
        binding.bindingId,
      );
      const replay = await existingMutation(
        database,
        binding.workspaceId,
        input.audit.action,
        input.mutation,
        binding.bindingId,
      );
      if (replay) {
        return Object.freeze({
          summary: await bindingSummary(
            database,
            binding.workspaceId,
            binding.bindingVersionId,
          ),
          idempotency: "replayed" as const,
        });
      }
      const aggregate = await database.aiModelBinding.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: binding.workspaceId,
            id: binding.bindingId,
          },
        },
        select: { role: true, revision: true },
      });
      if (aggregate === null || aggregate.role !== binding.role)
        throw new AdministrationNotFoundError();
      requireAiConfigurationRevision(
        input.expectedRevision,
        aggregate.revision,
      );
      const latest = await database.aiModelBindingVersion.findFirst({
        where: {
          workspaceId: binding.workspaceId,
          modelBindingId: binding.bindingId,
        },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      if (latest === null || binding.version !== latest.version + 1)
        throw new AdministrationConflictError();
      await requireProviderAndCatalog(database, binding);
      await createBindingVersion(database, binding);
      const updated = await database.aiModelBinding.updateMany({
        where: {
          workspaceId: binding.workspaceId,
          id: binding.bindingId,
          revision: input.expectedRevision,
        },
        data: {
          revision: input.expectedRevision + 1,
          draftVersionId: binding.bindingVersionId,
        },
      });
      if (updated.count !== 1) throw new AdministrationConflictError();
      await recordMutation(
        database,
        binding.workspaceId,
        input.audit.action,
        input.mutation,
        binding.bindingId,
      );
      await appendAudit(database, input.audit, this.nextId);
      await this.recordChange(
        database,
        binding.workspaceId,
        "ai-bindings",
        binding.bindingId,
        changeVersion(binding.bindingVersionId, input.expectedRevision + 1),
      );
      return Object.freeze({
        summary: await bindingSummary(
          database,
          binding.workspaceId,
          binding.bindingVersionId,
        ),
        idempotency: "created" as const,
      });
    });
  }

  public async transitionBindingAndRecord(
    input: Parameters<AiConfigurationStore["transitionBindingAndRecord"]>[0],
  ) {
    return this.client.$transaction(async (database) => {
      await requireActor(database, input.audit);
      await lockAggregate(
        database,
        input.workspaceId,
        "ai-binding",
        input.bindingId,
      );
      const replay = await existingMutation(
        database,
        input.workspaceId,
        input.audit.action,
        input.mutation,
        input.bindingId,
      );
      const aggregate = await database.aiModelBinding.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.bindingId,
          },
        },
        select: {
          revision: true,
          lifecycle: true,
          activeVersionId: true,
          draftVersionId: true,
        },
      });
      if (aggregate === null) throw new AdministrationNotFoundError();
      if (replay) {
        const versionId = selectedBindingVersion(aggregate);
        return Object.freeze({
          summary: await bindingSummary(database, input.workspaceId, versionId),
          idempotency: "replayed" as const,
        });
      }
      requireAiConfigurationRevision(
        input.expectedRevision,
        aggregate.revision,
      );
      const activeVersionId =
        input.lifecycle === "active"
          ? aggregate.draftVersionId
          : aggregate.activeVersionId;
      if (activeVersionId === null) throw new AdministrationConflictError();
      if (input.lifecycle === "disabled") {
        const defaultCount = await database.aiWorkspaceBindingDefault.count({
          where: {
            workspaceId: input.workspaceId,
            modelBindingVersionId: activeVersionId,
          },
        });
        if (defaultCount > 0) throw new AdministrationConflictError();
      }
      const updated = await database.aiModelBinding.updateMany({
        where: {
          workspaceId: input.workspaceId,
          id: input.bindingId,
          revision: input.expectedRevision,
        },
        data: {
          lifecycle: input.lifecycle,
          activeVersionId,
          revision: input.expectedRevision + 1,
        },
      });
      if (updated.count !== 1) throw new AdministrationConflictError();
      if (
        input.lifecycle === "active" &&
        aggregate.activeVersionId !== null &&
        aggregate.activeVersionId !== activeVersionId
      ) {
        const defaults = await database.aiWorkspaceBindingDefault.findMany({
          where: {
            workspaceId: input.workspaceId,
            modelBindingVersionId: aggregate.activeVersionId,
          },
          select: { role: true, revision: true },
        });
        await database.aiWorkspaceBindingDefault.updateMany({
          where: {
            workspaceId: input.workspaceId,
            modelBindingVersionId: aggregate.activeVersionId,
          },
          data: {
            modelBindingVersionId: activeVersionId,
            revision: { increment: 1 },
          },
        });
        for (const roleDefault of defaults) {
          await this.recordChange(
            database,
            input.workspaceId,
            "ai-role-defaults",
            `role:${roleDefault.role}`,
            changeVersion(activeVersionId, roleDefault.revision + 1),
          );
        }
      }
      await recordMutation(
        database,
        input.workspaceId,
        input.audit.action,
        input.mutation,
        input.bindingId,
      );
      await appendAudit(database, input.audit, this.nextId);
      await this.recordChange(
        database,
        input.workspaceId,
        "ai-bindings",
        input.bindingId,
        changeVersion(activeVersionId, input.expectedRevision + 1),
      );
      return Object.freeze({
        summary: await bindingSummary(
          database,
          input.workspaceId,
          activeVersionId,
        ),
        idempotency: "created" as const,
      });
    });
  }

  public async setRoleDefaultAndRecord(
    input: Parameters<AiConfigurationStore["setRoleDefaultAndRecord"]>[0],
  ) {
    return this.client.$transaction(async (database) => {
      await requireActor(database, input.audit);
      const target = `role:${input.role}`;
      await lockAggregate(
        database,
        input.workspaceId,
        "ai-role-default",
        input.role,
      );
      const replay = await existingMutation(
        database,
        input.workspaceId,
        input.audit.action,
        input.mutation,
        target,
      );
      if (replay) {
        return Object.freeze({
          summary: await roleDefaultSummary(
            database,
            input.workspaceId,
            input.role,
          ),
          idempotency: "replayed" as const,
        });
      }
      const current = await database.aiWorkspaceBindingDefault.findUnique({
        where: {
          workspaceId_role: {
            workspaceId: input.workspaceId,
            role: input.role,
          },
        },
        select: { revision: true },
      });
      requireAiConfigurationRevision(
        input.expectedRevision,
        current?.revision ?? 0,
      );
      const binding = await database.aiModelBindingVersion.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.bindingVersionId,
          },
        },
        select: { modelBindingId: true },
      });
      if (binding === null) throw new AdministrationNotFoundError();
      await lockAggregate(
        database,
        input.workspaceId,
        "ai-binding",
        binding.modelBindingId,
      );
      const aggregate = await database.aiModelBinding.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: binding.modelBindingId,
          },
        },
        select: { role: true, lifecycle: true, activeVersionId: true },
      });
      if (
        aggregate === null ||
        aggregate.role !== input.role ||
        aggregate.lifecycle !== "active" ||
        aggregate.activeVersionId !== input.bindingVersionId
      )
        throw new AdministrationNotFoundError();
      await database.aiWorkspaceBindingDefault.upsert({
        where: {
          workspaceId_role: {
            workspaceId: input.workspaceId,
            role: input.role,
          },
        },
        create: {
          workspaceId: input.workspaceId,
          role: input.role,
          modelBindingVersionId: input.bindingVersionId,
          revision: 1,
        },
        update: {
          modelBindingVersionId: input.bindingVersionId,
          revision: input.expectedRevision + 1,
        },
      });
      await recordMutation(
        database,
        input.workspaceId,
        input.audit.action,
        input.mutation,
        target,
      );
      await appendAudit(database, input.audit, this.nextId);
      await this.recordChange(
        database,
        input.workspaceId,
        "ai-role-defaults",
        target,
        changeVersion(input.bindingVersionId, input.expectedRevision + 1),
      );
      return Object.freeze({
        summary: await roleDefaultSummary(
          database,
          input.workspaceId,
          input.role,
        ),
        idempotency: "created" as const,
      });
    });
  }

  public async createPriceOverrideAndRecord(
    input: Parameters<AiConfigurationStore["createPriceOverrideAndRecord"]>[0],
  ) {
    return this.client.$transaction(async (database) => {
      await requireActor(database, input.audit);
      await lockMutation(
        database,
        input.workspaceId,
        input.audit.action,
        input.mutation.keyDigest,
      );
      const replay = await existingMutation(
        database,
        input.workspaceId,
        input.audit.action,
        input.mutation,
        input.override.id,
      );
      if (replay) {
        return Object.freeze({
          summary: await priceOverrideSummary(
            database,
            input.workspaceId,
            input.override.scope,
            input.override.id,
          ),
          idempotency: "replayed" as const,
        });
      }
      await requirePriceTarget(database, input.workspaceId, input.override);
      if (input.override.scope === "workspace") {
        await database.aiWorkspacePriceOverride.create({
          data: {
            id: input.override.id,
            workspaceId: input.workspaceId,
            provider: input.override.provider,
            canonicalModel: input.override.canonicalModel,
            source: "administration",
            effectiveFrom: at(input.override.effectiveFrom),
            effectiveTo:
              input.override.effectiveTo === undefined
                ? undefined
                : at(input.override.effectiveTo),
          },
        });
      } else {
        await database.aiBindingPriceOverride.create({
          data: {
            id: input.override.id,
            workspaceId: input.workspaceId,
            modelBindingVersionId: input.override.bindingVersionId as string,
            source: "administration",
            effectiveFrom: at(input.override.effectiveFrom),
            effectiveTo:
              input.override.effectiveTo === undefined
                ? undefined
                : at(input.override.effectiveTo),
          },
        });
      }
      for (const component of input.override.components) {
        await database.aiPriceOverrideComponent.create({
          data: {
            id: component.id,
            ...(input.override.scope === "workspace"
              ? {
                  workspaceId: input.workspaceId,
                  workspacePriceOverrideId: input.override.id,
                }
              : {
                  workspaceId: input.workspaceId,
                  bindingPriceOverrideId: input.override.id,
                }),
            componentKind: component.kind,
            billingUnit: component.unit,
            amount: component.amount,
            currency: component.currency,
            conditions: component.conditions as Prisma.InputJsonObject,
            rawEntry: { source: "administration" },
          },
        });
      }
      await recordMutation(
        database,
        input.workspaceId,
        input.audit.action,
        input.mutation,
        input.override.id,
      );
      await appendAudit(database, input.audit, this.nextId);
      await this.recordChange(
        database,
        input.workspaceId,
        "ai-pricing-overrides",
        input.override.id,
        input.override.id,
      );
      return Object.freeze({
        summary: input.override,
        idempotency: "created" as const,
      });
    });
  }

  public async replaceBudgetPolicyAndRecord(
    input: Parameters<AiConfigurationStore["replaceBudgetPolicyAndRecord"]>[0],
  ) {
    return this.client.$transaction(async (database) => {
      await requireActor(database, input.audit);
      const target = `budget:${input.policy.scope}:${input.policy.scopeKey}`;
      await lockAggregate(
        database,
        input.workspaceId,
        "ai-budget-policy",
        `${input.policy.scope}:${input.policy.scopeKey}`,
      );
      const replay = await existingMutation(
        database,
        input.workspaceId,
        input.audit.action,
        input.mutation,
        target,
      );
      if (replay) {
        return Object.freeze({
          summary: await budgetSummary(
            database,
            input.workspaceId,
            input.policy.id,
          ),
          idempotency: "replayed" as const,
        });
      }
      const current = await database.aiBudgetPolicy.findFirst({
        where: {
          workspaceId: input.workspaceId,
          scope: input.policy.scope,
          scopeKey: input.policy.scopeKey,
          active: true,
        },
        select: { id: true, revision: true },
      });
      requireAiConfigurationRevision(
        input.expectedRevision,
        current?.revision ?? 0,
      );
      await database.aiBudgetPolicy.updateMany({
        where: {
          workspaceId: input.workspaceId,
          scope: input.policy.scope,
          scopeKey: input.policy.scopeKey,
          active: true,
        },
        data: { active: false },
      });
      await database.aiBudgetPolicy.create({
        data: {
          id: input.policy.id,
          workspaceId: input.workspaceId,
          scope: input.policy.scope,
          scopeKey: input.policy.scopeKey,
          limitAmount: input.policy.limitAmount,
          currency: input.policy.currency,
          hard: input.policy.hard,
          active: true,
          revision: input.expectedRevision + 1,
          supersedesPolicyId: current?.id,
        },
      });
      await recordMutation(
        database,
        input.workspaceId,
        input.audit.action,
        input.mutation,
        target,
      );
      await appendAudit(database, input.audit, this.nextId);
      await this.recordChange(
        database,
        input.workspaceId,
        "ai-budgets",
        target,
        changeVersion(input.policy.id, input.expectedRevision + 1),
      );
      return Object.freeze({
        summary: await budgetSummary(
          database,
          input.workspaceId,
          input.policy.id,
        ),
        idempotency: "created" as const,
      });
    });
  }

  private async recordChange(
    database: Prisma.TransactionClient,
    workspaceId: string,
    resourceType: string,
    aggregateId: string,
    currentVersionId: string,
  ): Promise<void> {
    await database.administrationAiConfigurationChangeOutbox.create({
      data: {
        id: this.nextId(),
        workspaceId,
        resourceType,
        aggregateId,
        currentVersionId,
        cacheScopes: [
          `workspace:${workspaceId}:configuration`,
          `workspace:${workspaceId}:${resourceType}`,
          `configuration:${aggregateId}`,
        ],
      },
    });
  }
}

async function requireProviderAndCatalog(
  database: Database,
  binding: Parameters<
    AiConfigurationStore["createBindingDraftAndRecord"]
  >[0]["binding"],
): Promise<void> {
  const providerVersion = await database.aiProviderInstanceVersion.findUnique({
    where: {
      workspaceId_id: {
        workspaceId: binding.workspaceId,
        id: binding.providerInstanceVersionId,
      },
    },
    select: {
      providerInstanceId: true,
      endpoint: true,
      wireApi: true,
      secretReference: true,
    },
  });
  if (
    providerVersion === null ||
    providerVersion.endpoint !== binding.endpoint ||
    providerVersion.wireApi !== binding.wireApi ||
    providerVersion.secretReference !== binding.secretReference
  )
    throw new AdministrationNotFoundError();
  const provider = await database.aiProviderInstance.findUnique({
    where: {
      workspaceId_id: {
        workspaceId: binding.workspaceId,
        id: providerVersion.providerInstanceId,
      },
    },
    select: { providerType: true, lifecycle: true },
  });
  if (
    provider === null ||
    provider.providerType !== binding.providerType ||
    provider.lifecycle !== "active"
  )
    throw new AdministrationNotFoundError();
  const model = await database.aiCatalogModel.findUnique({
    where: {
      catalogSnapshotId_canonicalModel: {
        catalogSnapshotId: binding.catalogSnapshotId,
        canonicalModel: binding.canonicalModel,
      },
    },
    select: { id: true },
  });
  if (model === null) throw new AdministrationNotFoundError();
}

async function createBindingVersion(
  database: Database,
  binding: Parameters<
    AiConfigurationStore["createBindingDraftAndRecord"]
  >[0]["binding"],
): Promise<void> {
  const model = await database.aiCatalogModel.findUnique({
    where: {
      catalogSnapshotId_canonicalModel: {
        catalogSnapshotId: binding.catalogSnapshotId,
        canonicalModel: binding.canonicalModel,
      },
    },
    select: { id: true },
  });
  if (model === null) throw new AdministrationNotFoundError();
  await database.aiModelBindingVersion.create({
    data: {
      id: binding.bindingVersionId,
      workspaceId: binding.workspaceId,
      modelBindingId: binding.bindingId,
      version: binding.version,
      providerInstanceVersionId: binding.providerInstanceVersionId,
      catalogSnapshotId: binding.catalogSnapshotId,
      catalogModelId: model.id,
      canonicalModel: binding.canonicalModel,
      wireApi: binding.wireApi,
      parameters: binding.parameters as Prisma.InputJsonObject,
      capabilities: [...binding.capabilities],
      maximumInputTokens: binding.maximumInputTokens,
      maximumOutputTokens: binding.maximumOutputTokens,
      secretReference: binding.secretReference,
    },
  });
}

async function requirePriceTarget(
  database: Database,
  workspaceId: string,
  override: AiPriceOverrideSummary,
): Promise<void> {
  if (override.scope === "binding") {
    const binding = await database.aiModelBindingVersion.findUnique({
      where: {
        workspaceId_id: {
          workspaceId,
          id: override.bindingVersionId as string,
        },
      },
      select: { canonicalModel: true, catalogModelId: true },
    });
    if (binding === null || binding.canonicalModel !== override.canonicalModel)
      throw new AdministrationNotFoundError();
    const catalog = await database.aiCatalogModel.findUnique({
      where: { id: binding.catalogModelId },
      select: { provider: true },
    });
    if (catalog === null || catalog.provider !== override.provider)
      throw new AdministrationNotFoundError();
    return;
  }
  const catalog = await database.aiCatalogModel.findFirst({
    where: {
      provider: override.provider,
      canonicalModel: override.canonicalModel,
    },
    select: { id: true },
  });
  if (catalog === null) throw new AdministrationNotFoundError();
}

async function bindingSummary(
  database: Database,
  workspaceId: string,
  versionId: string,
): Promise<AiBindingSummary> {
  const version = await database.aiModelBindingVersion.findUnique({
    where: { workspaceId_id: { workspaceId, id: versionId } },
    select: {
      id: true,
      modelBindingId: true,
      providerInstanceVersionId: true,
      catalogSnapshotId: true,
      canonicalModel: true,
      version: true,
    },
  });
  if (version === null) throw new AdministrationNotFoundError();
  const aggregate = await database.aiModelBinding.findUnique({
    where: { workspaceId_id: { workspaceId, id: version.modelBindingId } },
    select: { role: true, lifecycle: true, revision: true },
  });
  if (aggregate === null || !isLifecycle(aggregate.lifecycle))
    throw new AdministrationNotFoundError();
  return Object.freeze({
    bindingId: version.modelBindingId,
    bindingVersionId: version.id,
    workspaceId,
    role: aggregate.role as AiBindingSummary["role"],
    providerInstanceVersionId: version.providerInstanceVersionId,
    catalogSnapshotId: version.catalogSnapshotId,
    canonicalModel: version.canonicalModel,
    version: version.version,
    revision: aggregate.revision,
    lifecycle: aggregate.lifecycle,
  });
}

async function roleDefaultSummary(
  database: Database,
  workspaceId: string,
  role: string,
): Promise<AiRoleDefaultSummary> {
  const value = await database.aiWorkspaceBindingDefault.findUnique({
    where: { workspaceId_role: { workspaceId, role } },
    select: { modelBindingVersionId: true, revision: true },
  });
  if (value === null) throw new AdministrationNotFoundError();
  return Object.freeze({
    workspaceId,
    role: role as AiRoleDefaultSummary["role"],
    bindingVersionId: value.modelBindingVersionId,
    revision: value.revision,
  });
}

async function priceOverrideSummary(
  database: Database,
  workspaceId: string,
  scope: "workspace" | "binding",
  id: string,
): Promise<AiPriceOverrideSummary> {
  if (scope === "workspace") {
    const value = await database.aiWorkspacePriceOverride.findUnique({
      where: { workspaceId_id: { workspaceId, id } },
      select: {
        id: true,
        provider: true,
        canonicalModel: true,
        effectiveFrom: true,
        effectiveTo: true,
      },
    });
    if (value === null) throw new AdministrationNotFoundError();
    const count = await database.aiPriceOverrideComponent.count({
      where: { workspaceId, workspacePriceOverrideId: id },
    });
    const currency = await overrideCurrency(database, workspaceId, {
      workspacePriceOverrideId: id,
    });
    return Object.freeze({
      id: value.id,
      workspaceId,
      scope,
      provider: value.provider,
      canonicalModel: value.canonicalModel,
      effectiveFrom: value.effectiveFrom.toISOString(),
      ...(value.effectiveTo === null
        ? {}
        : { effectiveTo: value.effectiveTo.toISOString() }),
      currency,
      componentCount: count,
    });
  }
  const value = await database.aiBindingPriceOverride.findUnique({
    where: { workspaceId_id: { workspaceId, id } },
    select: {
      id: true,
      modelBindingVersionId: true,
      effectiveFrom: true,
      effectiveTo: true,
    },
  });
  if (value === null) throw new AdministrationNotFoundError();
  const binding = await database.aiModelBindingVersion.findUnique({
    where: { workspaceId_id: { workspaceId, id: value.modelBindingVersionId } },
    select: { canonicalModel: true, catalogModelId: true },
  });
  if (binding === null) throw new AdministrationNotFoundError();
  const model = await database.aiCatalogModel.findUnique({
    where: { id: binding.catalogModelId },
    select: { provider: true },
  });
  if (model === null) throw new AdministrationNotFoundError();
  const count = await database.aiPriceOverrideComponent.count({
    where: { workspaceId, bindingPriceOverrideId: id },
  });
  const currency = await overrideCurrency(database, workspaceId, {
    bindingPriceOverrideId: id,
  });
  return Object.freeze({
    id: value.id,
    workspaceId,
    scope,
    provider: model.provider,
    canonicalModel: binding.canonicalModel,
    bindingVersionId: value.modelBindingVersionId,
    effectiveFrom: value.effectiveFrom.toISOString(),
    ...(value.effectiveTo === null
      ? {}
      : { effectiveTo: value.effectiveTo.toISOString() }),
    currency,
    componentCount: count,
  });
}

async function overrideCurrency(
  database: Database,
  workspaceId: string,
  where: Prisma.AiPriceOverrideComponentWhereInput,
): Promise<string> {
  const component = await database.aiPriceOverrideComponent.findFirst({
    where: { workspaceId, ...where },
    select: { currency: true },
  });
  if (component === null) throw new AdministrationNotFoundError();
  return component.currency;
}

async function budgetSummary(
  database: Database,
  workspaceId: string,
  id: string,
): Promise<AiBudgetPolicySummary> {
  const value = await database.aiBudgetPolicy.findUnique({
    where: { workspaceId_id: { workspaceId, id } },
    select: {
      id: true,
      scope: true,
      scopeKey: true,
      limitAmount: true,
      currency: true,
      hard: true,
      active: true,
      revision: true,
    },
  });
  if (value === null) throw new AdministrationNotFoundError();
  return Object.freeze({
    id: value.id,
    workspaceId,
    scope: value.scope as AiBudgetPolicySummary["scope"],
    scopeKey: value.scopeKey,
    limitAmount: value.limitAmount.toString(),
    currency: value.currency,
    hard: value.hard,
    active: value.active,
    revision: value.revision,
  });
}

async function catalogSummary(
  database: Database,
  id: string,
): Promise<AiCatalogSnapshotSummary> {
  const snapshot = await database.aiCatalogSnapshot.findUnique({
    where: { id },
    select: {
      id: true,
      sha256: true,
      upstreamCommitSha: true,
      fetchedAt: true,
    },
  });
  if (snapshot === null) throw new AdministrationNotFoundError();
  const modelCount = await database.aiCatalogModel.count({
    where: { catalogSnapshotId: id },
  });
  return Object.freeze({
    id: snapshot.id,
    sha256: snapshot.sha256,
    upstreamCommitSha: snapshot.upstreamCommitSha,
    fetchedAt: snapshot.fetchedAt.toISOString(),
    modelCount,
  });
}

async function existingMutation(
  database: Database,
  workspaceId: string,
  operation: string,
  mutation: AiConfigurationMutation,
  expectedTarget: string,
): Promise<boolean> {
  const value = await database.idempotencyRecord.findUnique({
    where: {
      workspaceId_operation_keyDigest: {
        workspaceId,
        operation,
        keyDigest: mutation.keyDigest,
      },
    },
    select: { requestDigest: true, resourceId: true },
  });
  if (value === null) return false;
  if (
    value.requestDigest !== mutation.requestDigest ||
    value.resourceId !== expectedTarget
  )
    throw new IdempotencyConflictError();
  return true;
}

async function recordMutation(
  database: Database,
  workspaceId: string,
  operation: string,
  mutation: AiConfigurationMutation,
  resourceId: string,
): Promise<void> {
  await database.idempotencyRecord.create({
    data: {
      workspaceId,
      operation,
      keyDigest: mutation.keyDigest,
      requestDigest: mutation.requestDigest,
      resourceId,
    },
  });
}

async function lockMutation(
  database: Database,
  workspaceId: string,
  operation: string,
  keyDigest: string,
): Promise<void> {
  await database.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:${operation}:${keyDigest}`}, 0))`;
}

async function lockAggregate(
  database: Database,
  workspaceId: string,
  kind: string,
  id: string,
): Promise<void> {
  await database.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:${kind}:${id}`}, 0))`;
}

async function requireActor(
  database: Database,
  audit: AiConfigurationAuditRecord,
): Promise<void> {
  const actor = await database.principal.findUnique({
    where: {
      workspaceId_id: {
        workspaceId: audit.workspaceId,
        id: audit.actorPrincipalId,
      },
    },
    select: { id: true },
  });
  if (actor === null) throw new AdministrationNotFoundError();
}

async function appendAudit(
  database: Database,
  input: AiConfigurationAuditRecord,
  nextId: () => string,
): Promise<void> {
  await database.auditEvent.create({
    data: {
      id: nextId(),
      workspaceId: input.workspaceId,
      actorPrincipalId: input.actorPrincipalId,
      action: input.action,
      targetId: input.targetId,
      targetType: input.targetType,
      permission: input.permission,
      outcome: input.outcome,
      occurredAt: at(input.occurredAt),
      origin: input.origin,
      idempotencyKeyDigest: input.idempotencyKeyDigest,
      beforeHash: input.beforeHash,
      afterHash: input.afterHash,
      requestId: input.requestId,
      correlationId: input.correlationId,
      uiActionId: input.uiActionId,
    },
  });
}

function at(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
    throw new RangeError("Stored administration timestamp is invalid.");
  return date;
}

function isLifecycle(value: string): value is AiBindingSummary["lifecycle"] {
  return value === "draft" || value === "active" || value === "disabled";
}

function selectedBindingVersion(
  input: Readonly<{
    readonly activeVersionId: string | null;
    readonly draftVersionId: string | null;
  }>,
): string {
  const selected = input.activeVersionId ?? input.draftVersionId;
  if (selected === null) throw new AdministrationNotFoundError();
  return selected;
}

function changeVersion(versionId: string, revision: number): string {
  return `${versionId}:r${revision}`;
}

/** Retained only for adapter-local deterministic hashes used in test diagnostics. */
export function aiConfigurationSafeHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}
