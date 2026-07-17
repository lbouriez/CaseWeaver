import {
  AiConfigurationError,
  type AiProviderBinding,
  type AiProviderDispatcher,
  AiProviderError,
  type EmbeddingRequest,
  type EmbeddingResult,
  type GenerationRequest,
  type GenerationResult,
  type NormalizedUsage,
  type PinnedRepositoryAgentRuntimeResolver,
  type ProviderInvocation,
  type ProviderResult,
  type RepositoryAgentRequest,
  type RepositoryAgentResult,
  type RepositoryAgentRuntimePin,
  type RepositoryAgentSandboxLimits,
  type RepositoryAgentToolGateway,
  type RepositoryAgentUnverifiedResult,
  type RerankerRequest,
  type RerankerResult,
  type VisionRequest,
  type VisionResult,
} from "@caseweaver/ai-sdk";

export type {
  ConfiguredRepository as AdministratorRepositorySelection,
  RepositoryAgentEvidence,
  RepositoryAgentRuntime,
  RepositoryAgentRuntimeResult,
  RepositoryAgentToolGateway,
  RepositoryReadOnlyTool as ReadOnlyRepositoryTool,
} from "@caseweaver/ai-sdk";
export * from "./administration-descriptor.js";
export * from "./copilot-sdk-byok-client.js";

export interface CopilotSdkByokClient {
  run(input: {
    readonly provider: "openai";
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly model: string;
    readonly wireApi: "completions" | "responses";
    readonly instruction: string;
    readonly maximumTurns: number;
    readonly maximumInputTokensPerTurn: number;
    readonly maximumOutputTokensPerTurn: number;
    readonly maximumAggregateInputTokens: number;
    readonly maximumAggregateOutputTokens: number;
    readonly maximumOutputBytes: number;
    readonly tools: RepositoryAgentToolGateway;
    readonly signal: AbortSignal;
  }): Promise<CopilotSdkByokResult>;
}

export interface CopilotSdkByokResult extends RepositoryAgentUnverifiedResult {
  /** Required: hard budget execution cannot price an unmetered agent run. */
  readonly usage: NormalizedUsage;
  readonly metering: Extract<
    import("@caseweaver/ai-sdk").RepositoryAgentMetering,
    { readonly mode: "observableTurns" }
  >;
  readonly requestId?: string;
  readonly effectiveModel?: string;
}

export interface CopilotSdkAgentLimits {
  readonly maximumTurns: number;
  readonly maximumCpuMilliseconds: number;
  readonly maximumMemoryBytes: number;
  readonly maximumOutputBytes: number;
  readonly maximumToolCalls: number;
  readonly timeoutMs: number;
  /**
   * A provider must be configured with a conservative aggregate token bound because
   * the Copilot SDK can hide individual turns from the execution gateway.
   */
  readonly maximumAggregateInputTokens: number;
  readonly maximumAggregateOutputTokens: number;
}

export interface CopilotSdkAgentProviderOptions {
  readonly client: CopilotSdkByokClient;
  /** Resolves one immutable server-created runtime pin for every invocation. */
  readonly runtimeResolver: PinnedRepositoryAgentRuntimeResolver;
  readonly limits: CopilotSdkAgentLimits;
  readonly now?: () => number;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AiConfigurationError(`${label} must be a positive integer.`);
  }
}

function assertLimits(limits: CopilotSdkAgentLimits): void {
  for (const [label, value] of Object.entries(limits)) {
    assertPositiveInteger(value, label);
  }
}

function assertRuntimePin(pin: RepositoryAgentRuntimePin): void {
  for (const [name, value] of Object.entries({
    workspaceId: pin.workspaceId,
    runtimeVersionId: pin.runtimeVersionId,
    repositoryId: pin.repositoryId,
  })) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 200 ||
      [...value].some((character) => {
        const code = character.codePointAt(0);
        return code === undefined || code < 32 || code === 127;
      })
    ) {
      throw new AiConfigurationError(`Repository runtime ${name} is invalid.`);
    }
  }
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(pin.pinnedCommit)) {
    throw new AiConfigurationError("Repository runtime commit is invalid.");
  }
}

function assertResolvedRuntime(
  pin: RepositoryAgentRuntimePin,
  resolved: Awaited<
    ReturnType<PinnedRepositoryAgentRuntimeResolver["resolve"]>
  >,
): void {
  if (
    resolved.runtime.repositoryId !== pin.repositoryId ||
    resolved.runtime.pinnedCommit.toLowerCase() !==
      pin.pinnedCommit.toLowerCase()
  ) {
    throw new AiConfigurationError(
      "Repository runtime resolver did not return the immutable pinned repository.",
    );
  }
  if (
    resolved.allowedTools.length === 0 ||
    new Set(resolved.allowedTools).size !== resolved.allowedTools.length ||
    resolved.allowedTools.some(
      (tool) =>
        tool !== "listFiles" && tool !== "readFile" && tool !== "searchFiles",
    )
  ) {
    throw new AiConfigurationError(
      "Repository runtime resolver returned an invalid read-only tool allowlist.",
    );
  }
  for (const [name, value] of Object.entries(resolved.limits)) {
    assertPositiveInteger(value, `repository runtime ${name}`);
  }
}

