import { isAbsolute } from "node:path";

import type {
  RepositoryAnalysisDeploymentRegistry,
  RepositoryDraftTestExecutionCandidateResolver,
  RepositoryDraftTestOutcome,
  RepositoryDraftTestRunner,
} from "@caseweaver/administration";
import { secretReference } from "@caseweaver/domain";
import { EnvironmentConnectorSecretResolver } from "@caseweaver/connector-runtime";
import { GitCliRepository } from "@caseweaver/git-repository-runtime";

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

type DeploymentOption = Readonly<{
  readonly id: string;
  readonly label: string;
}>;

type MountedRepository = DeploymentOption &
  Readonly<{
    /** Host/container path is trusted deployment material and never a DTO. */
    readonly directory: string;
  }>;

export interface RepositoryAnalysisDeploymentConfiguration {
  readonly mountedRepositories: readonly MountedRepository[];
  readonly sandboxPolicies: readonly DeploymentOption[];
  readonly attachmentProcessorSecurityPolicies: readonly DeploymentOption[];
  readonly gitTemporaryDirectory?: string;
  readonly gitRemoteCacheDirectory?: string;
}

/** Thrown only while parsing deployment-owned configuration, before API startup. */
export class RepositoryAnalysisDeploymentConfigurationError extends Error {
  public constructor() {
    super("Repository analysis deployment configuration is invalid.");
    this.name = "RepositoryAnalysisDeploymentConfigurationError";
  }
}

/**
 * Parses only deployment-owned aliases and process directories. Browser requests
 * can select an opaque alias but can never name a host path, cache, image, or
 * checkout secret. Empty lists deliberately advertise no unavailable host policy.
 */
export function parseRepositoryAnalysisDeploymentConfiguration(
  environment: NodeJS.ProcessEnv,
): RepositoryAnalysisDeploymentConfiguration {
  const mountedRepositories = parseMountedRepositories(
    environment.ADMIN_REPOSITORY_ANALYSIS_MOUNTS_JSON,
  );
  const sandboxPolicies = parseOptions(
    environment.ADMIN_REPOSITORY_ANALYSIS_SANDBOX_POLICIES_JSON,
  );
  const attachmentProcessorSecurityPolicies = parseOptions(
    environment.ADMIN_REPOSITORY_ANALYSIS_ATTACHMENT_PROCESSOR_POLICIES_JSON,
  );
  return Object.freeze({
    mountedRepositories,
    sandboxPolicies,
    attachmentProcessorSecurityPolicies,
    ...optionalDirectory(
      environment.ADMIN_REPOSITORY_ANALYSIS_GIT_TEMPORARY_DIRECTORY,
      "gitTemporaryDirectory",
    ),
    ...optionalDirectory(
      environment.ADMIN_REPOSITORY_ANALYSIS_GIT_REMOTE_CACHE_DIRECTORY,
      "gitRemoteCacheDirectory",
    ),
  });
}

/** Safe option projection; private mount directories are intentionally omitted. */
export class EnvironmentRepositoryAnalysisDeploymentRegistry
  implements RepositoryAnalysisDeploymentRegistry
{
  public constructor(
    private readonly configuration: RepositoryAnalysisDeploymentConfiguration,
  ) {}

  public async listMountedRepositories() {
    return safeOptions(this.configuration.mountedRepositories);
  }

  public async listSandboxPolicies() {
    return safeOptions(this.configuration.sandboxPolicies);
  }

  public async listAttachmentProcessorSecurityPolicies() {
    return safeOptions(this.configuration.attachmentProcessorSecurityPolicies);
  }
}

/**
 * Non-destructive administration test. It proves that the API host can resolve
 * the configured Git reference, but deliberately retains no source tree or
 * remote result. The durable use case converts any failure to a redacted
 * terminal outcome after its confirmation/claim boundary.
 */
