import type {
  PinnedRepositoryAgentRuntimeResolver,
  RepositoryAgentRuntime,
  RepositoryAgentRuntimePin,
  ResolvedRepositoryAgentRuntime,
} from "@caseweaver/ai-sdk";
import type { RepositoryRuntimeConfigurationResolver } from "@caseweaver/postgres";
import {
  AttestedRepositoryRuntime,
  DockerOciRepositorySandbox,
  LocalGitPinnedRepositoryCheckoutBroker,
  LocalPreparedRepositoryTreeStore,
  RepositoryRuntimeError,
  type LocalGitCheckoutLimits,
  type LocalGitRepositorySource,
} from "@caseweaver/repository-runtime";

/**
 * Binds immutable PostgreSQL runtime configuration to an already-attested
 * runtime. It never interprets model input as a path, source, or checkout.
 */
export class ComposedPinnedRepositoryAgentRuntimeResolver
  implements PinnedRepositoryAgentRuntimeResolver
{
  public constructor(
    private readonly configurations: RepositoryRuntimeConfigurationResolver,
    private readonly runtime: RepositoryAgentRuntime,
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
      repository: configuration.repository,
      runtime: this.runtime,
      allowedTools: configuration.allowedTools,
      limits: configuration.sandboxLimits,
    });
  }
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
    new AttestedRepositoryRuntime(broker, sandbox),
  );
}
