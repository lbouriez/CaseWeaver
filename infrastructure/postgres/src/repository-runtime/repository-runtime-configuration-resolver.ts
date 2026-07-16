import type {
  ConfiguredRepository,
  RepositoryAgentRuntimePin,
  RepositoryAgentSandboxLimits,
  RepositoryReadOnlyTool,
} from "@caseweaver/ai-sdk";
import type { Prisma, PrismaClient } from "@prisma/client";

type JsonObject = Readonly<Record<string, Prisma.JsonValue>>;

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const shaPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu;
const allowedTools = new Set<RepositoryReadOnlyTool>([
  "listFiles",
  "readFile",
  "searchFiles",
]);

/**
 * Private model-execution bounds retained with the immutable repository
 * runtime. Unknown pricing is deliberately not representable here.
 */
export interface RepositoryAgentExecutionConfiguration {
  readonly bindingVersionId: string;
  readonly maximumTurns: number;
  readonly maximumInputTokensPerTurn: number;
  readonly maximumOutputTokensPerTurn: number;
  readonly maximumInstructionCharacters: number;
  readonly budget: Readonly<{
    readonly currency: string;
    readonly hard: true;
  }>;
}

/** Server-private exact configuration used by worker/provider composition only. */
export interface ResolvedRepositoryRuntimeConfiguration {
  readonly runtimeVersionId: string;
  readonly repository: ConfiguredRepository;
  readonly allowedTools: readonly RepositoryReadOnlyTool[];
  readonly sandboxLimits: RepositoryAgentSandboxLimits;
  readonly execution: RepositoryAgentExecutionConfiguration;
}

export interface RepositoryRuntimeConfigurationResolver {
  resolve(
    pin: RepositoryAgentRuntimePin,
    signal: AbortSignal,
  ): Promise<ResolvedRepositoryRuntimeConfiguration>;
}

/**
 * Secret-free execution projection for analysis orchestration. It deliberately
 * omits the checkout locator, which is reserved for checkout-broker/provider
 * composition only.
 */
export interface RepositoryRuntimeExecutionConfiguration {
  readonly runtimeVersionId: string;
  readonly repositoryId: string;
  readonly pinnedCommit: string;
  readonly allowedTools: readonly RepositoryReadOnlyTool[];
  readonly sandboxLimits: RepositoryAgentSandboxLimits;
  readonly execution: RepositoryAgentExecutionConfiguration;
}

export interface RepositoryRuntimeExecutionConfigurationResolver {
  resolveExecution(
    pin: RepositoryAgentRuntimePin,
    signal: AbortSignal,
  ): Promise<RepositoryRuntimeExecutionConfiguration>;
}

/** A stable, redacted error safe for queue failure persistence. */
export class PostgresRepositoryRuntimeConfigurationError extends Error {
  public readonly code = "analysis.repositoryRuntimeUnavailable";
  public readonly retryable = false;

  public constructor() {
    super("The immutable repository runtime is unavailable.");
    this.name = "PostgresRepositoryRuntimeConfigurationError";
  }
}

function unavailable(): never {
  throw new PostgresRepositoryRuntimeConfigurationError();
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) unavailable();
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

function identifier(value: Prisma.JsonValue | undefined): string {
  if (typeof value !== "string" || !identifierPattern.test(value))
    unavailable();
  return value;
}

function sha(value: Prisma.JsonValue | undefined): string {
  if (typeof value !== "string" || !shaPattern.test(value)) unavailable();
  return value.toLowerCase();
}

function boundedInteger(
  value: Prisma.JsonValue | undefined,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    unavailable();
  }
  return value;
}

function exactKeys(value: JsonObject, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) unavailable();
}

function parseSettings(
  value: Prisma.JsonValue,
): Omit<
  ResolvedRepositoryRuntimeConfiguration,
  "runtimeVersionId" | "repository"
