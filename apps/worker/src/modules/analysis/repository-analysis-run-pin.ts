import type { GitRepository } from "@caseweaver/connector-git-markdown";
import { EnvironmentConnectorSecretResolver } from "@caseweaver/connector-runtime";
import { type AnalysisProfile, type RepositoryRunPin } from "@caseweaver/analysis";
import { secretReference, utcInstant } from "@caseweaver/domain";
import type { PostgresRepositoryAnalysisRuntimeConfigurationResolver } from "@caseweaver/postgres";

const placeholderCommit = "0".repeat(40);

export interface RepositoryAnalysisMount {
  readonly alias: string;
  readonly directory: string;
}

/** Stable redacted runtime failure. Never expose the remote, path or locator. */
export class RepositoryAnalysisRunPinUnavailableError extends Error {
  public readonly code = "analysis.repositoryRuntimeUnavailable";
  public readonly retryable = false;

  public constructor() {
    super("The immutable repository analysis runtime is unavailable.");
    this.name = "RepositoryAnalysisRunPinUnavailableError";
  }
}

function unavailable(): never {
  throw new RepositoryAnalysisRunPinUnavailableError();
}

/**
 * Resolves the recipe's allowed ref once, before PBI-011 identity creation.
 * The result is an exact full commit pin. URLs, local paths, checkout
 * locators, and credential values are confined to this outer runtime adapter.
 */
export class RepositoryAnalysisRunPinResolver {
  private readonly mounts = new Map<string, string>();

  public constructor(
    private readonly configurations: PostgresRepositoryAnalysisRuntimeConfigurationResolver,
    private readonly git: GitRepository,
    private readonly secrets: EnvironmentConnectorSecretResolver,
    mounts: readonly RepositoryAnalysisMount[],
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const mount of mounts) {
      if (this.mounts.has(mount.alias)) unavailable();
      this.mounts.set(mount.alias, mount.directory);
    }
  }

  public async resolve(input: {
    readonly workspaceId: string;
    readonly profile: AnalysisProfile;
    /** Immutable recipe configuration version retained by the execution input. */
    readonly runtimeVersionId: string;
    readonly signal: AbortSignal;
  }): Promise<RepositoryRunPin> {
    if (input.signal.aborted || input.profile.repository.policy === "disabled") {
      unavailable();
    }
    const repository = input.profile.repository;
    if (
      repository.repositoryId === undefined ||
      repository.repositoryVersionId === undefined ||
      repository.executionPolicyId === undefined ||
      repository.executionPolicyVersionId === undefined ||
      repository.repositoryAgentBindingVersionId === undefined
    ) {
      unavailable();
    }
    const configuration = await this.configurations
      .resolve({
        workspaceId: input.workspaceId,
        runtimeVersionId: input.runtimeVersionId,
        repositoryId: repository.repositoryId,
        pinnedCommit: placeholderCommit,
        signal: input.signal,
      })
      .catch((error: unknown) => {
        if (input.signal.aborted) throw error;
        unavailable();
      });
    if (
      configuration.runtimeVersionId !== input.runtimeVersionId ||
      configuration.repository.repositoryId !== repository.repositoryId ||
      configuration.repository.repositoryVersionId !== repository.repositoryVersionId ||
      configuration.executionPolicy.executionPolicyId !==
        repository.executionPolicyId ||
      configuration.executionPolicy.executionPolicyVersionId !==
        repository.executionPolicyVersionId ||
      configuration.executionPolicy.repositoryAgentBindingVersionId !==
        repository.repositoryAgentBindingVersionId
    ) {
      unavailable();
    }
    try {
      const authentication =
        configuration.location.mode === "remoteHttps" &&
        configuration.location.checkoutSecretReference !== undefined
          ? {
              kind: "token" as const,
              token: (
                await this.secrets.resolve(
                  secretReference(configuration.location.checkoutSecretReference),
                  input.signal,
                )
              ).value,
            }
          : ({ kind: "none" } as const);
      const snapshot = await this.git.inspect(
        configuration.location.mode === "remoteHttps"
          ? {
              repository: {
                kind: "remote" as const,
                url: configuration.location.remoteUrl,
              },
              allowedLocalRoots: [],
              ref: configuration.checkoutRef,
              authentication,
              signal: input.signal,
            }
          : (() => {
              const directory = this.mounts.get(configuration.location.mountAlias);
              if (directory === undefined) unavailable();
              return {
                repository: { kind: "local" as const, path: directory },
                allowedLocalRoots: [directory],
                ref: configuration.checkoutRef,
                authentication,
                signal: input.signal,
              };
            })(),
      );
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(snapshot.commitSha)) {
        unavailable();
      }
      return Object.freeze({
        repositoryId: configuration.repository.repositoryId,
        repositoryVersionId: configuration.repository.repositoryVersionId,
        runtimePinId: configuration.runtimeVersionId,
        executionPolicyId: configuration.executionPolicy.executionPolicyId,
        executionPolicyVersionId:
          configuration.executionPolicy.executionPolicyVersionId,
        repositoryAgentBindingVersionId:
          configuration.executionPolicy.repositoryAgentBindingVersionId,
        pinnedCommit: snapshot.commitSha.toLowerCase(),
        resolvedAt: utcInstant(this.now()),
      });
    } catch (error) {
      if (input.signal.aborted) throw error;
      if (error instanceof RepositoryAnalysisRunPinUnavailableError) throw error;
      unavailable();
    }
  }
}
