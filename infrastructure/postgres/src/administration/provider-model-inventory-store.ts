import { createHash, randomUUID } from "node:crypto";
import type {
  AiConfigurationAuditRecord,
  AiConfigurationMutation,
  ProviderModelInventoryStore,
  ProviderModelInventorySummary,
} from "@caseweaver/administration";
import {
  AdministrationConflictError,
  AdministrationNotFoundError,
  IdempotencyConflictError,
} from "@caseweaver/administration";
import type { ProviderDiscoveredModel } from "@caseweaver/ai-sdk";
import type { Prisma, PrismaClient } from "@prisma/client";

type Database = PrismaClient | Prisma.TransactionClient;
const batchSize = 250;

/**
 * Server-private current provider configuration for metadata discovery. It is
 * intentionally not an administration DTO: endpoint and opaque locator values
 * are returned only to trusted API composition immediately before discovery.
 */
export class PostgresProviderModelInventoryConfigurationStore {
  public constructor(private readonly client: PrismaClient) {}

  public async load(
    input: Readonly<{
      readonly workspaceId: string;
      readonly providerInstanceId: string;
    }>,
  ): Promise<
    | Readonly<{
        readonly providerInstanceVersionId: string;
        readonly providerType: string;
        readonly endpoint: string;
        readonly wireApi:
          | "embeddings"
          | "chatCompletions"
          | "responses"
          | "custom";
        readonly secretReference: string;
      }>
    | undefined
  > {
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
    const version = await this.client.aiProviderInstanceVersion.findFirst({
      where: {
        workspaceId: input.workspaceId,
        providerInstanceId: input.providerInstanceId,
      },
      orderBy: { version: "desc" },
      select: {
        id: true,
        endpoint: true,
        wireApi: true,
        secretReference: true,
      },
    });
    if (
      version === null ||
      (version.wireApi !== "embeddings" &&
        version.wireApi !== "chatCompletions" &&
        version.wireApi !== "responses" &&
        version.wireApi !== "custom")
    ) {
      return undefined;
    }
    const credential = await this.client.credentialRegistration.findFirst({
      where: {
        workspaceId: input.workspaceId,
        secretReference: version.secretReference,
        lifecycle: "active",
      },
      select: { id: true },
    });
    if (credential === null) return undefined;
    return Object.freeze({
      providerInstanceVersionId: version.id,
      providerType: provider.providerType,
      endpoint: version.endpoint,
      wireApi: version.wireApi,
      secretReference: version.secretReference,
    });
  }
}

/**
 * PostgreSQL persistence for an immutable provider-owned model inventory.
 * The generic catalog tables hold only a safe normalized projection so existing
 * immutable bindings and pricing resolution can be reused. The companion table
 * is the workspace/provider authorization boundary: a catalog projection is
 * not selectable unless it was discovered from that exact active provider
 * version.
 */
