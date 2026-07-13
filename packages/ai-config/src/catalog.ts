import { createHash } from "node:crypto";

import {
  type AiCapability,
  AiConfigurationError,
  type AiRole,
} from "@caseweaver/ai-sdk";
import { z } from "zod";
import type { CatalogModel } from "./bindings.js";
import { decimal } from "./decimal.js";
import type { PriceComponent, PriceComponentKind } from "./pricing.js";

const unknownRecordSchema = z.record(z.string(), z.unknown());

const priceFields: Readonly<Record<string, PriceComponentKind>> = {
  input_cost_per_token: "input",
  output_cost_per_token: "output",
  cache_read_input_token_cost: "cacheRead",
  cache_creation_input_token_cost: "cacheCreation",
};

export interface LiteLlmImportInput {
  readonly snapshotId: string;
  readonly rawBytes: Uint8Array;
  readonly upstreamUrl: string;
  readonly upstreamCommitSha: string;
  readonly fetchedAt: string;
  readonly verifiedSha256: string;
}

export interface ImportedCatalogSnapshot {
  readonly id: string;
  readonly upstreamUrl: string;
  readonly upstreamCommitSha: string;
  readonly fetchedAt: string;
  readonly sha256: string;
  readonly rawEntries: Readonly<Record<string, unknown>>;
  readonly models: readonly CatalogModel[];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new AiConfigurationError(
      `LiteLLM ${field} must be a positive integer.`,
    );
  }
  return value as number;
}

function rolesFor(
  entry: Readonly<Record<string, unknown>>,
): ReadonlySet<AiRole> {
  const roles = new Set<AiRole>();
  const mode = asString(entry.mode);
  if (mode === "embedding") {
    roles.add("embedding");
  } else if (mode === "rerank") {
    roles.add("reranker");
  } else {
    roles.add("analysis");
    roles.add("chat");
    roles.add("keywordExtraction");
  }
  if (entry.supports_vision === true) {
    roles.add("vision");
  }
  return roles;
}

function capabilitiesFor(
  entry: Readonly<Record<string, unknown>>,
): ReadonlySet<AiCapability> {
  const capabilities = new Set<AiCapability>();
  if (entry.supports_vision === true) capabilities.add("vision");
  if (entry.supports_prompt_caching === true) capabilities.add("promptCaching");
  if (
    entry.supports_response_schema === true ||
    entry.supports_json_schema === true
  ) {
    capabilities.add("structuredOutput");
  }
  if (entry.supports_function_calling === true) capabilities.add("tools");
  if (entry.supports_reranking === true) capabilities.add("reranking");
  return capabilities;
}

function parseCurrency(entry: Readonly<Record<string, unknown>>): string {
  const currency =
    asString(entry.cost_currency) ?? asString(entry.currency) ?? "USD";
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new AiConfigurationError(
      "LiteLLM price currency must be an ISO code.",
    );
  }
  return currency;
}

function componentsFor(
  entry: Readonly<Record<string, unknown>>,
  sourceId: string,
): readonly PriceComponent[] {
  const currency = parseCurrency(entry);
  const components: PriceComponent[] = [];
  for (const [field, kind] of Object.entries(priceFields)) {
    const raw = entry[field];
    if (raw === undefined) continue;
    if (typeof raw !== "number" && typeof raw !== "string") {
      throw new AiConfigurationError(
        `LiteLLM ${field} must be a finite decimal price.`,
      );
    }
    const amount = decimal(raw);
    if (amount.startsWith("-")) {
      throw new AiConfigurationError(`LiteLLM ${field} cannot be negative.`);
    }
    components.push(
      Object.freeze({
        id: `${sourceId}:${kind}`,
        kind,
        unit: "token",
        amount,
        currency,
        effectiveFrom: "1970-01-01T00:00:00.000Z",
        sourceId,
        conditions: Object.freeze({}),
      }),
    );
  }
  return Object.freeze(components);
}

export function importLiteLlmCatalog(
  input: LiteLlmImportInput,
): ImportedCatalogSnapshot {
  if (!/^https:\/\//.test(input.upstreamUrl)) {
    throw new AiConfigurationError("LiteLLM upstream URL must be HTTPS.");
  }
  if (!/^[a-f0-9]{7,64}$/i.test(input.upstreamCommitSha)) {
    throw new AiConfigurationError("LiteLLM source commit SHA is invalid.");
  }
  const actualHash = createHash("sha256").update(input.rawBytes).digest("hex");
  if (actualHash !== input.verifiedSha256.toLowerCase()) {
    throw new AiConfigurationError(
      "LiteLLM content SHA-256 verification failed.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(input.rawBytes));
  } catch (cause) {
    throw new AiConfigurationError("LiteLLM catalog is not valid JSON.", {
      cause: cause instanceof Error ? cause.name : "unknown",
    });
  }
  const root = unknownRecordSchema.safeParse(parsed);
  if (!root.success) {
    throw new AiConfigurationError("LiteLLM catalog root must be an object.");
  }
  const models: CatalogModel[] = [];
  for (const [canonicalModel, raw] of Object.entries(root.data)) {
    if (canonicalModel === "sample_spec") continue;
    const entry = unknownRecordSchema.safeParse(raw);
    if (!entry.success) continue;
    const provider = asString(entry.data.litellm_provider);
    if (provider === undefined) continue;
    const sourceId = `${input.snapshotId}:${canonicalModel}`;
    models.push(
      Object.freeze({
        id: sourceId,
        snapshotId: input.snapshotId,
        canonicalModel,
        provider,
        supportedRoles: rolesFor(entry.data),
        capabilities: capabilitiesFor(entry.data),
        maximumInputTokens: asPositiveInteger(
          entry.data.max_input_tokens,
          "max_input_tokens",
        ),
        maximumOutputTokens: asPositiveInteger(
          entry.data.max_output_tokens,
          "max_output_tokens",
        ),
        priceComponents: componentsFor(entry.data, sourceId),
        rawEntry: Object.freeze({ ...entry.data }),
      }),
    );
  }
  return Object.freeze({
    id: input.snapshotId,
    upstreamUrl: input.upstreamUrl,
    upstreamCommitSha: input.upstreamCommitSha,
    fetchedAt: input.fetchedAt,
    sha256: actualHash,
    rawEntries: Object.freeze({ ...root.data }),
    models: Object.freeze(models),
  });
}
