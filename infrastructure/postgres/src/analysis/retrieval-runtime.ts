import type { AnalysisExecution } from "@caseweaver/analysis";
import type {
  AiBudgetPolicy,
  RetrievalAccessScope,
  RetrievalCollection,
  RetrievalFilterValue,
  RetrievalProfile,
} from "@caseweaver/retrieval";
import type { Prisma, PrismaClient } from "@prisma/client";

import {
  PostgresAnalysisEvidenceAdapterError,
  type AnalysisRetrievalRuntime,
  type AnalysisRetrievalRuntimeResolver,
} from "./evidence-adapters.js";

type JsonObject = Readonly<Record<string, Prisma.JsonValue>>;

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const allowedSettingsKeys = new Set([
  "collections",
  "policy",
  "queryEmbedding",
  "contextTokenBindingVersionId",
  "reranker",
  "authorizedSourceIds",
  "metadataFilters",
]);

function unavailable(): never {
  throw new PostgresAnalysisEvidenceAdapterError(
    "analysis.retrievalRuntimeUnavailable",
    "The immutable retrieval runtime is not available.",
    false,
  );
}

function mismatch(): never {
  throw new PostgresAnalysisEvidenceAdapterError(
    "analysis.retrievalRuntimeMismatch",
    "The resolved retrieval runtime does not match the immutable analysis profile.",
    false,
  );
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new PostgresAnalysisEvidenceAdapterError(
      "analysis.cancelled",
      "Analysis evidence resolution was cancelled.",
      false,
    );
  }
}

function object(value: Prisma.JsonValue | undefined): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    unavailable();
  }
  return value as JsonObject;
}

function array(
  value: Prisma.JsonValue | undefined,
): readonly Prisma.JsonValue[] {
  if (!Array.isArray(value)) unavailable();
  return value;
}

function string(value: Prisma.JsonValue | undefined): string {
  if (typeof value !== "string") unavailable();
  return value;
}

function identifier(value: Prisma.JsonValue | undefined): string {
  const parsed = string(value);
  if (!identifierPattern.test(parsed)) unavailable();
  return parsed;
}

function positiveInteger(value: Prisma.JsonValue | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    unavailable();
  }
  return value;
}

function nonNegativeInteger(value: Prisma.JsonValue | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    unavailable();
  }
  return value;
}

function finiteNonNegative(value: Prisma.JsonValue | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    unavailable();
  }
  return value;
}

function boolean(value: Prisma.JsonValue | undefined): boolean {
  if (typeof value !== "boolean") unavailable();
  return value;
}

function exactKeys(value: JsonObject, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) unavailable();
}

function budget(value: Prisma.JsonValue | undefined): AiBudgetPolicy {
  const parsed = object(value);
  exactKeys(parsed, new Set(["currency", "hard", "allowUnknownPricing"]));
  const currency = string(parsed.currency);
  if (currency.length === 0 || currency.length > 16) unavailable();
  const hard = boolean(parsed.hard);
  const allowUnknownPricing =
    parsed.allowUnknownPricing === undefined
      ? undefined
      : boolean(parsed.allowUnknownPricing);
  return Object.freeze({
    currency,
    hard,
    ...(allowUnknownPricing === undefined ? {} : { allowUnknownPricing }),
  });
}

function collection(value: Prisma.JsonValue): RetrievalCollection {
  const parsed = object(value);
  exactKeys(
    parsed,
    new Set([
      "id",
      "embeddingBindingVersionId",
      "embeddingProfileVersion",
      "dimensions",
    ]),
  );
  return Object.freeze({
    id: identifier(parsed.id),
    embeddingBindingVersionId: identifier(parsed.embeddingBindingVersionId),
    embeddingProfileVersion: identifier(parsed.embeddingProfileVersion),
    dimensions: positiveInteger(parsed.dimensions),
  });
}

