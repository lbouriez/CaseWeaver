import type {
  ConfiguredRepository,
  RepositoryAgentEvidence,
  RepositoryAgentRuntimeResult,
  RepositoryAgentSandboxLimits,
  RepositoryReadOnlyTool,
} from "@caseweaver/ai-sdk";

export type RepositoryToolName = RepositoryReadOnlyTool;
export type AdministratorRepositoryConfiguration = ConfiguredRepository;
export type RepositorySandboxLimits = RepositoryAgentSandboxLimits;
export type RepositoryAgentOutput = RepositoryAgentRuntimeResult;
export type RepositoryEvidence = RepositoryAgentEvidence;

export interface PinnedRepositoryFile {
  readonly path: string;
  readonly lineCount: number;
}

/**
 * The broker is the sole recipient of checkout authentication. A sanitized tree is
 * deliberately an opaque identifier plus a manifest, never a local path or remote.
 */
export interface SanitizedPinnedTree {
  readonly treeId: string;
  readonly repositoryId: string;
  readonly pinnedCommit: string;
  readonly files: readonly PinnedRepositoryFile[];
}

export interface RepositoryCheckoutBroker {
  checkout(
    configuration: AdministratorRepositoryConfiguration,
    signal: AbortSignal,
  ): Promise<SanitizedPinnedTree>;
}

export interface RepositorySandboxAttestation {
  readonly networkDisabled: boolean;
  readonly credentialsUnavailable: boolean;
  readonly readOnlyFilesystem: boolean;
  readonly disposableFilesystem: boolean;
  readonly toolAllowlistEnforced: boolean;
  readonly quotasEnforced: boolean;
}

export interface RepositorySandboxSession {
  execute(
    tool: RepositoryToolName,
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<unknown>;
  terminate(): Promise<void>;
}

export interface IsolatedRepositorySandbox {
  readonly attestation: RepositorySandboxAttestation;
  open(input: {
    readonly tree: SanitizedPinnedTree;
    readonly allowedTools: readonly RepositoryToolName[];
    readonly limits: RepositorySandboxLimits;
    readonly signal: AbortSignal;
  }): Promise<RepositorySandboxSession>;
  cleanup(treeId: string): Promise<void>;
}

export class RepositoryRuntimeError extends Error {
  public constructor(
    public readonly code:
      | "repository.runtimeConfiguration"
      | "repository.runtimeIsolation"
      | "repository.runtimeTimeout"
      | "repository.runtimeOutput",
    message: string,
  ) {
    super(message);
    this.name = "RepositoryRuntimeError";
  }
}
