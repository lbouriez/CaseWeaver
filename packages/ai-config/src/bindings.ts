import {
  type AiCapability,
  AiCapabilityError,
  AiConfigurationError,
  type AiProviderBinding,
  type AiRole,
} from "@caseweaver/ai-sdk";

import type { PriceComponent } from "./pricing.js";

export interface CatalogModel {
  readonly id: string;
  readonly snapshotId: string;
  readonly canonicalModel: string;
  readonly provider: string;
  readonly supportedRoles: ReadonlySet<AiRole>;
  readonly capabilities: ReadonlySet<AiCapability>;
  readonly maximumInputTokens?: number;
  readonly maximumOutputTokens?: number;
  readonly priceComponents: readonly PriceComponent[];
  readonly rawEntry: Readonly<Record<string, unknown>>;
}

export interface BindingPricing {
  readonly catalogComponents: readonly PriceComponent[];
  readonly installationOverrides: readonly PriceComponent[];
  readonly workspaceOverrides: readonly PriceComponent[];
  readonly bindingOverrides: readonly PriceComponent[];
}

export interface ImmutableAiBinding extends AiProviderBinding {
  readonly workspaceId: string;
  readonly bindingId: string;
  readonly version: number;
  readonly role: AiRole;
  readonly catalogSnapshotId: string;
  readonly maximumInputTokens?: number;
  readonly maximumOutputTokens?: number;
  readonly pricing: BindingPricing;
}

export interface CreateBindingInput {
  readonly workspaceId: string;
  readonly bindingId: string;
  readonly version: number;
  readonly role: AiRole;
  readonly providerInstanceVersionId: string;
  readonly providerType: string;
  readonly endpoint: string;
  readonly canonicalModel: string;
  readonly wireApi: AiProviderBinding["wireApi"];
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly secretReference: string;
  readonly catalogModel: CatalogModel;
  readonly requiredCapabilities?: readonly AiCapability[];
  readonly maximumInputTokens?: number;
  readonly maximumOutputTokens?: number;
  readonly pricing?: Partial<BindingPricing>;
}

function positiveLimit(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new AiConfigurationError(`${name} must be a positive integer.`);
  }
}

function freezeRecord(
  record: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  return deepFreeze({ ...(record ?? {}) });
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function immutableSet<Value>(values: Iterable<Value>): ReadonlySet<Value> {
  const set = new Set(values);
  const readonlySet: ReadonlySet<Value> = {
    get size() {
      return set.size;
    },
    has: (value) => set.has(value),
    entries: () => set.entries(),
    keys: () => set.keys(),
    values: () => set.values(),
    forEach: (callback, thisArg) => {
      set.forEach((value) => {
        callback.call(thisArg, value, value, readonlySet);
      });
    },
    [Symbol.iterator]: () => set[Symbol.iterator](),
  };
  return Object.freeze(readonlySet);
}

function freezePricing(
  pricing: Partial<BindingPricing> | undefined,
): BindingPricing {
  return Object.freeze({
    catalogComponents: Object.freeze([...(pricing?.catalogComponents ?? [])]),
    installationOverrides: Object.freeze([
      ...(pricing?.installationOverrides ?? []),
    ]),
    workspaceOverrides: Object.freeze([...(pricing?.workspaceOverrides ?? [])]),
    bindingOverrides: Object.freeze([...(pricing?.bindingOverrides ?? [])]),
  });
}

export function createImmutableBinding(
  input: CreateBindingInput,
): ImmutableAiBinding {
  if (
    input.workspaceId.length === 0 ||
    input.bindingId.length === 0 ||
    input.providerInstanceVersionId.length === 0 ||
    input.endpoint.length === 0 ||
    input.secretReference.length === 0
  ) {
    throw new AiConfigurationError("Binding identity fields are required.");
  }
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new AiConfigurationError(
      "Binding version must be a positive integer.",
    );
  }
  positiveLimit(input.maximumInputTokens, "Maximum input tokens");
  positiveLimit(input.maximumOutputTokens, "Maximum output tokens");
  if (!input.catalogModel.supportedRoles.has(input.role)) {
    throw new AiCapabilityError(
      "Catalog model does not support the binding role.",
      {
        role: input.role,
      },
    );
  }
  const required = input.requiredCapabilities ?? [];
  for (const capability of required) {
    if (!input.catalogModel.capabilities.has(capability)) {
      throw new AiCapabilityError(
        "Catalog model does not support a required binding capability.",
        { capability },
      );
    }
  }
  if (
    input.maximumInputTokens !== undefined &&
    input.catalogModel.maximumInputTokens !== undefined &&
    input.maximumInputTokens > input.catalogModel.maximumInputTokens
  ) {
    throw new AiCapabilityError(
      "Binding input limit exceeds the catalog model limit.",
    );
  }
  if (
    input.maximumOutputTokens !== undefined &&
    input.catalogModel.maximumOutputTokens !== undefined &&
    input.maximumOutputTokens > input.catalogModel.maximumOutputTokens
  ) {
    throw new AiCapabilityError(
      "Binding output limit exceeds the catalog model limit.",
    );
  }
  return Object.freeze({
    workspaceId: input.workspaceId,
    bindingId: input.bindingId,
    bindingVersionId: `${input.bindingId}:${input.version}`,
    version: input.version,
    role: input.role,
    providerInstanceVersionId: input.providerInstanceVersionId,
    providerType: input.providerType,
    endpoint: input.endpoint,
    canonicalModel: input.canonicalModel,
    wireApi: input.wireApi,
    parameters: freezeRecord(input.parameters),
    capabilities: immutableSet(input.catalogModel.capabilities),
    secretReference: input.secretReference,
    catalogSnapshotId: input.catalogModel.snapshotId,
    maximumInputTokens: input.maximumInputTokens,
    maximumOutputTokens: input.maximumOutputTokens,
    pricing: freezePricing({
      catalogComponents: input.catalogModel.priceComponents,
      ...input.pricing,
    }),
  });
}