function sourceQuota(value: Prisma.JsonValue | undefined): {
  readonly sourceId?: string;
  readonly maximumCandidates: number;
  readonly maximumFinalResults: number;
} {
  const parsed = object(value);
  exactKeys(
    parsed,
    new Set(["sourceId", "maximumCandidates", "maximumFinalResults"]),
  );
  const sourceId =
    parsed.sourceId === undefined ? undefined : identifier(parsed.sourceId);
  return Object.freeze({
    ...(sourceId === undefined ? {} : { sourceId }),
    maximumCandidates: positiveInteger(parsed.maximumCandidates),
    maximumFinalResults: positiveInteger(parsed.maximumFinalResults),
  });
}

function metadataFilters(
  value: Prisma.JsonValue | undefined,
): Readonly<Record<string, readonly RetrievalFilterValue[]>> | undefined {
  if (value === undefined) return undefined;
  const parsed = object(value);
  const output: Record<string, readonly RetrievalFilterValue[]> = {};
  for (const [key, candidate] of Object.entries(parsed)) {
    if (!identifierPattern.test(key)) unavailable();
    const values = array(candidate);
    if (
      values.length === 0 ||
      values.length > 100 ||
      !values.every(
        (item): item is RetrievalFilterValue =>
          item === null ||
          typeof item === "string" ||
          typeof item === "number" ||
          typeof item === "boolean",
      )
    ) {
      unavailable();
    }
    output[key] = Object.freeze([...values]);
  }
  return Object.freeze(output);
}

function parseRuntime(input: {
  readonly settings: Prisma.JsonValue;
  readonly profileId: string;
  readonly profileVersion: string;
}): AnalysisRetrievalRuntime {
  const settings = object(input.settings);
  exactKeys(settings, allowedSettingsKeys);

  const collections = array(settings.collections).map(collection);
  if (
    collections.length === 0 ||
    collections.length > 100 ||
    new Set(collections.map((entry) => entry.id)).size !== collections.length
  ) {
    unavailable();
  }

  const policy = object(settings.policy);
  exactKeys(
    policy,
    new Set([
      "rankConstant",
      "lexicalWeight",
      "vectorWeight",
      "maximumFinalResults",
      "maximumCharacters",
      "maximumTokens",
      "defaultSourceQuota",
      "sourceQuotas",
    ]),
  );
  const lexicalWeight = finiteNonNegative(policy.lexicalWeight);
  const vectorWeight = finiteNonNegative(policy.vectorWeight);
  if (lexicalWeight === 0 && vectorWeight === 0) unavailable();
  const defaultQuota = sourceQuota(policy.defaultSourceQuota);
  if (defaultQuota.sourceId !== undefined) unavailable();
  const sourceQuotas = array(policy.sourceQuotas).map(sourceQuota);
  if (
    sourceQuotas.some((quota) => quota.sourceId === undefined) ||
    new Set(sourceQuotas.map((quota) => quota.sourceId)).size !==
      sourceQuotas.length
  ) {
    unavailable();
  }

  const queryEmbedding = object(settings.queryEmbedding);
  exactKeys(queryEmbedding, new Set(["maximumInputTokens", "budget"]));
  const rerankerValue = settings.reranker;
  const reranker =
    rerankerValue === undefined
      ? undefined
      : (() => {
          const parsed = object(rerankerValue);
          exactKeys(
            parsed,
            new Set([
              "bindingVersionId",
              "maximumCandidates",
              "maximumInputTokens",
              "timeoutMs",
              "budget",
            ]),
          );
          const timeoutMs =
            parsed.timeoutMs === undefined
              ? undefined
              : positiveInteger(parsed.timeoutMs);
          return Object.freeze({
            bindingVersionId: identifier(parsed.bindingVersionId),
            maximumCandidates: positiveInteger(parsed.maximumCandidates),
            maximumInputTokens: positiveInteger(parsed.maximumInputTokens),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            budget: budget(parsed.budget),
          });
        })();

  const authorizedSourceIds = array(settings.authorizedSourceIds).map(
    identifier,
  );
  if (
    authorizedSourceIds.length > 1_000 ||
    new Set(authorizedSourceIds).size !== authorizedSourceIds.length
  ) {
    unavailable();
  }

  const profile: RetrievalProfile = Object.freeze({
    id: input.profileId,
    version: input.profileVersion,
    contextTokenBindingVersionId: identifier(
      settings.contextTokenBindingVersionId,
    ),
    collections: Object.freeze(collections),
    policy: Object.freeze({
      rankConstant: positiveInteger(policy.rankConstant),
      lexicalWeight,
      vectorWeight,
      maximumFinalResults: positiveInteger(policy.maximumFinalResults),
      maximumCharacters: nonNegativeInteger(policy.maximumCharacters),
      maximumTokens: nonNegativeInteger(policy.maximumTokens),
      defaultSourceQuota: Object.freeze({
        maximumCandidates: defaultQuota.maximumCandidates,
        maximumFinalResults: defaultQuota.maximumFinalResults,
      }),
      sourceQuotas: Object.freeze(
        sourceQuotas.map((quota) =>
          Object.freeze({
            sourceId: quota.sourceId ?? unavailable(),
            maximumCandidates: quota.maximumCandidates,
            maximumFinalResults: quota.maximumFinalResults,
          }),
        ),
      ),
    }),
    queryEmbedding: Object.freeze({
      maximumInputTokens: positiveInteger(queryEmbedding.maximumInputTokens),
      budget: budget(queryEmbedding.budget),
    }),
    ...(reranker === undefined ? {} : { reranker }),
  });
  const filters = metadataFilters(settings.metadataFilters);
  return Object.freeze({
    profile,
    access: Object.freeze({
      authorizedSourceIds: Object.freeze(authorizedSourceIds),
    }) satisfies RetrievalAccessScope,
    ...(filters === undefined ? {} : { metadataFilters: filters }),
  });
}

