import type { Prisma, PrismaClient } from "@prisma/client";

type JsonObject = Readonly<Record<string, Prisma.JsonValue>>;

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu;
const publicCheckoutReference = "caseweaver-public-checkout";

/**
 * External secret locators are opaque strings owned by the configured secret
 * backend. They are deliberately not constrained to our public identifier
 * syntax (for example, a vault URI is valid), but control characters and
 * unbounded values are never accepted into the worker configuration.
 */
function opaqueSecretLocator(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    !/[\r\n\0]/u.test(value)
  );
}

export type RepositoryAnalysisCheckoutReference =
  | Readonly<{ readonly kind: "branch" | "tag"; readonly name: string }>
  | Readonly<{ readonly kind: "commit"; readonly sha: string }>;

export type RepositoryAnalysisRuntimeLocation =
  | Readonly<{
      readonly mode: "remoteHttps";
      readonly remoteUrl: string;
      readonly checkoutSecretReference?: string;
    }>
  | Readonly<{ readonly mode: "deploymentMounted"; readonly mountAlias: string }>;

/**
 * The private resolver output is intentionally usable only by worker runtime
 * composition. It is never a DTO, audit record, diagnostic payload, or
 * provider-visible runtime value.
 */
export interface ResolvedRepositoryAnalysisRuntimeConfiguration {
  readonly runtimeVersionId: string;
  readonly repository: Readonly<{
    readonly repositoryId: string;
    readonly repositoryVersionId: string;
    readonly checkoutSecretReference: string;
    readonly pinnedCommit: string;
  }>;
  readonly executionPolicy: Readonly<{
    readonly executionPolicyId: string;
    readonly executionPolicyVersionId: string;
    readonly repositoryAgentBindingVersionId: string;
    readonly allowedTools: readonly ("listFiles" | "readFile" | "searchFiles")[];
    readonly sandbox: Readonly<{
      readonly timeoutMs: number;
      readonly maximumCpuMilliseconds: number;
      readonly maximumMemoryBytes: number;
      readonly maximumOutputBytes: number;
      readonly maximumToolCalls: number;
    }>;
    readonly agent: Readonly<{
      readonly maximumTurns: number;
      readonly maximumInputTokensPerTurn: number;
      readonly maximumOutputTokensPerTurn: number;
      readonly maximumInstructionCharacters: number;
      readonly budget: Readonly<{ readonly currency: string; readonly hard: true }>;
    }>;
  }>;
  readonly location: RepositoryAnalysisRuntimeLocation;
  readonly checkoutRef: RepositoryAnalysisCheckoutReference;
}

/** Source-free execution projection consumed by the analysis/provider bridge. */
export interface RepositoryAnalysisRuntimeExecutionConfiguration {
  readonly runtimeVersionId: string;
  readonly repositoryId: string;
  readonly pinnedCommit: string;
  readonly repositoryAgentBindingVersionId: string;
  readonly allowedTools: readonly ("listFiles" | "readFile" | "searchFiles")[];
  readonly sandbox: ResolvedRepositoryAnalysisRuntimeConfiguration["executionPolicy"]["sandbox"];
  readonly agent: ResolvedRepositoryAnalysisRuntimeConfiguration["executionPolicy"]["agent"];
}

/**
 * A redacted distinction allows composition to fall back to the legacy PBI-010
 * resolver only when a pin is genuinely not a PBI-020 recipe pin. A malformed
 * or unavailable PBI-020 pin never falls back to mutable/default material.
 */
export class RepositoryAnalysisRuntimeNotApplicableError extends Error {
  public constructor() {
    super("Repository analysis runtime is not applicable.");
    this.name = "RepositoryAnalysisRuntimeNotApplicableError";
  }
}

export class PostgresRepositoryAnalysisRuntimeConfigurationError extends Error {
  public readonly code = "analysis.repositoryRuntimeUnavailable";
  public readonly retryable = false;

  public constructor() {
    super("The immutable repository analysis runtime is unavailable.");
    this.name = "PostgresRepositoryAnalysisRuntimeConfigurationError";
  }
}