export interface BindingResolutionRequest {
  readonly workspaceId: string;
  readonly role: AiRole;
  readonly bindingVersionId?: string;
  readonly requiredCapabilities?: readonly AiCapability[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface AiBindingResolver {
  resolve(request: BindingResolutionRequest): Promise<ImmutableAiBinding>;
}

export class InMemoryAiBindingResolver implements AiBindingResolver {
  private readonly bindings = new Map<string, ImmutableAiBinding>();
  private readonly defaults = new Map<string, string>();

  public constructor(input: {
    readonly bindings: readonly ImmutableAiBinding[];
    readonly defaults?: readonly {
      readonly workspaceId: string;
      readonly role: AiRole;
      readonly bindingVersionId: string;
    }[];
  }) {
    for (const binding of input.bindings) {
      this.bindings.set(binding.bindingVersionId, binding);
    }
    for (const defaultBinding of input.defaults ?? []) {
      this.defaults.set(
        `${defaultBinding.workspaceId}:${defaultBinding.role}`,
        defaultBinding.bindingVersionId,
      );
    }
  }

  public async resolve(
    request: BindingResolutionRequest,
  ): Promise<ImmutableAiBinding> {
    const id =
      request.bindingVersionId ??
      this.defaults.get(`${request.workspaceId}:${request.role}`);
    if (id === undefined) {
      throw new AiConfigurationError(
        "No default binding is configured for this role.",
        {
          role: request.role,
        },
      );
    }
    const binding = this.bindings.get(id);
    if (binding === undefined || binding.workspaceId !== request.workspaceId) {
      throw new AiConfigurationError("The requested binding is not available.");
    }
    if (binding.role !== request.role) {
      throw new AiCapabilityError(
        "The requested binding has a different role.",
        {
          role: request.role,
        },
      );
    }
    for (const capability of request.requiredCapabilities ?? []) {
      if (!binding.capabilities.has(capability)) {
        throw new AiCapabilityError(
          "The binding lacks a required capability.",
          {
            capability,
          },
        );
      }
    }
    if (
      request.inputTokens !== undefined &&
      binding.maximumInputTokens !== undefined &&
      request.inputTokens > binding.maximumInputTokens
    ) {
      throw new AiCapabilityError(
        "The request exceeds the binding input limit.",
      );
    }
    if (
      request.outputTokens !== undefined &&
      binding.maximumOutputTokens !== undefined &&
      request.outputTokens > binding.maximumOutputTokens
    ) {
      throw new AiCapabilityError(
        "The request exceeds the binding output limit.",
      );
    }
    return binding;
  }
}
