import type {
  PinnedRepositoryAgentRuntimeResolver,
  RepositoryAgentRuntimeBinder,
  RepositoryAgentRuntimePin,
  ResolvedRepositoryAgentRuntime,
} from "@caseweaver/ai-sdk";
import type { GitRepository } from "@caseweaver/connector-git-markdown";
import { EnvironmentConnectorSecretResolver } from "@caseweaver/connector-runtime";
import { secretReference } from "@caseweaver/domain";
import {
  PostgresRepositoryAnalysisRuntimeConfigurationResolver,
  type RepositoryAnalysisRuntimeExecutionConfiguration,
  RepositoryAnalysisRuntimeNotApplicableError,
  type RepositoryRuntimeConfigurationResolver,
  type RepositoryRuntimeExecutionConfigurationResolver,
} from "@caseweaver/postgres";
import {
  AttestedRepositoryRuntime,
  DockerOciRepositorySandbox,
  type LocalGitCheckoutLimits,
  LocalGitPinnedRepositoryCheckoutBroker,
  type LocalGitRepositorySource,
  LocalPreparedRepositoryTreeStore,
  RepositoryRuntimeError,
} from "@caseweaver/repository-runtime";
import { GitCliPinnedRepositoryCheckoutBroker } from "@caseweaver/git-repository-runtime";

/**
 * Binds immutable PostgreSQL runtime configuration to an already-attested
 * runtime. It never interprets model input as a path, source, or checkout.
 */
export class ComposedPinnedRepositoryAgentRuntimeResolver
  implements PinnedRepositoryAgentRuntimeResolver
{
  public constructor(
    private readonly configurations: RepositoryRuntimeConfigurationResolver,
    private readonly runtime: RepositoryAgentRuntimeBinder,
  ) {}

  public async resolve(
    pin: RepositoryAgentRuntimePin,
    signal: AbortSignal,
  ): Promise<ResolvedRepositoryAgentRuntime> {
    const configuration = await this.configurations.resolve(pin, signal);
    if (
      configuration.runtimeVersionId !== pin.runtimeVersionId ||
      configuration.repository.repositoryId !== pin.repositoryId ||
      configuration.repository.pinnedCommit.toLowerCase() !==
        pin.pinnedCommit.toLowerCase()
    ) {
      throw new RepositoryRuntimeError(
        "repository.runtimeConfiguration",
        "Immutable repository runtime does not match its pin.",
      );
    }
    return Object.freeze({
      runtime: Object.freeze({
        repositoryId: configuration.repository.repositoryId,
        pinnedCommit: configuration.repository.pinnedCommit.toLowerCase(),
      }),
      executor: this.runtime.bind(configuration.repository),
      allowedTools: configuration.allowedTools,
      limits: configuration.sandboxLimits,
    });
  }
}

/** Deployment-owned mount alias. The browser and provider never see `directory`. */
export interface RepositoryAnalysisMountSource {
  readonly alias: string;
  readonly directory: string;
}

/**
 * Resolves PBI-020 recipe pins through their exact immutable configuration
 * version. A fresh broker is intentionally created per pin: remote URL/ref and
 * checkout locator remain inside this method and never enter a provider runtime.
 */
