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
