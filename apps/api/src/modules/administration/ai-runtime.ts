import { createHash } from "node:crypto";

import type { MeteredAiRequest } from "@caseweaver/ai-execution";
import {
  AiConfigurationError,
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
import type { ProviderCapabilityTestTemplateLookup } from "@caseweaver/postgres";
import { OpenAiCompatibleProvider } from "@caseweaver/openai-compatible";

/**
 * Composition-only dispatcher: provider type selection happens outside feature
 * packages and the browser. Adding a provider is a registry entry, not a
 * branch in administration forms or use cases.
 */
export class RegisteredAiProviderDispatcher implements AiProviderDispatcher {
  public constructor(
    private readonly providers: ReadonlyMap<string, AiProviderDispatcher>,
  ) {}

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
 * A safe open-source default for an external secret reference. Only a strict
 * `env:NAME` locator is supported by the local composition; unsupported vault
 * schemes fail closed until an installation adds its own server-side resolver.
 */
export class EnvironmentSecretResolver implements SecretResolver {
  public constructor(private readonly environment: NodeJS.ProcessEnv) {}

  public async resolve(reference: string, signal: AbortSignal) {
    if (signal.aborted)
      throw new AiConfigurationError("AI execution was cancelled.");
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

/**
 * Server-owned bounded capability-test templates. They contain neither a
 * browser prompt nor a model/endpoint/secret selection. Other registered
 * providers appear as unavailable until they contribute a template here.
 */
export function providerCapabilityTestTemplates(): ProviderCapabilityTestTemplateLookup {
  const request: MeteredAiRequest = Object.freeze({
    kind: "generation",
    role: "analysis",
    request: Object.freeze({
      messages: Object.freeze([
        Object.freeze({
          role: "user" as const,
          content: "CaseWeaver provider capability test. Reply with OK.",
        }),
      ]),
      maxOutputTokens: 4,
    }),
    maximumInputTokens: 32,
    maximumOutputTokens: 4,
    timeoutMs: 30_000,
    budget: Object.freeze({
      currency: "USD",
      hard: false,
      allowUnknownPricing: true,
    }),
  });
  const digest = createHash("sha256")
    .update(JSON.stringify(request), "utf8")
    .digest("hex");
  return Object.freeze({
    load: async ({
      providerType,
      testOperation,
    }: Readonly<{
      readonly providerType: string;
      readonly testOperation: string;
    }>) =>
      providerType === "openai-compatible" && testOperation === "provider.test"
        ? Object.freeze({ templateDigest: digest, request, timeoutMs: 30_000 })
        : undefined,
  });
}

export function registeredAiProviderDispatcher(): AiProviderDispatcher {
  return new RegisteredAiProviderDispatcher(
    new Map<string, AiProviderDispatcher>([
      ["openai-compatible", new OpenAiCompatibleProvider()],
    ]),
  );
}
