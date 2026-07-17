export type RepositoryReadOnlyTool = "listFiles" | "readFile" | "searchFiles";

/**
 * This configuration is selected by an administrator at composition time. It
 * is never derived from case content or supplied to a model as a credential.
 */
export interface ConfiguredRepository {
  readonly repositoryId: string;
  /**
   * A server-private opaque locator resolved only by a checkout broker. It is
   * deliberately absent from every provider-visible runtime contract.
   */
  readonly checkoutSecretReference: string;
  readonly pinnedCommit: string;
}

/**
 * The only repository identity a provider or agent runtime may observe. It is
 * not a checkout endpoint, local path, remote URL, or secret reference.
 */
export interface OpaqueRepositoryRuntime {
  readonly repositoryId: string;
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
  /** Deterministic runtime-derived identifier for a verified code excerpt. */
  readonly id: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** SHA-256 over the exact normalized cited excerpt, derived outside the model. */
  readonly excerptHash: string;
}

/**
 * This is untrusted provider output. The isolated runtime resolves these
 * locations against its prepared tree before any evidence can leave it.
 */
export interface RepositoryAgentCitationLocation {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** Untrusted provider-authored observation linked to one or more citations. */
export interface RepositoryAgentUnverifiedFinding {
  readonly summary: string;
  readonly citations: readonly RepositoryAgentCitationLocation[];
}

/** Bounded provider output accepted only at the isolated runtime boundary. */
export interface RepositoryAgentUnverifiedResult {
  readonly summary: string;
  readonly findings: readonly RepositoryAgentUnverifiedFinding[];
}

/** Verified, evidence-linked finding that may enter the analysis package. */
export interface RepositoryAgentFinding {
  readonly id: string;
  readonly summary: string;
  readonly evidenceIds: readonly string[];
}

export interface RepositoryAgentRuntimeResult {
  readonly summary: string;
  readonly evidence: readonly RepositoryAgentEvidence[];
  readonly findings: readonly RepositoryAgentFinding[];
}

export interface RepositoryAgentToolGateway {
  execute(
    tool: RepositoryReadOnlyTool,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

export interface RepositoryAgentRuntimeContext {
  readonly runtime: OpaqueRepositoryRuntime;
  readonly tools: RepositoryAgentToolGateway;
  /** Cancels provider egress and tool calls when the sandbox is stopped. */
  readonly signal: AbortSignal;
}

export interface RepositoryAgentSandboxLimits {
  readonly timeoutMs: number;
  readonly maximumCpuMilliseconds: number;
  readonly maximumMemoryBytes: number;
  readonly maximumOutputBytes: number;
  readonly maximumToolCalls: number;
}

export interface RepositoryAgentRuntimeRequest {
  /** Provider-visible identity; never checkout material. */
  readonly runtime: OpaqueRepositoryRuntime;
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
    ) => Promise<RepositoryAgentUnverifiedResult>,
  ): Promise<RepositoryAgentRuntimeResult>;
}

/**
 * Server composition binds checkout material once, before handing the runtime
 * capability to a provider. The provider can call `run`, but cannot receive a
 * secret reference, remote URL, or filesystem path through this interface.
 */
export interface RepositoryAgentRuntimeBinder {
  bind(checkout: ConfiguredRepository): RepositoryAgentRuntime;
}

/**
 * The server-private runtime material selected by an immutable pin.  Only a
 * provider adapter receives this result, so the checkout secret reference is
 * still confined to the checkout-broker boundary.
 */
export interface ResolvedRepositoryAgentRuntime {
  readonly runtime: OpaqueRepositoryRuntime;
  readonly executor: RepositoryAgentRuntime;
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
