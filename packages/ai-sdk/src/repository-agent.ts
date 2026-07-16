export type RepositoryReadOnlyTool = "listFiles" | "readFile" | "searchFiles";

/**
 * This configuration is selected by an administrator at composition time. It
 * is never derived from case content or supplied to a model as a credential.
 */
export interface ConfiguredRepository {
  readonly repositoryId: string;
  readonly checkoutSecretReference: string;
  readonly pinnedCommit: string;
}

/**
 * An immutable, server-selected repository-runtime identity.  It contains no
 * checkout endpoint, filesystem location, or credential.  The application
 * creates this pin from a retained analysis profile; case content and model
 * tool input must never create or alter it.
 */
export interface RepositoryAgentRuntimePin {
  readonly workspaceId: string;
  readonly runtimeVersionId: string;
  readonly repositoryId: string;
  readonly pinnedCommit: string;
}

export interface RepositoryAgentEvidence {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface RepositoryAgentRuntimeResult {
  readonly summary: string;
  readonly evidence: readonly RepositoryAgentEvidence[];
}

export interface RepositoryAgentToolGateway {
  execute(
    tool: RepositoryReadOnlyTool,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

export interface RepositoryAgentRuntimeContext {
  readonly repositoryId: string;
  readonly pinnedCommit: string;
  readonly tools: RepositoryAgentToolGateway;
}

export interface RepositoryAgentSandboxLimits {
  readonly timeoutMs: number;
  readonly maximumCpuMilliseconds: number;
  readonly maximumMemoryBytes: number;
  readonly maximumOutputBytes: number;
  readonly maximumToolCalls: number;
}

export interface RepositoryAgentRuntimeRequest {
  readonly repository: ConfiguredRepository;
  readonly instruction: string;
  readonly allowedTools: readonly RepositoryReadOnlyTool[];
  readonly limits: RepositoryAgentSandboxLimits;
  readonly signal: AbortSignal;
}

/**
 * Provider-neutral boundary between an agent adapter and the isolated,
 * administrator-configured repository runtime.
 */
export interface RepositoryAgentRuntime {
  run(
    request: RepositoryAgentRuntimeRequest,
    runner: (
      context: RepositoryAgentRuntimeContext,
    ) => Promise<RepositoryAgentRuntimeResult>,
  ): Promise<RepositoryAgentRuntimeResult>;
}

/**
 * The server-private runtime material selected by an immutable pin.  Only a
 * provider adapter receives this result, so the checkout secret reference is
 * still confined to the checkout-broker boundary.
 */
export interface ResolvedRepositoryAgentRuntime {
  readonly repository: ConfiguredRepository;
  readonly runtime: RepositoryAgentRuntime;
  readonly allowedTools: readonly RepositoryReadOnlyTool[];
  readonly limits: RepositoryAgentSandboxLimits;
}

/**
 * Resolves only an exact, workspace-scoped runtime version.  Implementations
 * must fail closed for an unknown, inactive, mismatched, or superseded pin and
 * must not substitute a current/default configuration.
 */
export interface PinnedRepositoryAgentRuntimeResolver {
  resolve(
    pin: RepositoryAgentRuntimePin,
    signal: AbortSignal,
  ): Promise<ResolvedRepositoryAgentRuntime>;
}