export class PostgresProviderModelInventoryStore
  implements ProviderModelInventoryStore
{
  public constructor(
    private readonly client: PrismaClient,
    private readonly nextId: () => string = randomUUID,
  ) {}

  public async refreshAndRecord(
    input: Parameters<ProviderModelInventoryStore["refreshAndRecord"]>[0],
  ) {
    const digest = contentDigest(input);
    const inventoryId = `provider-model-inventory-${digest}`;
    const catalogSnapshotId = `provider-model-catalog-${digest}`;
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
        inventoryId,
      );
      if (replay) {
        return Object.freeze({
          summary: await summary(database, input.workspaceId, inventoryId),
          idempotency: "replayed" as const,
        });
      }
      await requireCurrentProvider(database, input);
      const existing =
        await database.aiProviderModelInventorySnapshot.findUnique({
          where: {
            workspaceId_providerInstanceVersionId_contentSha256: {
              workspaceId: input.workspaceId,
              providerInstanceVersionId: input.providerInstanceVersionId,
              contentSha256: digest,
            },
          },
          select: { id: true },
        });
      if (existing !== null) {
        if (existing.id !== inventoryId)
          throw new AdministrationConflictError();
        await recordMutation(
          database,
          input.workspaceId,
          input.audit.action,
          input.mutation,
          inventoryId,
        );
        await appendAudit(database, input.audit, this.nextId);
        return Object.freeze({
          summary: await summary(database, input.workspaceId, inventoryId),
          idempotency: "created" as const,
        });
      }
      const priceSource = await trustedPriceSource(database, input.models);
      const discoveredAt = date(input.audit.occurredAt);
      await database.aiCatalogSnapshot.create({
        data: {
          id: catalogSnapshotId,
          // This is a source kind, not an endpoint. The actual endpoint is
          // retained only in the provider version and is never projected here.
          upstreamUrl: "provider-inventory://server-managed",
          upstreamCommitSha: digest,
          fetchedAt: discoveredAt,
          sha256: digest,
          rawEntries: {
            source: "provider-inventory",
            modelCount: input.models.length,
          },
        },
      });
      const models = input.models.map((model) => {
        const id = catalogModelId(catalogSnapshotId, model.canonicalModel);
        return {
          id,
          catalogSnapshotId,
          canonicalModel: model.canonicalModel,
          provider: input.providerType,
          supportedRoles: [...model.supportedRoles],
          capabilities: [...model.capabilities],
          maximumInputTokens: model.maximumInputTokens,
          maximumOutputTokens: model.maximumOutputTokens,
          rawEntry: {
            source: "provider-inventory",
            supportedRoles: [...model.supportedRoles],
            capabilities: [...model.capabilities],
          },
        };
      });
      for (let offset = 0; offset < models.length; offset += batchSize) {
        await database.aiCatalogModel.createMany({
          data: models.slice(offset, offset + batchSize),
        });
      }
      const prices = models.flatMap((model) => {
        const source = priceSource.get(model.canonicalModel);
        if (source === undefined) return [];
        return source.components.map((component, index) => ({
          id: `provider-inventory-price-${digestValue(
            `${model.id}:${component.id}:${index}`,
          )}`,
          catalogModelId: model.id,
          componentKind: component.componentKind,
          billingUnit: component.billingUnit,
          amount: component.amount,
          currency: component.currency,
          effectiveFrom: component.effectiveFrom,
          effectiveTo: component.effectiveTo ?? undefined,
          conditions: component.conditions as Prisma.InputJsonObject,
          sourceRevision: component.sourceRevision,
          // Preserve normalized price values and source revision but do not
          // propagate a raw provider response into the inventory projection.
          rawEntry: { source: "trusted-pricing-catalog" },
        }));
      });
      for (let offset = 0; offset < prices.length; offset += batchSize) {
        await database.aiCatalogPriceComponent.createMany({
          data: prices.slice(offset, offset + batchSize),
        });
      }
      const pricedModelCount = models.filter((model) =>
        priceSource.has(model.canonicalModel),
      ).length;
      await database.aiProviderModelInventorySnapshot.create({
        data: {
          id: inventoryId,
          workspaceId: input.workspaceId,
          providerInstanceId: input.providerInstanceId,
          providerInstanceVersionId: input.providerInstanceVersionId,
          catalogSnapshotId,
          contentSha256: digest,
          discoveredAt,
          modelCount: input.models.length,
          pricedModelCount,
        },
      });
      await recordMutation(
        database,
        input.workspaceId,
        input.audit.action,
        input.mutation,
        inventoryId,
      );
      await appendAudit(database, input.audit, this.nextId);
      await database.administrationAiConfigurationChangeOutbox.create({
        data: {
          id: this.nextId(),
          workspaceId: input.workspaceId,
          resourceType: "ai-provider-model-inventories",
          aggregateId: input.providerInstanceId,
          currentVersionId: inventoryId,
          cacheScopes: [
            `workspace:${input.workspaceId}:configuration`,
            `workspace:${input.workspaceId}:ai-provider-model-inventories`,
            `configuration:${input.providerInstanceId}`,
          ],
        },
      });
      return Object.freeze({
        summary: await summary(database, input.workspaceId, inventoryId),
        idempotency: "created" as const,
      });
    });
  }
}

async function requireCurrentProvider(
  database: Database,
  input: Parameters<ProviderModelInventoryStore["refreshAndRecord"]>[0],
): Promise<void> {
  const version = await database.aiProviderInstanceVersion.findUnique({
    where: {
      workspaceId_id: {
        workspaceId: input.workspaceId,
        id: input.providerInstanceVersionId,
      },
    },
    select: { providerInstanceId: true, wireApi: true },
  });
  const provider = await database.aiProviderInstance.findUnique({
    where: {
      workspaceId_id: {
        workspaceId: input.workspaceId,
        id: input.providerInstanceId,
      },
    },
    select: { providerType: true, lifecycle: true },
  });
  if (
    version === null ||
    provider === null ||
    provider.lifecycle !== "active" ||
    version.providerInstanceId !== input.providerInstanceId ||
    version.wireApi !== input.wireApi ||
    provider.providerType !== input.providerType
  ) {
    throw new AdministrationNotFoundError();
  }
}

type PriceSource = Readonly<{
  components: readonly Readonly<{
    readonly id: string;
    readonly componentKind: string;
    readonly billingUnit: string;
    readonly amount: Prisma.Decimal;
    readonly currency: string;
    readonly effectiveFrom: Date;
    readonly effectiveTo: Date | null;
    readonly conditions: Prisma.JsonValue;
    readonly sourceRevision: string;
  }>[];
}>;