function constrainedSandboxLimits(input: {
  readonly resolved: RepositoryAgentSandboxLimits;
  readonly configured: CopilotSdkAgentLimits;
}): RepositoryAgentSandboxLimits {
  return Object.freeze({
    timeoutMs: Math.min(input.resolved.timeoutMs, input.configured.timeoutMs),
    maximumCpuMilliseconds: Math.min(
      input.resolved.maximumCpuMilliseconds,
      input.configured.maximumCpuMilliseconds,
    ),
    maximumMemoryBytes: Math.min(
      input.resolved.maximumMemoryBytes,
      input.configured.maximumMemoryBytes,
    ),
    maximumOutputBytes: Math.min(
      input.resolved.maximumOutputBytes,
      input.configured.maximumOutputBytes,
    ),
    maximumToolCalls: Math.min(
      input.resolved.maximumToolCalls,
      input.configured.maximumToolCalls,
    ),
  });
}

function safeBaseUrl(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new AiConfigurationError("Copilot BYOK endpoint must be a URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new AiConfigurationError("Copilot BYOK endpoint is unsafe.");
  }
  return url.toString().replace(/\/$/u, "");
}

function wireApi(binding: AiProviderBinding): "completions" | "responses" {
  if (binding.wireApi === "chatCompletions") return "completions";
  if (binding.wireApi === "responses") return "responses";
  throw new AiConfigurationError(
    "Copilot BYOK binding must use chat completions or responses.",
  );
}

function assertBinding(binding: AiProviderBinding): void {
  if (binding.providerType !== "copilot-sdk-agent") {
    throw new AiConfigurationError(
      "Copilot SDK agent requires its dedicated provider binding.",
    );
  }
  if (
    !binding.capabilities.has("repositoryAgent") ||
    !binding.capabilities.has("tools")
  ) {
    throw new AiConfigurationError(
      "Copilot SDK agent binding requires repository-agent and tool capabilities.",
    );
  }
  if (binding.canonicalModel.length === 0) {
    throw new AiConfigurationError("Copilot BYOK model is required.");
  }
  safeBaseUrl(binding.endpoint);
  wireApi(binding);
}

function assertUsage(
  usage: NormalizedUsage,
  maximumAggregateInputTokens: number,
  maximumAggregateOutputTokens: number,
): NormalizedUsage {
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
    throw new AiProviderError("Copilot SDK did not report complete usage.", {
      provider: "copilot-sdk-agent",
    });
  }
  for (const value of Object.values(usage)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new AiProviderError("Copilot SDK returned invalid usage.", {
        provider: "copilot-sdk-agent",
      });
    }
  }
  if (
    (usage.inputTokens ?? 0) > maximumAggregateInputTokens ||
    (usage.outputTokens ?? 0) > maximumAggregateOutputTokens
  ) {
    throw new AiProviderError(
      "Copilot SDK exceeded its aggregate token bound.",
      {
        provider: "copilot-sdk-agent",
      },
    );
  }
  return Object.freeze({ ...usage });
}

function aggregateTokenLimit(
  perTurn: number,
  maximumTurns: number,
  label: string,
): number {
  const total = perTurn * maximumTurns;
  if (!Number.isSafeInteger(total)) {
    throw new AiConfigurationError(
      `${label} exceeds the maximum safe aggregate token limit.`,
    );
  }
  return total;
}

/**
 * A narrow BYOK-only adapter. The injected client is responsible for calling the
 * Copilot SDK, while this class intentionally exposes no GitHub authentication,
 * subscription, checkout, or fallback configuration.
 */
export class CopilotSdkAgentProvider implements AiProviderDispatcher {
  private readonly now: () => number;

  public constructor(private readonly options: CopilotSdkAgentProviderOptions) {
    assertLimits(options.limits);
    this.now = options.now ?? Date.now;
  }

  public async runRepositoryAgent(
    invocation: ProviderInvocation<RepositoryAgentRequest>,
  ): Promise<ProviderResult<RepositoryAgentResult>> {
    return this.runPinnedRepositoryAgent(invocation);
  }

  public embed(
    _invocation: ProviderInvocation<EmbeddingRequest>,
  ): Promise<ProviderResult<EmbeddingResult>> {
    return this.unsupported();
  }

  public analyzeVision(
    _invocation: ProviderInvocation<VisionRequest>,
  ): Promise<ProviderResult<VisionResult>> {
    return this.unsupported();
  }

  public generate(
    _invocation: ProviderInvocation<GenerationRequest>,
  ): Promise<ProviderResult<GenerationResult>> {
    return this.unsupported();
  }

  public rerank(
    _invocation: ProviderInvocation<RerankerRequest>,
  ): Promise<ProviderResult<RerankerResult>> {
    return this.unsupported();
  }

