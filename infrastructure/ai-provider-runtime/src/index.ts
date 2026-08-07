import type { ImmutableAiBinding } from "@caseweaver/ai-config";
import {
  AiConfigurationError,
  type AiModelTokenizer,
  type AiModelTokenizerContribution,
  type AiProviderDispatcher,
  type AiWireApi,
  type EmbeddingRequest,
  type EmbeddingResult,
  type GenerationRequest,
  type GenerationResult,
  type ProviderDiscoveredModel,
  type ProviderInvocation,
  type ProviderModelDiscoverer,
  type ProviderResult,
  type RepositoryAgentRequest,
  type RepositoryAgentResult,
  type RepositoryChangeAgentRequest,
  type RepositoryChangeAgentResult,
  type RerankerRequest,
  type RerankerResult,
  type SecretResolver,
  type VisionRequest,
  type VisionResult,
} from "@caseweaver/ai-sdk";

/** A provider package contributes its dispatcher under a stable descriptor type. */
export interface AiProviderRuntimeContribution {
  readonly providerType: string;
  readonly dispatcher: AiProviderDispatcher;
}

/** A provider package contributes server-only model discovery under its descriptor type. */
export interface AiProviderModelDiscoveryContribution {
  readonly providerType: string;
  readonly discoverer: ProviderModelDiscoverer;
}

/**
 * Resolves an opaque credential only inside trusted composition, then delegates
 * the endpoint inventory request to the registered provider adapter. The
 * returned metadata is safe to persist as an immutable inventory; neither the
 * raw response nor a credential crosses this boundary.
 */
export class RegisteredAiProviderModelDiscovery {
  private readonly discoverers: ReadonlyMap<string, ProviderModelDiscoverer>;

  public constructor(
    contributions: readonly AiProviderModelDiscoveryContribution[],
    private readonly secretResolver: SecretResolver,
  ) {
    const registered = new Map<string, ProviderModelDiscoverer>();
    for (const contribution of contributions) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(
          contribution.providerType,
        ) ||
        registered.has(contribution.providerType)
      ) {
        throw new AiConfigurationError(
          "AI provider model discovery is invalid.",
        );
      }
      registered.set(contribution.providerType, contribution.discoverer);
    }
    this.discoverers = registered;
  }

  public async discover(
    input: Readonly<{
      readonly providerType: string;
      readonly endpoint: string;
      readonly wireApi: AiWireApi;
      readonly secretReference: string;
      readonly signal: AbortSignal;
    }>,
  ): Promise<readonly ProviderDiscoveredModel[]> {
    const discoverer = this.discoverers.get(input.providerType);
    if (discoverer === undefined) {
      throw new AiConfigurationError(
        "The configured provider cannot discover its model inventory.",
      );
    }
    const secret = await this.secretResolver.resolve(
      input.secretReference,
      input.signal,
    );
    try {
      return await discoverer.discoverModels({
        endpoint: input.endpoint,
        wireApi: input.wireApi,
        secret,
        signal: input.signal,
      });
    } finally {
      // The secret is deliberately short-lived in this scope. JavaScript cannot
      // reliably zero memory, but no field, log, DTO, or durable command keeps it.
    }
  }
}

/**
 * Server-side registry for model tokenizers. It is intentionally independent
 * of dispatch: counting a prompt must not invoke a provider or choose a
 * mutable default binding.
 */
export class RegisteredAiModelTokenizerResolver {
  private readonly contributions: ReadonlyMap<
    string,
    AiModelTokenizerContribution
  >;

