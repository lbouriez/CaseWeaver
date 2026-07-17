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

/** Broker-only checkout material. Never hand this to a provider adapter. */
export type RepositoryCheckoutMaterial = ConfiguredRepository;

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
    configuration: RepositoryCheckoutMaterial,
    signal: AbortSignal,
  ): Promise<SanitizedPinnedTree>;
}

/**
 * Reads only a regular UTF-8 text blob from a private prepared tree. The
 * attested runtime uses it to calculate citation hashes; no provider receives
 * the directory, remote, credential, or source bytes through this port.
 */
export interface PreparedRepositoryTreeReader {
  readText(input: {
    readonly tree: SanitizedPinnedTree;
    readonly path: string;
    readonly signal: AbortSignal;
  }): Promise<string>;
}

/** Server-private materialization sink shared by checkout adapters and OCI. */
export interface PreparedRepositoryTreeRegistrar {
  register(
    value: SanitizedPinnedTree & {
      readonly directory: string;
      /** Server-private parent removed with the prepared tree. */
      readonly cleanupDirectory: string;
    },
  ): void;
}

export interface RepositorySandboxAttestation {
  readonly networkDisabled: boolean;
  readonly credentialsUnavailable: boolean;
  readonly readOnlyFilesystem: boolean;
  readonly disposableFilesystem: boolean;
  readonly toolAllowlistEnforced: boolean;
  readonly quotasEnforced: boolean;
  readonly unprivilegedUser: boolean;
  readonly immutableImage: boolean;
  readonly readOnlyRepositoryMount: boolean;
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
      | "repository.runtimeOutput"
      | "repository.runtimePreparation",
    message: string,
  ) {
    super(message);
    this.name = "RepositoryRuntimeError";
  }
}
