import type { AiBindingDraftInput } from "@caseweaver/administration";
import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Server-side assembly for an AI binding draft. Browser commands select only
 * persisted provider/catalog identities and safe limits; endpoint, wire API,
 * parameters, catalog pricing, and the opaque secret locator come from the
 * active immutable records. Nothing returned by this adapter is an HTTP DTO.
 */
export class PostgresAiBindingDraftStore {
  public constructor(private readonly client: PrismaClient) {}

  public async load(
    input: Readonly<{
      readonly workspaceId: string;
      readonly bindingId: string;
      readonly version: number;
      readonly role: string;
      readonly providerInstanceId: string;
      readonly catalogSnapshotId: string;
      readonly canonicalModel: string;
      readonly requiredCapabilities?: readonly string[];
      readonly maximumInputTokens?: number;
      readonly maximumOutputTokens?: number;
    }>,
  ): Promise<AiBindingDraftInput | undefined> {
    const [provider, catalog] = await Promise.all([
      this.client.aiProviderInstance.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.providerInstanceId,
          },
        },
        select: { providerType: true, lifecycle: true },
      }),
      this.client.aiCatalogModel.findUnique({
        where: {
          catalogSnapshotId_canonicalModel: {
            catalogSnapshotId: input.catalogSnapshotId,
            canonicalModel: input.canonicalModel,
          },
        },
      }),
    ]);
    if (
      provider === null ||
      provider.lifecycle !== "active" ||
      catalog === null
    ) {
      return undefined;
    }
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
        parameters: true,
        secretReference: true,
      },
    });
    if (version === null) return undefined;
    const inventory =
      await this.client.aiProviderModelInventorySnapshot.findFirst({
        where: {
          workspaceId: input.workspaceId,
          providerInstanceId: input.providerInstanceId,
          providerInstanceVersionId: version.id,
          catalogSnapshotId: input.catalogSnapshotId,
        },
        select: { id: true },
      });
    // A LiteLLM entry is pricing metadata only. It may be selected only after
    // this exact provider version discovered it in a durable inventory.
    if (inventory === null) return undefined;
    const prices = await this.client.aiCatalogPriceComponent.findMany({
      where: { catalogModelId: catalog.id },
      orderBy: { id: "asc" },
    });
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
      bindingId: input.bindingId,
      version: input.version,
      role: input.role as AiBindingDraftInput["role"],
      providerInstanceVersionId: version.id,
      providerType: provider.providerType,
      endpoint: version.endpoint,
      canonicalModel: catalog.canonicalModel,
      wireApi: version.wireApi as AiBindingDraftInput["wireApi"],
      parameters: jsonRecord(version.parameters),
      secretReference: version.secretReference,
      catalogModel: {
        id: catalog.id,
        snapshotId: catalog.catalogSnapshotId,
        canonicalModel: catalog.canonicalModel,
        provider: catalog.provider,
        supportedRoles: new Set(stringArray(catalog.supportedRoles)),
        capabilities: new Set(stringArray(catalog.capabilities)),
        ...(catalog.maximumInputTokens === null
          ? {}
          : { maximumInputTokens: catalog.maximumInputTokens }),
        ...(catalog.maximumOutputTokens === null
          ? {}
          : { maximumOutputTokens: catalog.maximumOutputTokens }),
        priceComponents: prices.map((component) =>
          Object.freeze({
            id: component.id,
            kind: component.componentKind,
            unit: component.billingUnit,
            amount: component.amount.toString(),
            currency: component.currency,
            effectiveFrom: component.effectiveFrom.toISOString(),
            ...(component.effectiveTo === null
              ? {}
              : { effectiveTo: component.effectiveTo.toISOString() }),
            conditions: jsonRecord(component.conditions),
            sourceId: component.sourceRevision,
          }),
        ),
        rawEntry: jsonRecord(catalog.rawEntry),
      } as unknown as AiBindingDraftInput["catalogModel"],
      ...(input.requiredCapabilities === undefined
        ? {}
        : {
            requiredCapabilities:
              input.requiredCapabilities as AiBindingDraftInput["requiredCapabilities"],
          }),
      ...(input.maximumInputTokens === undefined
        ? {}
        : { maximumInputTokens: input.maximumInputTokens }),
      ...(input.maximumOutputTokens === undefined
        ? {}
        : { maximumOutputTokens: input.maximumOutputTokens }),
    });
  }

  /**
   * Safe server-side candidate projection for a binding form. Only the newest
   * immutable inventory discovered from the selected active provider version is
   * eligible; a global pricing catalog never supplies availability by itself.
   */
  public async listOptions(
    input: Readonly<{
      readonly workspaceId: string;
      readonly providerInstanceId: string;
      readonly role: string;
      readonly search?: string;
    }>,
  ): Promise<
    | Readonly<{
        readonly providerType: string;
        readonly wireApi: string;
        readonly models: readonly Readonly<{
          readonly catalogSnapshotId: string;
          readonly canonicalModel: string;
          readonly catalogProvider: string;
          readonly supportedRoles: readonly string[];
          readonly capabilities: readonly string[];
        }>[];
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
      select: { id: true, wireApi: true },
    });
    if (version === null) return undefined;
    const inventory =
      await this.client.aiProviderModelInventorySnapshot.findFirst({
        where: {
          workspaceId: input.workspaceId,
          providerInstanceId: input.providerInstanceId,
          providerInstanceVersionId: version.id,
        },
        orderBy: [{ discoveredAt: "desc" }, { id: "desc" }],
        select: { catalogSnapshotId: true },
      });
    if (inventory === null) {
      return Object.freeze({
        providerType: provider.providerType,
        wireApi: version.wireApi,
        models: Object.freeze([]),
      });
    }
    const models = await this.client.aiCatalogModel.findMany({
      where: {
        catalogSnapshotId: inventory.catalogSnapshotId,
        supportedRoles: { array_contains: [input.role] },
        ...(input.search === undefined
          ? {}
          : {
              canonicalModel: {
                contains: input.search,
                mode: "insensitive",
              },
            }),
      },
      orderBy: { canonicalModel: "asc" },
      // Provider inventories are bounded at acquisition (2,000) and the
      // binding form needs to expose a real multi-provider catalog, not an
      // arbitrary first 200 alphabetical entries. Keep a defensive 1,000-item
      // response bound; the optional server-side search narrows further.
      take: 1_000,
      select: {
        catalogSnapshotId: true,
        canonicalModel: true,
        provider: true,
        supportedRoles: true,
        capabilities: true,
      },
    });
    return Object.freeze({
      providerType: provider.providerType,
      wireApi: version.wireApi,
      models: Object.freeze(
        models.map((model) =>
          Object.freeze({
            catalogSnapshotId: model.catalogSnapshotId,
            canonicalModel: model.canonicalModel,
            catalogProvider: model.provider,
            supportedRoles: stringArray(model.supportedRoles),
            capabilities: stringArray(model.capabilities),
          }),
        ),
      ),
    });
  }

  /** Builds a successor version from a server-owned aggregate role and next
   * ordinal. The browser cannot change a binding's identity or role while
   * editing its effective provider/model limits. The owning use case performs
   * the final OCC check and atomic audit. */
  public async loadNextVersion(
    input: Readonly<{
      readonly workspaceId: string;
      readonly bindingId: string;
      readonly providerInstanceId: string;
      readonly catalogSnapshotId: string;
      readonly canonicalModel: string;
      readonly requiredCapabilities?: readonly string[];
      readonly maximumInputTokens?: number;
      readonly maximumOutputTokens?: number;
    }>,
  ): Promise<AiBindingDraftInput | undefined> {
    const aggregate = await this.client.aiModelBinding.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: input.bindingId,
        },
      },
      select: { role: true },
    });
    if (aggregate === null) return undefined;
    const latest = await this.client.aiModelBindingVersion.findFirst({
      where: {
        workspaceId: input.workspaceId,
        modelBindingId: input.bindingId,
      },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    if (latest === null) return undefined;
    return this.load({
      ...input,
      version: latest.version + 1,
      role: aggregate.role,
    });
  }
}

function jsonRecord(
  value: Prisma.JsonValue,
): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function stringArray(value: Prisma.JsonValue): readonly string[] {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? Object.freeze([...value])
    : Object.freeze([]);
}