  public constructor(contributions: readonly AiModelTokenizerContribution[]) {
    const registered = new Map<string, AiModelTokenizerContribution>();
    for (const contribution of contributions) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(
          contribution.providerType,
        ) ||
        registered.has(contribution.providerType)
      ) {
        throw new AiConfigurationError("AI tokenizer runtime is invalid.");
      }
      registered.set(contribution.providerType, contribution);
    }
    this.contributions = registered;
  }

  /** Resolves precisely the retained binding already read from persistence. */
  public resolve(binding: ImmutableAiBinding): AiModelTokenizer {
    const contribution = this.contributions.get(binding.providerType);
    if (contribution === undefined) {
      throw new AiConfigurationError(
        "The configured model tokenizer is unavailable.",
      );
    }
    const tokenizer = contribution.create(binding);
    if (
      tokenizer === null ||
      typeof tokenizer !== "object" ||
      typeof tokenizer.count !== "function"
    ) {
      throw new AiConfigurationError(
        "The configured model tokenizer is invalid.",
      );
    }
    return tokenizer;
  }
}

/**
 * Provider-neutral server-only dispatch registry. Provider selection remains
 * outside application features and never consults browser input beyond the
 * already validated immutable binding.
 */
export class RegisteredAiProviderDispatcher implements AiProviderDispatcher {
  private readonly providers: ReadonlyMap<string, AiProviderDispatcher>;

  public constructor(contributions: readonly AiProviderRuntimeContribution[]) {
    const providers = new Map<string, AiProviderDispatcher>();
    for (const contribution of contributions) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(
          contribution.providerType,
        ) ||
        providers.has(contribution.providerType)
      ) {
        throw new AiConfigurationError("AI provider runtime is invalid.");
      }
      providers.set(contribution.providerType, contribution.dispatcher);
    }
    this.providers = providers;
  }

  public embed(
    invocation: ProviderInvocation<EmbeddingRequest>,
  ): Promise<ProviderResult<EmbeddingResult>> {
    return this.provider(invocation).embed(invocation);
  }

  public analyzeVision(
    invocation: ProviderInvocation<VisionRequest>,
  ): Promise<ProviderResult<VisionResult>> {
    return this.provider(invocation).analyzeVision(invocation);
  }

  public generate(
    invocation: ProviderInvocation<GenerationRequest>,
  ): Promise<ProviderResult<GenerationResult>> {
    return this.provider(invocation).generate(invocation);
  }

  public rerank(
    invocation: ProviderInvocation<RerankerRequest>,
  ): Promise<ProviderResult<RerankerResult>> {
    return this.provider(invocation).rerank(invocation);
  }

  public runRepositoryAgent(
    invocation: ProviderInvocation<RepositoryAgentRequest>,
  ): Promise<ProviderResult<RepositoryAgentResult>> {
    return this.provider(invocation).runRepositoryAgent(invocation);
  }

  public runRepositoryChange(
    invocation: ProviderInvocation<RepositoryChangeAgentRequest>,
  ): Promise<ProviderResult<RepositoryChangeAgentResult>> {
    return this.provider(invocation).runRepositoryChange(invocation);
  }

  private provider(
    invocation: ProviderInvocation<unknown>,
  ): AiProviderDispatcher {
    const provider = this.providers.get(invocation.binding.providerType);
    if (provider === undefined) {
      throw new AiConfigurationError(
        "The configured AI provider is unavailable.",
      );
    }
    return provider;
  }
}

/**
 * Safe local-development resolver for opaque environment references. Its
 * regular expression deliberately rules out arbitrary process environment
 * traversal and unsupported external-secret schemes.
 */
export class EnvironmentAiSecretResolver implements SecretResolver {
  public constructor(private readonly environment: NodeJS.ProcessEnv) {}

  public async resolve(reference: string, signal: AbortSignal) {
    if (signal.aborted) {
      throw new AiConfigurationError("AI execution was cancelled.");
    }
    const match = /^env:([A-Z][A-Z0-9_]{0,127})$/u.exec(reference);
    const variableName = match?.[1];
    const value =
      variableName === undefined ? undefined : this.environment[variableName];
    if (value === undefined || value.length === 0) {
      throw new AiConfigurationError(
        "The configured AI credential is unavailable.",
      );
    }
    return Object.freeze({ value });
  }
}