export class RepositoryAnalysisPinnedRuntimeResolver
  implements PinnedRepositoryAgentRuntimeResolver
{
  private readonly mounts = new Map<string, string>();

  public constructor(
    private readonly configurations: PostgresRepositoryAnalysisRuntimeConfigurationResolver,
    private readonly git: GitRepository,
    private readonly secrets: EnvironmentConnectorSecretResolver,
    private readonly trees: LocalPreparedRepositoryTreeStore,
    private readonly sandbox: DockerOciRepositorySandbox,
    mounts: readonly RepositoryAnalysisMountSource[],
    private readonly temporaryDirectory?: string,
  ) {
    for (const mount of mounts) {
      if (this.mounts.has(mount.alias)) {
        throw new RepositoryRuntimeError(
          "repository.runtimeConfiguration",
          "Repository mount aliases must be unique.",
        );
      }
      this.mounts.set(mount.alias, mount.directory);
    }
  }

  public async resolve(
    pin: RepositoryAgentRuntimePin,
    signal: AbortSignal,
  ): Promise<ResolvedRepositoryAgentRuntime> {
    const configuration = await this.configurations.resolve({ ...pin, signal });
    if (
      configuration.runtimeVersionId !== pin.runtimeVersionId ||
      configuration.repository.repositoryId !== pin.repositoryId ||
      configuration.repository.pinnedCommit.toLowerCase() !==
        pin.pinnedCommit.toLowerCase()
    ) {
      throw new RepositoryRuntimeError(
        "repository.runtimeConfiguration",
        "Immutable repository runtime does not match its pin.",
      );
    }
    const broker =
      configuration.location.mode === "remoteHttps"
        ? new GitCliPinnedRepositoryCheckoutBroker({
            repository: this.git,
            sources: [
              {
                repositoryId: configuration.repository.repositoryId,
                url: configuration.location.remoteUrl,
                ref: configuration.checkoutRef,
              },
            ],
            authentication: {
              resolve: async ({ signal: checkoutSignal }) => {
                if (configuration.location.mode !== "remoteHttps") {
                  throw new RepositoryRuntimeError(
                    "repository.runtimeConfiguration",
                    "Repository checkout configuration is unavailable.",
                  );
                }
                if (configuration.location.checkoutSecretReference === undefined) {
                  return { kind: "none" as const };
                }
                return {
                  kind: "token" as const,
                  token: (
                    await this.secrets.resolve(
                      secretReference(
                        configuration.location.checkoutSecretReference,
                      ),
                      checkoutSignal,
                    )
                  ).value,
                };
              },
            },
            treeStore: this.trees,
            ...(this.temporaryDirectory === undefined
              ? {}
              : { temporaryDirectory: this.temporaryDirectory }),
          })
        : (() => {
            const directory = this.mounts.get(configuration.location.mountAlias);
            if (directory === undefined) {
              throw new RepositoryRuntimeError(
                "repository.runtimeConfiguration",
                "Configured repository mount is unavailable.",
              );
            }
            return new LocalGitPinnedRepositoryCheckoutBroker({
              sources: [
                {
                  repositoryId: configuration.repository.repositoryId,
                  directory,
                },
              ],
              treeStore: this.trees,
              ...(this.temporaryDirectory === undefined
                ? {}
                : { temporaryDirectory: this.temporaryDirectory }),
            });
          })();
    const runtime = new AttestedRepositoryRuntime(broker, this.sandbox, this.trees);
    return Object.freeze({
      runtime: Object.freeze({
        repositoryId: configuration.repository.repositoryId,
        pinnedCommit: configuration.repository.pinnedCommit.toLowerCase(),
      }),
      executor: runtime.bind(configuration.repository),
      allowedTools: configuration.executionPolicy.allowedTools,
      limits: configuration.executionPolicy.sandbox,
    });
  }
}

/**
 * Uses the PBI-020 execution-policy projection when a runtime pin is an
 * analysis-recipe version, and delegates historical PBI-010 pins unchanged.
 */
export class CompositeRepositoryRuntimeExecutionResolver
  implements RepositoryRuntimeExecutionConfigurationResolver
{
  public constructor(
    private readonly recipes: PostgresRepositoryAnalysisRuntimeConfigurationResolver,
    private readonly legacy: RepositoryRuntimeExecutionConfigurationResolver,
  ) {}

  public async resolveExecution(
    pin: RepositoryAgentRuntimePin,
    signal: AbortSignal,
  ) {
    try {
      const resolved = await this.recipes.resolveExecution({ ...pin, signal });
      return legacyExecutionProjection(resolved);
    } catch (error) {
      if (!(error instanceof RepositoryAnalysisRuntimeNotApplicableError)) {
        throw error;
      }
      return this.legacy.resolveExecution(pin, signal);
    }
  }
}

/** Source-free resolver for installations that enable only PBI-020 recipes. */
export class RepositoryAnalysisRuntimeExecutionResolver
  implements RepositoryRuntimeExecutionConfigurationResolver
{
  public constructor(
    private readonly recipes: PostgresRepositoryAnalysisRuntimeConfigurationResolver,
  ) {}

  public async resolveExecution(
    pin: RepositoryAgentRuntimePin,
    signal: AbortSignal,
  ) {
    return legacyExecutionProjection(
      await this.recipes.resolveExecution({ ...pin, signal }),
    );
  }
}