/** Exact canonical match only: an adapter cannot guess that similarly named
 * cross-provider routes have identical pricing. */
async function trustedPriceSource(
  database: Database,
  models: readonly ProviderDiscoveredModel[],
): Promise<ReadonlyMap<string, PriceSource>> {
  if (models.length === 0) return new Map();
  const inventorySnapshots =
    await database.aiProviderModelInventorySnapshot.findMany({
      select: { catalogSnapshotId: true },
    });
  const inventoryIds = inventorySnapshots.map(
    (snapshot) => snapshot.catalogSnapshotId,
  );
  const candidates = await database.aiCatalogModel.findMany({
    where: {
      canonicalModel: { in: models.map((model) => model.canonicalModel) },
      ...(inventoryIds.length === 0
        ? {}
        : { catalogSnapshotId: { notIn: inventoryIds } }),
    },
    select: { id: true, canonicalModel: true, catalogSnapshotId: true },
  });
  if (candidates.length === 0) return new Map();
  const snapshots = await database.aiCatalogSnapshot.findMany({
    where: {
      id: {
        in: [...new Set(candidates.map((item) => item.catalogSnapshotId))],
      },
    },
    select: { id: true, fetchedAt: true },
  });
  const snapshotTime = new Map(
    snapshots.map((snapshot) => [snapshot.id, snapshot.fetchedAt.getTime()]),
  );
  const best = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    const current = best.get(candidate.canonicalModel);
    if (
      current === undefined ||
      (snapshotTime.get(candidate.catalogSnapshotId) ?? 0) >
        (snapshotTime.get(current.catalogSnapshotId) ?? 0)
    ) {
      best.set(candidate.canonicalModel, candidate);
    }
  }
  const components = await database.aiCatalogPriceComponent.findMany({
    where: {
      catalogModelId: { in: [...best.values()].map((model) => model.id) },
    },
    select: {
      id: true,
      catalogModelId: true,
      componentKind: true,
      billingUnit: true,
      amount: true,
      currency: true,
      effectiveFrom: true,
      effectiveTo: true,
      conditions: true,
      sourceRevision: true,
    },
    orderBy: { id: "asc" },
  });
  const canonicalForId = new Map(
    [...best.values()].map((model) => [model.id, model.canonicalModel]),
  );
  const grouped = new Map<string, PriceSource["components"]>();
  for (const component of components) {
    const canonicalModel = canonicalForId.get(component.catalogModelId);
    if (canonicalModel === undefined) continue;
    grouped.set(canonicalModel, [
      ...(grouped.get(canonicalModel) ?? []),
      Object.freeze(component),
    ]);
  }
  return new Map(
    [...grouped.entries()]
      .filter(([, componentsForModel]) => componentsForModel.length > 0)
      .map(([canonicalModel, componentsForModel]) => [
        canonicalModel,
        Object.freeze({ components: Object.freeze(componentsForModel) }),
      ]),
  );
}

async function summary(
  database: Database,
  workspaceId: string,
  id: string,
): Promise<ProviderModelInventorySummary> {
  const value = await database.aiProviderModelInventorySnapshot.findUnique({
    where: { workspaceId_id: { workspaceId, id } },
    select: {
      id: true,
      providerInstanceId: true,
      providerInstanceVersionId: true,
      discoveredAt: true,
      modelCount: true,
      pricedModelCount: true,
    },
  });
  if (value === null) throw new AdministrationNotFoundError();
  return Object.freeze({
    id: value.id,
    providerInstanceId: value.providerInstanceId,
    providerInstanceVersionId: value.providerInstanceVersionId,
    discoveredAt: value.discoveredAt.toISOString(),
    modelCount: value.modelCount,
    pricedModelCount: value.pricedModelCount,
  });
}

function contentDigest(
  input: Parameters<ProviderModelInventoryStore["refreshAndRecord"]>[0],
): string {
  return digestValue(
    JSON.stringify({
      workspaceId: input.workspaceId,
      providerInstanceVersionId: input.providerInstanceVersionId,
      providerType: input.providerType,
      wireApi: input.wireApi,
      models: input.models,
    }),
  );
}

function catalogModelId(snapshotId: string, canonicalModel: string): string {
  return `catalog-model-${digestValue(`${snapshotId}:${canonicalModel}`)}`;
}

function digestValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

async function lockMutation(
  database: Database,
  workspaceId: string,
  operation: string,
  keyDigest: string,
): Promise<void> {
  await database.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:${operation}:${keyDigest}`}, 0))`;
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
  ) {
    throw new IdempotencyConflictError();
  }
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
      occurredAt: date(input.occurredAt),
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

function date(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new RangeError("Provider inventory timestamp is invalid.");
  }
  return parsed;
}
