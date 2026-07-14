import {
  AiConfigurationError,
  type AiProviderBinding,
  AiProviderError,
  type ConfiguredRepository,
  type NormalizedUsage,
  type ProviderInvocation,
  type ProviderResult,
  type RepositoryAgentProvider,
  type RepositoryAgentRequest,
  type RepositoryAgentResult,
  type RepositoryAgentRuntime,
  type RepositoryAgentRuntimeResult,
  type RepositoryAgentToolGateway,
  type RepositoryReadOnlyTool,
} from "@caseweaver/ai-sdk";

export type {
  ConfiguredRepository as AdministratorRepositorySelection,
  RepositoryAgentEvidence,
  RepositoryAgentRuntime,
  RepositoryAgentRuntimeResult,
  RepositoryAgentToolGateway,
  RepositoryReadOnlyTool as ReadOnlyRepositoryTool,
} from "@caseweaver/ai-sdk";

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
    readonly tools: RepositoryAgentToolGateway;
    readonly signal: AbortSignal;
  }): Promise<CopilotSdkByokResult>;
}

export interface CopilotSdkByokResult
  extends RepositoryAgentRuntimeResult,
    RepositoryAgentResult {
  readonly usage?: NormalizedUsage;
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
  readonly runtime: RepositoryAgentRuntime;
  readonly client: CopilotSdkByokClient;
  readonly repository: ConfiguredRepository;
  readonly limits: CopilotSdkAgentLimits;
  readonly allowedTools?: readonly RepositoryReadOnlyTool[];
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
  usage: NormalizedUsage | undefined,
  maximumAggregateInputTokens: number,
  maximumAggregateOutputTokens: number,
): NormalizedUsage | undefined {
  if (usage === undefined) return undefined;
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
export class CopilotSdkAgentProvider implements RepositoryAgentProvider {
  private readonly allowedTools: readonly RepositoryReadOnlyTool[];
  private readonly now: () => number;

  public constructor(private readonly options: CopilotSdkAgentProviderOptions) {
    assertLimits(options.limits);
    this.allowedTools = options.allowedTools ?? [
      "listFiles",
      "readFile",
      "searchFiles",
    ];
    if (
      this.allowedTools.length === 0 ||
      new Set(this.allowedTools).size !== this.allowedTools.length
    ) {
      throw new AiConfigurationError(
        "Copilot SDK agent requires a non-empty unique read-only tool allowlist.",
      );
    }
    this.now = options.now ?? Date.now;
  }

  public async runRepositoryAgent(
    invocation: ProviderInvocation<RepositoryAgentRequest>,
  ): Promise<ProviderResult<RepositoryAgentResult>> {
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
    const started = this.now();
    try {
      let clientResult: CopilotSdkByokResult | undefined;
      const result = await this.options.runtime.run(
        {
          repository: this.options.repository,
          instruction: invocation.request.instruction,
          allowedTools: this.allowedTools,
          limits: {
            timeoutMs: this.options.limits.timeoutMs,
            maximumCpuMilliseconds: this.options.limits.maximumCpuMilliseconds,
            maximumMemoryBytes: this.options.limits.maximumMemoryBytes,
            maximumOutputBytes: this.options.limits.maximumOutputBytes,
            maximumToolCalls: this.options.limits.maximumToolCalls,
          },
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
            tools: context.tools,
            signal: invocation.signal,
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
        value: { summary: result.summary, metering: clientResult.metering },
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
          rawRedacted: { evidenceCount: result.evidence.length },
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