> & { readonly repositoryId: string; readonly pinnedCommit: string } {
  const settings = object(value);
  exactKeys(settings, [
    "repositoryId",
    "pinnedCommit",
    "bindingVersionId",
    "allowedTools",
    "sandbox",
    "agent",
  ]);
  const parsedTools = array(settings.allowedTools);
  if (
    parsedTools.length === 0 ||
    parsedTools.length > allowedTools.size ||
    !parsedTools.every(
      (tool): tool is RepositoryReadOnlyTool =>
        typeof tool === "string" &&
        allowedTools.has(tool as RepositoryReadOnlyTool),
    ) ||
    new Set(parsedTools).size !== parsedTools.length
  ) {
    unavailable();
  }

  const sandbox = object(settings.sandbox);
  exactKeys(sandbox, [
    "timeoutMs",
    "maximumCpuMilliseconds",
    "maximumMemoryBytes",
    "maximumOutputBytes",
    "maximumToolCalls",
  ]);
  const agent = object(settings.agent);
  exactKeys(agent, [
    "maximumTurns",
    "maximumInputTokensPerTurn",
    "maximumOutputTokensPerTurn",
    "maximumInstructionCharacters",
    "budget",
  ]);
  const budget = object(agent.budget);
  exactKeys(budget, ["currency", "hard"]);
  if (
    typeof budget.currency !== "string" ||
    budget.currency.length === 0 ||
    budget.currency.length > 16 ||
    budget.hard !== true
  ) {
    unavailable();
  }

  return Object.freeze({
    repositoryId: identifier(settings.repositoryId),
    pinnedCommit: sha(settings.pinnedCommit),
    allowedTools: Object.freeze([...parsedTools]),
    sandboxLimits: Object.freeze({
      timeoutMs: boundedInteger(sandbox.timeoutMs, 1_000, 15 * 60_000),
      maximumCpuMilliseconds: boundedInteger(
        sandbox.maximumCpuMilliseconds,
        1_000,
        15 * 60_000,
      ),
      maximumMemoryBytes: boundedInteger(
        sandbox.maximumMemoryBytes,
        16 * 1024 * 1024,
        8 * 1024 * 1024 * 1024,
      ),
      maximumOutputBytes: boundedInteger(
        sandbox.maximumOutputBytes,
        1_024,
        10 * 1024 * 1024,
      ),
      maximumToolCalls: boundedInteger(sandbox.maximumToolCalls, 1, 1_000),
    }),
    execution: Object.freeze({
      bindingVersionId: identifier(settings.bindingVersionId),
      maximumTurns: boundedInteger(agent.maximumTurns, 1, 100),
      maximumInputTokensPerTurn: boundedInteger(
        agent.maximumInputTokensPerTurn,
        1,
        1_000_000,
      ),
      maximumOutputTokensPerTurn: boundedInteger(
        agent.maximumOutputTokensPerTurn,
        1,
        1_000_000,
      ),
      maximumInstructionCharacters: boundedInteger(
        agent.maximumInstructionCharacters,
        1,
        128_000,
      ),
      budget: Object.freeze({ currency: budget.currency, hard: true }),
    }),
  });
}

function checkoutReference(value: Prisma.JsonValue): string {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    typeof value[0] !== "string" ||
    value[0].length === 0 ||
    value[0].length > 500 ||
    /[\r\n\0]/u.test(value[0])
  ) {
    unavailable();
  }
  return value[0];
}

/**
 * Resolves a retained repository-runtime version without consulting an
 * aggregate's mutable current-version pointer. It selects no endpoint, path,
 * or checkout data beyond the opaque server-private credential locator.
 */
export class PostgresRepositoryRuntimeConfigurationResolver
  implements
    RepositoryRuntimeConfigurationResolver,
    RepositoryRuntimeExecutionConfigurationResolver
{
  public constructor(private readonly client: PrismaClient) {}

  public async resolve(
    pin: RepositoryAgentRuntimePin,
    signal: AbortSignal,
  ): Promise<ResolvedRepositoryRuntimeConfiguration> {
    assertActive(signal);
    try {
      return await this.client.$transaction(async (database) => {
        const version =
          await database.administrationConfigurationVersion.findUnique({
            where: {
              workspaceId_id: {
                workspaceId: pin.workspaceId,
                id: pin.runtimeVersionId,
              },
            },
            select: {
              id: true,
              workspaceId: true,
              settings: true,
              secretReferences: true,
              configuration: {
                select: { resourceType: true, lifecycle: true },
              },
            },
          });
        assertActive(signal);
        if (
          version === null ||
          version.id !== pin.runtimeVersionId ||
          version.workspaceId !== pin.workspaceId ||
          version.configuration.resourceType !== "repository-runtimes" ||
          version.configuration.lifecycle !== "active"
        ) {
          unavailable();
        }
        const parsed = parseSettings(version.settings);
        if (
          parsed.repositoryId !== pin.repositoryId ||
          parsed.pinnedCommit !== pin.pinnedCommit.toLowerCase()
        ) {
          unavailable();
        }
        const secretReference = checkoutReference(version.secretReferences);
        const credential = await database.credentialRegistration.findFirst({
          where: {
            workspaceId: pin.workspaceId,
            secretReference,
            lifecycle: "active",
          },
          select: { id: true },
        });
        assertActive(signal);
        if (credential === null) unavailable();
        return Object.freeze({
          runtimeVersionId: version.id,
          repository: Object.freeze({
            repositoryId: parsed.repositoryId,
            pinnedCommit: parsed.pinnedCommit,
            checkoutSecretReference: secretReference,
          }),
          allowedTools: parsed.allowedTools,
          sandboxLimits: parsed.sandboxLimits,
          execution: parsed.execution,
        });
      });
    } catch (error) {
      if (error instanceof PostgresRepositoryRuntimeConfigurationError) {
        throw error;
      }
      throw new PostgresRepositoryRuntimeConfigurationError();
    }
  }

  public async resolveExecution(
    pin: RepositoryAgentRuntimePin,
    signal: AbortSignal,
  ): Promise<RepositoryRuntimeExecutionConfiguration> {
    const configuration = await this.resolve(pin, signal);
    return Object.freeze({
      runtimeVersionId: configuration.runtimeVersionId,
      repositoryId: configuration.repository.repositoryId,
      pinnedCommit: configuration.repository.pinnedCommit,
      allowedTools: configuration.allowedTools,
      sandboxLimits: configuration.sandboxLimits,
      execution: configuration.execution,
    });
  }
}