  private unsupported(): never {
    throw new AiConfigurationError(
      "Copilot SDK agent only supports repository-agent execution.",
    );
  }

  /**
   * Reads only the required immutable request pin, so no fixed repository or
   * mutable-current configuration can enter the provider path.
   */
  private async runPinnedRepositoryAgent(
    invocation: ProviderInvocation<RepositoryAgentRequest>,
  ): Promise<ProviderResult<RepositoryAgentResult>> {
    const runtimePin = invocation.request.runtimePin;
    assertRuntimePin(runtimePin);
    assertBinding(invocation.binding);
    assertPositiveInteger(invocation.request.maximumTurns, "maximumTurns");
    assertPositiveInteger(
      invocation.request.maximumInputTokensPerTurn,
      "maximumInputTokensPerTurn",
    );
    assertPositiveInteger(
      invocation.request.maximumOutputTokensPerTurn,
      "maximumOutputTokensPerTurn",
    );
    if (invocation.request.maximumTurns > this.options.limits.maximumTurns) {
      throw new AiConfigurationError(
        "Repository-agent request exceeds its configured turn limit.",
      );
    }
    const maximumAggregateInputTokens = aggregateTokenLimit(
      invocation.request.maximumInputTokensPerTurn,
      invocation.request.maximumTurns,
      "Repository-agent input",
    );
    const maximumAggregateOutputTokens = aggregateTokenLimit(
      invocation.request.maximumOutputTokensPerTurn,
      invocation.request.maximumTurns,
      "Repository-agent output",
    );
    if (
      maximumAggregateInputTokens >
        this.options.limits.maximumAggregateInputTokens ||
      maximumAggregateOutputTokens >
        this.options.limits.maximumAggregateOutputTokens
    ) {
      throw new AiConfigurationError(
        "Repository-agent request exceeds its configured aggregate token limit.",
      );
    }
    if (invocation.secret.value.length === 0) {
      throw new AiConfigurationError("Copilot BYOK credential is empty.");
    }
    const resolvedRuntime = await this.options.runtimeResolver.resolve(
      runtimePin,
      invocation.signal,
    );
    assertResolvedRuntime(runtimePin, resolvedRuntime);
    const sandboxLimits = constrainedSandboxLimits({
      resolved: resolvedRuntime.limits,
      configured: this.options.limits,
    });
    const started = this.now();
    try {
      let clientResult: CopilotSdkByokResult | undefined;
      const result = await resolvedRuntime.executor.run(
        {
          runtime: resolvedRuntime.runtime,
          instruction: invocation.request.instruction,
          allowedTools: resolvedRuntime.allowedTools,
          limits: sandboxLimits,
          signal: invocation.signal,
        },
        async (context) => {
          clientResult = await this.options.client.run({
            provider: "openai",
            baseUrl: safeBaseUrl(invocation.binding.endpoint),
            apiKey: invocation.secret.value,
            model: invocation.binding.canonicalModel,
            wireApi: wireApi(invocation.binding),
            instruction: invocation.request.instruction,
            maximumTurns: invocation.request.maximumTurns,
            maximumInputTokensPerTurn:
              invocation.request.maximumInputTokensPerTurn,
            maximumOutputTokensPerTurn:
              invocation.request.maximumOutputTokensPerTurn,
            maximumAggregateInputTokens,
            maximumAggregateOutputTokens,
            maximumOutputBytes: sandboxLimits.maximumOutputBytes,
            tools: context.tools,
            signal: context.signal,
          });
          return clientResult;
        },
      );
      if (clientResult === undefined) {
        throw new AiProviderError("Copilot SDK did not return a result.", {
          provider: "copilot-sdk-agent",
        });
      }
      const usage = assertUsage(
        clientResult.usage,
        maximumAggregateInputTokens,
        maximumAggregateOutputTokens,
      );
      return {
        value: {
          summary: result.summary,
          evidence: Object.freeze([...result.evidence]),
          findings: Object.freeze([...result.findings]),
          metering: clientResult.metering,
        },
        usage,
        metadata: {
          ...(clientResult.requestId === undefined
            ? {}
            : { providerRequestId: clientResult.requestId }),
          ...(clientResult.effectiveModel === undefined
            ? {}
            : { effectiveModel: clientResult.effectiveModel }),
          latencyMs: Math.max(0, this.now() - started),
          retryCount: 0,
          rawRedacted: {
            evidenceCount: result.evidence.length,
            findingCount: result.findings.length,
          },
        },
      };
    } catch (cause) {
      if (invocation.signal.aborted) throw cause;
      if (
        cause instanceof AiConfigurationError ||
        cause instanceof AiProviderError
      ) {
        throw cause;
      }
      throw new AiProviderError(
        "Copilot SDK BYOK repository-agent execution failed.",
        { provider: "copilot-sdk-agent", retryable: true },
        cause,
      );
    }
  }
}
