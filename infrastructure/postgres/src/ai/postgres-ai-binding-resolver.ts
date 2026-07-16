import type {
  AiBindingResolver,
  BindingResolutionRequest,
} from "@caseweaver/ai-config";
import {
  createImmutableBinding,
  decimal,
  InMemoryAiBindingResolver,
  type PriceComponent,
  type PriceComponentKind,
  type PriceConditions,
} from "@caseweaver/ai-config";
import {
  type AiCapability,
  AiConfigurationError,
  type AiRole,
  type AiWireApi,
} from "@caseweaver/ai-sdk";
import type { PrismaClient } from "@prisma/client";

const roles = [
  "embedding",
  "vision",
  "analysis",
  "repositoryAgent",
  "keywordExtraction",
  "reranker",
  "chat",
] as const satisfies readonly AiRole[];

const capabilities = [
  "vision",
  "structuredOutput",
  "tools",
  "promptCaching",
  "reranking",
  "repositoryAgent",
] as const satisfies readonly AiCapability[];

const wireApis = [
  "embeddings",
  "chatCompletions",
  "responses",
  "custom",
] as const satisfies readonly AiWireApi[];

const priceKinds = [
  "input",
  "output",
  "cacheRead",
  "cacheCreation",
  "image",
  "audio",
] as const satisfies readonly PriceComponentKind[];

const priceUnits = ["token", "image", "audio"] as const;

interface BindingRow {
  readonly binding_id: string;
  readonly binding_version_id: string;
  readonly binding_version: number;
  readonly binding_role: string;
  readonly provider_instance_version_id: string;
  readonly provider_type: string;
  readonly endpoint: string;
  readonly wire_api: string;
  readonly parameters: unknown;
  readonly secret_reference: string;
  readonly binding_capabilities: unknown;
  readonly binding_maximum_input_tokens: number | null;
  readonly binding_maximum_output_tokens: number | null;
  readonly catalog_snapshot_id: string;
  readonly canonical_model: string;
  readonly catalog_provider: string;
  readonly supported_roles: unknown;
  readonly catalog_capabilities: unknown;
  readonly catalog_maximum_input_tokens: number | null;
  readonly catalog_maximum_output_tokens: number | null;
  readonly raw_entry: unknown;
  readonly catalog_model_id: string;
}

interface CatalogPriceRow {
  readonly id: string;
  readonly component_kind: string;
  readonly billing_unit: string;
  readonly amount: string;
  readonly currency: string;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  readonly conditions: unknown;
  readonly source_revision: string;
}

interface OverridePriceRow {
  readonly id: string;
  readonly component_kind: string;
  readonly billing_unit: string;
  readonly amount: string;
  readonly currency: string;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  readonly conditions: unknown;
  readonly override_id: string;
  readonly source: string;
}

/**
 * Resolves a workspace-owned, immutable AI binding for metered execution.
 *
 * This adapter deliberately returns the opaque secret reference only after the
 * exact provider, binding, catalog, and credential registration have all been
 * proven active in the same database read. It never resolves, logs, or returns
 * a credential value.
 */
export class PostgresAiBindingResolver implements AiBindingResolver {
  public constructor(private readonly client: PrismaClient) {}