/**
 * Loads the exact immutable retrieval profile version pinned in an analysis
 * profile. It never follows AdministrationConfiguration.currentVersionId; a
 * later edit may change that pointer without changing queued analysis work.
 */
export class PostgresAnalysisRetrievalRuntimeResolver
  implements AnalysisRetrievalRuntimeResolver
{
  public constructor(private readonly client: PrismaClient) {}

  public async resolve(input: {
    readonly execution: AnalysisExecution;
    readonly profileId: string;
    readonly profileVersion: string;
    readonly collectionIds: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<AnalysisRetrievalRuntime> {
    assertActive(input.signal);
    try {
      const version =
        await this.client.administrationConfigurationVersion.findUnique({
          where: {
            workspaceId_id: {
              workspaceId: input.execution.workspaceId,
              id: input.profileVersion,
            },
          },
          select: {
            id: true,
            configurationId: true,
            settings: true,
            secretReferences: true,
            configuration: {
              select: { resourceType: true, lifecycle: true },
            },
          },
        });
      assertActive(input.signal);
      if (
        version === null ||
        version.id !== input.profileVersion ||
        version.configurationId !== input.profileId ||
        version.configuration.resourceType !== "retrieval-profiles" ||
        version.configuration.lifecycle !== "active" ||
        !Array.isArray(version.secretReferences) ||
        version.secretReferences.length !== 0
      ) {
        unavailable();
      }
      const runtime = parseRuntime({
        settings: version.settings,
        profileId: input.profileId,
        profileVersion: input.profileVersion,
      });
      const resolvedCollectionIds = runtime.profile.collections
        .map((collection) => collection.id)
        .sort();
      const requestedCollectionIds = [...input.collectionIds].sort();
      if (
        requestedCollectionIds.length !== resolvedCollectionIds.length ||
        requestedCollectionIds.some(
          (collectionId, index) =>
            collectionId !== resolvedCollectionIds[index],
        )
      ) {
        mismatch();
      }
      return runtime;
    } catch (error) {
      if (error instanceof PostgresAnalysisEvidenceAdapterError) throw error;
      unavailable();
    }
  }
}