export class RepositoryAnalysisDraftTestRunner
  implements RepositoryDraftTestRunner
{
  private readonly mounts = new Map<string, MountedRepository>();
  private readonly secrets: EnvironmentConnectorSecretResolver;
  private readonly repository: GitCliRepository;

  public constructor(
    private readonly candidates: RepositoryDraftTestExecutionCandidateResolver,
    configuration: RepositoryAnalysisDeploymentConfiguration,
    environment: NodeJS.ProcessEnv,
  ) {
    for (const mount of configuration.mountedRepositories) {
      this.mounts.set(mount.id, mount);
    }
    this.secrets = new EnvironmentConnectorSecretResolver(environment);
    this.repository = new GitCliRepository({
      environment,
      ...(configuration.gitTemporaryDirectory === undefined
        ? {}
        : { temporaryDirectory: configuration.gitTemporaryDirectory }),
      ...(configuration.gitRemoteCacheDirectory === undefined
        ? {}
        : { remoteCacheDirectory: configuration.gitRemoteCacheDirectory }),
    });
  }

  public async run(
    input: Parameters<RepositoryDraftTestRunner["run"]>[0],
  ): Promise<RepositoryDraftTestOutcome> {
    const candidate = await this.candidates.resolveExecutionCandidate({
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      candidateVersionId: input.candidateVersionId,
      candidateDigest: input.candidateDigest,
    });
    if (candidate === undefined) return "failed";
    try {
      if (candidate.location.mode === "deploymentMounted") {
        const mount = this.mounts.get(candidate.location.mountAlias);
        if (mount === undefined) return "failed";
        await this.repository.inspect({
          repository: { kind: "local", path: mount.directory },
          allowedLocalRoots: [mount.directory],
          ref: candidate.checkoutRef,
          authentication: { kind: "none" },
          signal: input.signal,
        });
        return "completed";
      }
      const authentication =
        candidate.location.checkoutSecretReference === undefined
          ? ({ kind: "none" } as const)
          : {
              kind: "token" as const,
              token: (
                await this.secrets.resolve(
                  secretReference(candidate.location.checkoutSecretReference),
                  input.signal,
                )
              ).value,
            };
      await this.repository.inspect({
        repository: { kind: "remote", url: candidate.location.remoteUrl },
        allowedLocalRoots: [],
        ref: candidate.checkoutRef,
        authentication,
        signal: input.signal,
      });
      return "completed";
    } catch (error) {
      // The use case treats cancellation as outcome_unknown. Never surface a
      // Git path, URL, reference, secret, or error to a DTO/audit/log boundary.
      if (input.signal.aborted) throw error;
      return "failed";
    }
  }
}

function parseMountedRepositories(value: string | undefined): readonly MountedRepository[] {
  const entries = parseArray(value);
  const seen = new Set<string>();
  return Object.freeze(
    entries.map((entry) => {
      const record = plainRecord(entry);
      exactKeys(record, ["id", "label", "directory"]);
      const id = optionId(record.id);
      if (seen.has(id)) invalid();
      seen.add(id);
      const directory = directoryValue(record.directory);
      return Object.freeze({ id, label: optionLabel(record.label), directory });
    }),
  );
}

function parseOptions(value: string | undefined): readonly DeploymentOption[] {
  const entries = parseArray(value);
  const seen = new Set<string>();
  return Object.freeze(
    entries.map((entry) => {
      const record = plainRecord(entry);
      exactKeys(record, ["id", "label"]);
      const id = optionId(record.id);
      if (seen.has(id)) invalid();
      seen.add(id);
      return Object.freeze({ id, label: optionLabel(record.label) });
    }),
  );
}

function parseArray(value: string | undefined): readonly unknown[] {
  if (value === undefined || value.trim().length === 0) return Object.freeze([]);
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 100) invalid();
    return parsed;
  } catch {
    invalid();
  }
}

function optionalDirectory(
  value: string | undefined,
  key: "gitTemporaryDirectory" | "gitRemoteCacheDirectory",
): Readonly<Record<string, never>> | Readonly<Record<typeof key, string>> {
  if (value === undefined || value.length === 0) return Object.freeze({});
  return Object.freeze({ [key]: directoryValue(value) }) as Readonly<
    Record<typeof key, string>
  >;
}

function safeOptions(values: readonly DeploymentOption[]) {
  return Object.freeze(
    values.map((value) =>
      Object.freeze({
        id: value.id,
        label: value.label,
        eligibleForDraft: true,
        eligibleForActivation: true,
      }),
    ),
  );
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !(key in value))) {
    invalid();
  }
}

function optionId(value: unknown): string {
  if (typeof value !== "string" || !identifier.test(value)) invalid();
  return value;
}

function optionLabel(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 200 ||
    /[\r\n\0]/u.test(value)
  ) {
    invalid();
  }
  return value;
}

function directoryValue(value: unknown): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.length > 4_096 ||
    /[\r\n\0]/u.test(value)
  ) {
    invalid();
  }
  return value;
}

function invalid(): never {
  throw new RepositoryAnalysisDeploymentConfigurationError();
}