function unavailable(): never {
  throw new PostgresRepositoryAnalysisRuntimeConfigurationError();
}

function object(value: Prisma.JsonValue | undefined): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    unavailable();
  }
  return value as JsonObject;
}

function text(value: Prisma.JsonValue | undefined): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    unavailable();
  }
  return value;
}

function safeIdentifier(value: Prisma.JsonValue | undefined): string {
  const parsed = text(value);
  if (!identifier.test(parsed)) unavailable();
  return parsed;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    unavailable();
  }
  return value;
}

function stringArray(value: Prisma.JsonValue): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 3 ||
    value.some((entry) => typeof entry !== "string")
  ) {
    unavailable();
  }
  return Object.freeze([...value] as string[]);
}

function allowedTools(
  value: Prisma.JsonValue,
): readonly ("listFiles" | "readFile" | "searchFiles")[] {
  const result = stringArray(value);
  if (
    new Set(result).size !== result.length ||
    result.some(
      (tool) =>
        tool !== "listFiles" && tool !== "readFile" && tool !== "searchFiles",
    )
  ) {
    unavailable();
  }
  return result as readonly ("listFiles" | "readFile" | "searchFiles")[];
}

function checkoutReference(
  value: Prisma.JsonValue | undefined,
): RepositoryAnalysisCheckoutReference {
  const record = object(value);
  if (
    (record.kind === "branch" || record.kind === "tag") &&
    typeof record.name === "string" &&
    record.name.length > 0 &&
    record.name.length <= 512 &&
    !/[\r\n\0]/u.test(record.name)
  ) {
    return Object.freeze({ kind: record.kind, name: record.name });
  }
  if (
    record.kind === "commit" &&
    typeof record.sha === "string" &&
    sha.test(record.sha)
  ) {
    return Object.freeze({ kind: "commit", sha: record.sha.toLowerCase() });
  }
  unavailable();
}

function remoteUrl(value: Prisma.JsonValue | undefined): string {
  const candidate = text(value);
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.username.length !== 0 ||
      url.password.length !== 0 ||
      url.search.length !== 0 ||
      url.hash.length !== 0
    ) {
      unavailable();
    }
    return url.toString();
  } catch (error) {
    if (error instanceof PostgresRepositoryAnalysisRuntimeConfigurationError) {
      throw error;
    }
    unavailable();
  }
}

function profileBudget(
  definition: Prisma.JsonValue,
): Readonly<{
  readonly maximumInputTokens: number;
  readonly maximumOutputTokens: number;
  readonly currency: string;
}> {
  const profile = object(definition);
  const generation = object(profile.generation);
  const budget = object(generation.budget);
  const currency = text(budget.currency);
  if (currency.length > 16 || budget.hard !== true) unavailable();
  return Object.freeze({
    maximumInputTokens: boundedInteger(
      generation.maximumInputTokens as number,
      1,
      1_000_000,
    ),
    maximumOutputTokens: boundedInteger(
      generation.maximumOutputTokens as number,
      1,
      1_000_000,
    ),
    currency,
  });
}

/**
 * Resolves one immutable analysis-recipe version to server-private checkout
 * material and a source-free execution projection. It never consults a
 * mutable current-version pointer and never returns a fallback configuration.
 */
export class PostgresRepositoryAnalysisRuntimeConfigurationResolver {
  public constructor(private readonly client: PrismaClient) {}