/** Provider-side equivalent of the execution resolver above. */
export class CompositePinnedRepositoryAgentRuntimeResolver
  implements PinnedRepositoryAgentRuntimeResolver
{
  public constructor(
    private readonly recipes: RepositoryAnalysisPinnedRuntimeResolver,
    private readonly legacy: PinnedRepositoryAgentRuntimeResolver,
  ) {}

  public async resolve(
    pin: RepositoryAgentRuntimePin,
    signal: AbortSignal,
  ): Promise<ResolvedRepositoryAgentRuntime> {
    try {
      return await this.recipes.resolve(pin, signal);
    } catch (error) {
      if (!(error instanceof RepositoryAnalysisRuntimeNotApplicableError)) {
        throw error;
      }
      return this.legacy.resolve(pin, signal);
    }
  }
}

function legacyExecutionProjection(
  resolved: RepositoryAnalysisRuntimeExecutionConfiguration,
): Awaited<
  ReturnType<RepositoryRuntimeExecutionConfigurationResolver["resolveExecution"]>
> {
  return Object.freeze({
    runtimeVersionId: resolved.runtimeVersionId,
    repositoryId: resolved.repositoryId,
    pinnedCommit: resolved.pinnedCommit,
    allowedTools: resolved.allowedTools,
    sandboxLimits: resolved.sandbox,
    execution: Object.freeze({
      bindingVersionId: resolved.repositoryAgentBindingVersionId,
      ...resolved.agent,
    }),
  });
}

/**
 * Builds a single sandbox/tree boundary shared by PBI-020 dynamic remote or
 * mounted checkouts. The caller may compose it with the historical resolver.
 */
export async function createRepositoryAnalysisPinnedRuntimeResolver(input: {
  readonly configurations: PostgresRepositoryAnalysisRuntimeConfigurationResolver;
  readonly git: GitRepository;
  readonly environment: NodeJS.ProcessEnv;
  readonly mounts: readonly RepositoryAnalysisMountSource[];
  readonly sandboxImage: string;
  readonly dockerSocketPath?: string;
  readonly temporaryDirectory?: string;
}): Promise<RepositoryAnalysisPinnedRuntimeResolver> {
  const trees = new LocalPreparedRepositoryTreeStore();
  const sandbox = await DockerOciRepositorySandbox.create({
    treeStore: trees,
    image: input.sandboxImage,
    ...(input.dockerSocketPath === undefined
      ? {}
      : { socketPath: input.dockerSocketPath }),
  });
  return new RepositoryAnalysisPinnedRuntimeResolver(
    input.configurations,
    input.git,
    new EnvironmentConnectorSecretResolver(input.environment),
    trees,
    sandbox,
    input.mounts,
    input.temporaryDirectory,
  );
}

/**
 * Optional Linux-only host composition for a local administrator-mapped Git
 * worktree and a digest-pinned OCI sandbox. A provider adapter receives the
 * returned resolver; it must still call it solely from `ai-execution`.
 */
export async function createLocalGitOciPinnedRepositoryRuntimeResolver(input: {
  readonly configurations: RepositoryRuntimeConfigurationResolver;
  readonly sources: readonly LocalGitRepositorySource[];
  readonly sandboxImage: string;
  readonly dockerSocketPath?: string;
  readonly temporaryDirectory?: string;
  readonly checkoutLimits?: Partial<LocalGitCheckoutLimits>;
}): Promise<PinnedRepositoryAgentRuntimeResolver> {
  const trees = new LocalPreparedRepositoryTreeStore();
  const broker = new LocalGitPinnedRepositoryCheckoutBroker({
    sources: input.sources,
    treeStore: trees,
    ...(input.temporaryDirectory === undefined
      ? {}
      : { temporaryDirectory: input.temporaryDirectory }),
    ...(input.checkoutLimits === undefined
      ? {}
      : { limits: input.checkoutLimits }),
  });
  const sandbox = await DockerOciRepositorySandbox.create({
    treeStore: trees,
    image: input.sandboxImage,
    ...(input.dockerSocketPath === undefined
      ? {}
      : { socketPath: input.dockerSocketPath }),
  });
  return new ComposedPinnedRepositoryAgentRuntimeResolver(
    input.configurations,
    new AttestedRepositoryRuntime(broker, sandbox, trees),
  );
}
