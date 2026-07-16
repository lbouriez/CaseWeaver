import {
  AiConfigurationError,
  type AiModelTokenizer,
  type AiModelTokenizerContribution,
  type AiProviderDispatcher,
  type EmbeddingRequest,
  type EmbeddingResult,
  type GenerationRequest,
  type GenerationResult,
  type ProviderInvocation,
  type ProviderResult,
  type RepositoryAgentRequest,
  type RepositoryAgentResult,
  type RerankerRequest,
  type RerankerResult,
  type SecretResolver,
  type VisionRequest,
  type VisionResult,
} from "@caseweaver/ai-sdk";
import type { ImmutableAiBinding } from "@caseweaver/ai-config";

/** A provider package contributes its dispatcher under a stable descriptor type. */
export interface AiProviderRuntimeContribution {
  readonly providerType: string;
  readonly dispatcher: AiProviderDispatcher;
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