  public async resolve(input: {
    readonly workspaceId: string;
    readonly runtimeVersionId: string;
    readonly repositoryId: string;
    readonly pinnedCommit: string;
    readonly signal: AbortSignal;
  }): Promise<ResolvedRepositoryAnalysisRuntimeConfiguration> {
    if (input.signal.aborted) unavailable();
    if (
      !identifier.test(input.workspaceId) ||
      !identifier.test(input.runtimeVersionId) ||
      !identifier.test(input.repositoryId) ||
      !sha.test(input.pinnedCommit)
    ) {
      unavailable();
    }
    try {
      const recipe = await this.client.analysisRecipeVersion.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.runtimeVersionId,
          },
        },
        select: {
          id: true,
          analysisProfileVersionId: true,
          codeRepositoryVersionId: true,
          repositoryExecutionPolicyVersionId: true,
          repositoryStageMode: true,
        },
      });
      if (recipe === null) throw new RepositoryAnalysisRuntimeNotApplicableError();
      if (
        recipe.repositoryStageMode === "disabled" ||
        recipe.codeRepositoryVersionId === null ||
        recipe.repositoryExecutionPolicyVersionId === null
      ) {
        unavailable();
      }
      const [repositoryVersion, policyVersion, profile] = await Promise.all([
        this.client.administrationConfigurationVersion.findUnique({
          where: {
            workspaceId_id: {
              workspaceId: input.workspaceId,
              id: recipe.codeRepositoryVersionId,
            },
          },
          select: {
            id: true,
            settings: true,
            secretReferences: true,
            configuration: { select: { id: true, resourceType: true } },
          },
        }),
        this.client.repositoryExecutionPolicyVersion.findUnique({
          where: {
            workspaceId_id: {
              workspaceId: input.workspaceId,
              id: recipe.repositoryExecutionPolicyVersionId,
            },
          },
          select: {
            id: true,
            repositoryAgentBindingVersionId: true,
            readOnlyToolAllowlist: true,
            maximumDurationMilliseconds: true,
            maximumTurns: true,
            maximumToolCalls: true,
            maximumOutputTokens: true,
            maximumCpuMilliseconds: true,
            maximumMemoryBytes: true,
            maximumOutputBytes: true,
          },
        }),
        this.client.analysisProfileVersion.findUnique({
          where: {
            workspaceId_id: {
              workspaceId: input.workspaceId,
              id: recipe.analysisProfileVersionId,
            },
          },
          select: { definition: true },
        }),
      ]);
      if (
        repositoryVersion === null ||
        repositoryVersion.configuration.resourceType !== "code-repositories" ||
        repositoryVersion.configuration.id !== input.repositoryId ||
        policyVersion === null ||
        profile === null
      ) {
        unavailable();
      }
      const repositorySettings = object(repositoryVersion.settings);
      const repository = object(repositorySettings.repository);
      const checkoutRef = checkoutReference(repository.checkoutRef);
      const profileLimits = profileBudget(profile.definition);
      const checkout = await this.resolveCheckout({
        workspaceId: input.workspaceId,
        repository,
        secretReferenceIds: repositoryVersion.secretReferences,
      });
      if (input.signal.aborted) unavailable();
      return Object.freeze({
        runtimeVersionId: recipe.id,
        repository: Object.freeze({
          repositoryId: input.repositoryId,
          repositoryVersionId: repositoryVersion.id,
          checkoutSecretReference:
            checkout.mode === "remoteHttps"
              ? (checkout.checkoutSecretReference ?? publicCheckoutReference)
              : publicCheckoutReference,
          pinnedCommit: input.pinnedCommit.toLowerCase(),
        }),
        executionPolicy: Object.freeze({
          executionPolicyId: await this.configurationIdForVersion(
            input.workspaceId,
            policyVersion.id,
            "repository-execution-policies",
          ),
          executionPolicyVersionId: policyVersion.id,
          repositoryAgentBindingVersionId:
            policyVersion.repositoryAgentBindingVersionId,
          allowedTools: allowedTools(policyVersion.readOnlyToolAllowlist),
          sandbox: Object.freeze({
            timeoutMs: boundedInteger(
              policyVersion.maximumDurationMilliseconds,
              1_000,
              900_000,
            ),
            maximumCpuMilliseconds: boundedInteger(
              policyVersion.maximumCpuMilliseconds,
              100,
              900_000,
            ),
            maximumMemoryBytes: boundedInteger(
              Number(policyVersion.maximumMemoryBytes),
              16 * 1024 * 1024,
              8 * 1024 * 1024 * 1024,
            ),
            maximumOutputBytes: boundedInteger(
              Number(policyVersion.maximumOutputBytes),
              1_024,
              32 * 1024 * 1024,
            ),
            maximumToolCalls: boundedInteger(
              policyVersion.maximumToolCalls,
              1,
              200,
            ),
          }),
          agent: Object.freeze({
            maximumTurns: boundedInteger(policyVersion.maximumTurns, 1, 100),
            maximumInputTokensPerTurn: profileLimits.maximumInputTokens,
            maximumOutputTokensPerTurn: Math.min(
              profileLimits.maximumOutputTokens,
              boundedInteger(policyVersion.maximumOutputTokens, 1, 128_000),
            ),
            maximumInstructionCharacters: 64_000,
            budget: Object.freeze({ currency: profileLimits.currency, hard: true }),
          }),
        }),
        location: checkout,
        checkoutRef,
      });
    } catch (error) {
      if (
        error instanceof RepositoryAnalysisRuntimeNotApplicableError ||
        error instanceof PostgresRepositoryAnalysisRuntimeConfigurationError
      ) {
        throw error;
      }
      unavailable();
    }
  }

  public async resolveExecution(input: {
    readonly workspaceId: string;
    readonly runtimeVersionId: string;
    readonly repositoryId: string;
    readonly pinnedCommit: string;
    readonly signal: AbortSignal;
  }): Promise<RepositoryAnalysisRuntimeExecutionConfiguration> {
    const resolved = await this.resolve(input);
    return Object.freeze({
      runtimeVersionId: resolved.runtimeVersionId,
      repositoryId: resolved.repository.repositoryId,
      pinnedCommit: resolved.repository.pinnedCommit,
      repositoryAgentBindingVersionId:
        resolved.executionPolicy.repositoryAgentBindingVersionId,
      allowedTools: resolved.executionPolicy.allowedTools,
      sandbox: resolved.executionPolicy.sandbox,
      agent: resolved.executionPolicy.agent,
    });
  }

  private async resolveCheckout(input: {
    readonly workspaceId: string;
    readonly repository: JsonObject;
    readonly secretReferenceIds: Prisma.JsonValue;
  }): Promise<RepositoryAnalysisRuntimeLocation> {
    if (input.repository.mode === "deploymentMounted") {
      if (!Array.isArray(input.secretReferenceIds) || input.secretReferenceIds.length !== 0) {
        unavailable();
      }
      return Object.freeze({
        mode: "deploymentMounted",
        mountAlias: safeIdentifier(input.repository.mountAlias),
      });
    }
    if (input.repository.mode !== "remoteHttps") unavailable();
    if (!Array.isArray(input.secretReferenceIds) || input.secretReferenceIds.length > 1) {
      unavailable();
    }
    const id = input.secretReferenceIds[0];
    if (id === undefined) {
      return Object.freeze({
        mode: "remoteHttps",
        remoteUrl: remoteUrl(input.repository.remoteUrl),
      });
    }
    if (typeof id !== "string" || !identifier.test(id)) unavailable();
    const registration = await this.client.credentialRegistration.findFirst({
      where: {
        workspaceId: input.workspaceId,
        id,
        lifecycle: "active",
      },
      select: { secretReference: true },
    });
    if (
      registration === null ||
      !opaqueSecretLocator(registration.secretReference)
    ) {
      unavailable();
    }
    return Object.freeze({
      mode: "remoteHttps",
      remoteUrl: remoteUrl(input.repository.remoteUrl),
      checkoutSecretReference: registration.secretReference,
    });
  }

  private async configurationIdForVersion(
    workspaceId: string,
    versionId: string,
    resourceType: string,
  ): Promise<string> {
    const version = await this.client.administrationConfigurationVersion.findUnique({
      where: { workspaceId_id: { workspaceId, id: versionId } },
      select: {
        configuration: { select: { id: true, resourceType: true } },
      },
    });
    if (version === null || version.configuration.resourceType !== resourceType) {
      unavailable();
    }
    return version.configuration.id;
  }
}