  public async resolve(
    request: BindingResolutionRequest,
  ): Promise<ReturnType<typeof createImmutableBinding>> {
    const rows = await this.client.$queryRaw<readonly BindingRow[]>`
      SELECT
        binding.id AS binding_id,
        binding_version.id AS binding_version_id,
        binding_version.version AS binding_version,
        binding.role AS binding_role,
        provider_version.id AS provider_instance_version_id,
        provider.provider_type AS provider_type,
        provider_version.endpoint,
        binding_version.wire_api,
        binding_version.parameters,
        binding_version.secret_reference,
        binding_version.capabilities AS binding_capabilities,
        binding_version.maximum_input_tokens AS binding_maximum_input_tokens,
        binding_version.maximum_output_tokens AS binding_maximum_output_tokens,
        catalog_model.catalog_snapshot_id,
        catalog_model.canonical_model,
        catalog_model.provider AS catalog_provider,
        catalog_model.supported_roles,
        catalog_model.capabilities AS catalog_capabilities,
        catalog_model.maximum_input_tokens AS catalog_maximum_input_tokens,
        catalog_model.maximum_output_tokens AS catalog_maximum_output_tokens,
        catalog_model.raw_entry,
        catalog_model.id AS catalog_model_id
      FROM ai_model_binding_versions AS binding_version
      JOIN ai_model_bindings AS binding
        ON binding.workspace_id = binding_version.workspace_id
       AND binding.id = binding_version.model_binding_id
      JOIN ai_provider_instance_versions AS provider_version
        ON provider_version.workspace_id = binding_version.workspace_id
       AND provider_version.id = binding_version.provider_instance_version_id
      JOIN ai_provider_instances AS provider
        ON provider.workspace_id = provider_version.workspace_id
       AND provider.id = provider_version.provider_instance_id
      JOIN ai_catalog_models AS catalog_model
        ON catalog_model.id = binding_version.catalog_model_id
       AND catalog_model.catalog_snapshot_id = binding_version.catalog_snapshot_id
       AND catalog_model.canonical_model = binding_version.canonical_model
      JOIN credential_registrations AS credential
        ON credential.workspace_id = binding_version.workspace_id
       AND credential.secret_reference = binding_version.secret_reference
      LEFT JOIN ai_workspace_binding_defaults AS default_binding
        ON default_binding.workspace_id = binding_version.workspace_id
       AND default_binding.role = binding.role
       AND default_binding.model_binding_version_id = binding_version.id
      WHERE binding_version.workspace_id = ${request.workspaceId}
        AND (
          (${request.bindingVersionId ?? null}::text IS NOT NULL
            AND binding_version.id = ${request.bindingVersionId ?? null})
          OR (
            ${request.bindingVersionId ?? null}::text IS NULL
            AND binding.role = ${request.role}
            AND default_binding.model_binding_version_id IS NOT NULL
          )
        )
        AND binding.lifecycle = 'active'
        -- A caller that supplied an immutable version pin is deliberately
        -- replaying work created under that version.  Rotation changes the
        -- default for new work only; it must never silently rebind retained
        -- work to the aggregate's current version.  Aggregate/provider/
        -- credential lifecycle still gates all execution.
        AND (
          ${request.bindingVersionId ?? null}::text IS NOT NULL
          OR binding.active_version_id = binding_version.id
        )
        AND provider.lifecycle = 'active'
        AND credential.lifecycle = 'active'
        AND binding_version.secret_reference = provider_version.secret_reference
        AND catalog_model.provider = provider.provider_type
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new AiConfigurationError("The requested binding is not available.");
    }

    const binding = createImmutableBinding({
      workspaceId: request.workspaceId,
      bindingId: requiredString(row.binding_id),
      version: positiveInteger(row.binding_version),
      role: enumValue(row.binding_role, roles),
      providerInstanceVersionId: requiredString(
        row.provider_instance_version_id,
      ),
      providerType: requiredString(row.provider_type),
      endpoint: requiredString(row.endpoint),
      canonicalModel: requiredString(row.canonical_model),
      wireApi: enumValue(row.wire_api, wireApis),
      parameters: jsonRecord(row.parameters),
      secretReference: requiredString(row.secret_reference),
      catalogModel: {
        id: requiredString(row.catalog_model_id),
        snapshotId: requiredString(row.catalog_snapshot_id),
        canonicalModel: requiredString(row.canonical_model),
        provider: requiredString(row.catalog_provider),
        supportedRoles: enumSet(row.supported_roles, roles),
        capabilities: enumSet(row.catalog_capabilities, capabilities),
        maximumInputTokens: optionalPositiveInteger(
          row.catalog_maximum_input_tokens,
        ),
        maximumOutputTokens: optionalPositiveInteger(
          row.catalog_maximum_output_tokens,
        ),
        priceComponents: await this.catalogPriceComponents(row),
        rawEntry: jsonRecord(row.raw_entry),
      },
      requiredCapabilities: enumValues(row.binding_capabilities, capabilities),
      maximumInputTokens: optionalPositiveInteger(
        row.binding_maximum_input_tokens,
      ),
      maximumOutputTokens: optionalPositiveInteger(
        row.binding_maximum_output_tokens,
      ),
      pricing: await this.pricing(row, request.workspaceId),
    });

    // Reuse the canonical in-memory resolver for request-specific role,
    // capability, and token-bound checks after this adapter has loaded the
    // persisted immutable configuration.
    return new InMemoryAiBindingResolver({
      bindings: [binding],
    }).resolve({
      ...request,
      bindingVersionId: binding.bindingVersionId,
    });
  }

  private async catalogPriceComponents(
    binding: BindingRow,
  ): Promise<readonly PriceComponent[]> {
    const rows = await this.client.$queryRaw<readonly CatalogPriceRow[]>`
      SELECT
        id, component_kind, billing_unit, amount::text AS amount, currency,
        effective_from, effective_to, conditions, source_revision
      FROM ai_catalog_price_components
      WHERE catalog_model_id = ${binding.catalog_model_id}
      ORDER BY id
    `;
    return Object.freeze(
      rows.map((row) =>
        catalogComponent(
          row,
          `${binding.catalog_model_id}:${row.source_revision}`,
        ),
      ),
    );
  }

  private async pricing(
    binding: BindingRow,
    workspaceId: string,
  ): Promise<{
    readonly installationOverrides: readonly PriceComponent[];
    readonly workspaceOverrides: readonly PriceComponent[];
    readonly bindingOverrides: readonly PriceComponent[];
  }> {
    const [installation, workspace, bindingOverrides] = await Promise.all([
      this.client.$queryRaw<readonly OverridePriceRow[]>`
        SELECT
          component.id, component.component_kind, component.billing_unit,
          component.amount::text AS amount, component.currency,
          override.effective_from, override.effective_to, component.conditions,
          override.id AS override_id, override.source
        FROM ai_installation_price_overrides AS override
        JOIN ai_price_override_components AS component
          ON component.installation_price_override_id = override.id
        WHERE override.provider = ${binding.catalog_provider}
          AND override.canonical_model = ${binding.canonical_model}
        ORDER BY component.id
      `,
      this.client.$queryRaw<readonly OverridePriceRow[]>`
        SELECT
          component.id, component.component_kind, component.billing_unit,
          component.amount::text AS amount, component.currency,
          override.effective_from, override.effective_to, component.conditions,
          override.id AS override_id, override.source
        FROM ai_workspace_price_overrides AS override
        JOIN ai_price_override_components AS component
          ON component.workspace_id = override.workspace_id
         AND component.workspace_price_override_id = override.id
        WHERE override.workspace_id = ${workspaceId}
          AND override.provider = ${binding.catalog_provider}
          AND override.canonical_model = ${binding.canonical_model}
        ORDER BY component.id
      `,
      this.client.$queryRaw<readonly OverridePriceRow[]>`
        SELECT
          component.id, component.component_kind, component.billing_unit,
          component.amount::text AS amount, component.currency,
          override.effective_from, override.effective_to, component.conditions,
          override.id AS override_id, override.source
        FROM ai_binding_price_overrides AS override
        JOIN ai_price_override_components AS component
          ON component.workspace_id = override.workspace_id
         AND component.binding_price_override_id = override.id
        WHERE override.workspace_id = ${workspaceId}
          AND override.model_binding_version_id = ${binding.binding_version_id}
        ORDER BY component.id
      `,
    ]);
    return Object.freeze({
      installationOverrides: Object.freeze(
        installation.map((row) => overrideComponent(row, "installation")),
      ),
      workspaceOverrides: Object.freeze(
        workspace.map((row) => overrideComponent(row, "workspace")),
      ),
      bindingOverrides: Object.freeze(
        bindingOverrides.map((row) => overrideComponent(row, "binding")),
      ),
    });
  }
}

function catalogComponent(
  row: CatalogPriceRow,
  sourceId: string,
): PriceComponent {
  return priceComponent({
    id: row.id,
    kind: row.component_kind,
    unit: row.billing_unit,
    amount: row.amount,
    currency: row.currency,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    conditions: row.conditions,
    sourceId,
  });
}

function overrideComponent(
  row: OverridePriceRow,
  scope: "installation" | "workspace" | "binding",
): PriceComponent {
  return priceComponent({
    id: row.id,
    kind: row.component_kind,
    unit: row.billing_unit,
    amount: row.amount,
    currency: row.currency,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    conditions: row.conditions,
    sourceId: `${scope}:${requiredString(row.override_id)}:${requiredString(row.source)}`,
  });
}

function priceComponent(input: {
  readonly id: string;
  readonly kind: string;
  readonly unit: string;
  readonly amount: string;
  readonly currency: string;
  readonly effectiveFrom: Date;
  readonly effectiveTo: Date | null;
  readonly conditions: unknown;
  readonly sourceId: string;
}): PriceComponent {
  const kind = enumValue(input.kind, priceKinds);
  const unit = enumValue(input.unit, priceUnits);
  if (
    (kind === "image" && unit !== "image") ||
    (kind === "audio" && unit !== "audio") ||
    (kind !== "image" && kind !== "audio" && unit !== "token")
  ) {
    throw new AiConfigurationError("Persisted AI price component is invalid.");
  }
  const amount = requiredString(input.amount);
  if (!/^\d+(?:\.\d+)?$/u.test(amount)) {
    throw new AiConfigurationError("Persisted AI price component is invalid.");
  }
  const currency = requiredString(input.currency);
  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw new AiConfigurationError("Persisted AI price component is invalid.");
  }
  return Object.freeze({
    id: requiredString(input.id),
    kind,
    unit,
    amount: decimal(amount),
    currency,
    effectiveFrom: iso(input.effectiveFrom),
    ...(input.effectiveTo === null
      ? {}
      : { effectiveTo: iso(input.effectiveTo) }),
    sourceId: requiredString(input.sourceId),
    conditions: priceConditions(input.conditions),
  });
}

function enumValue<Value extends string>(
  value: string,
  allowed: readonly Value[],
): Value {
  if (!allowed.includes(value as Value)) {
    throw new AiConfigurationError("Persisted AI configuration is invalid.");
  }
  return value as Value;
}

function enumValues<Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): readonly Value[] {
  return Object.freeze([...enumSet(value, allowed)]);
}

function enumSet<Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): ReadonlySet<Value> {
  if (!Array.isArray(value)) {
    throw new AiConfigurationError("Persisted AI configuration is invalid.");
  }
  return new Set(
    value.map((item) => {
      if (typeof item !== "string") {
        throw new AiConfigurationError(
          "Persisted AI configuration is invalid.",
        );
      }
      return enumValue(item, allowed);
    }),
  );
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AiConfigurationError("Persisted AI configuration is invalid.");
  }
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new AiConfigurationError("Persisted AI configuration is invalid.");
  }
  return value as number;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  return positiveInteger(value);
}

function jsonRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AiConfigurationError("Persisted AI configuration is invalid.");
  }
  return Object.freeze({ ...(value as Readonly<Record<string, unknown>>) });
}

function priceConditions(value: unknown): PriceConditions {
  const record = jsonRecord(value);
  for (const condition of Object.values(record)) {
    if (
      typeof condition !== "string" &&
      typeof condition !== "boolean" &&
      (typeof condition !== "number" || !Number.isFinite(condition))
    ) {
      throw new AiConfigurationError(
        "Persisted AI price component is invalid.",
      );
    }
  }
  return record as PriceConditions;
}

function iso(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new AiConfigurationError("Persisted AI configuration is invalid.");
  }
  return value.toISOString();
}
