import { createHash } from "node:crypto";

import type { MeteredAiRequest } from "@caseweaver/ai-execution";
import {
  type AiProviderRuntimeContribution,
  EnvironmentAiSecretResolver,
  RegisteredAiProviderDispatcher,
  RegisteredAiProviderModelDiscovery,
} from "@caseweaver/ai-provider-runtime";
import {
  OpenAiCompatibleModelDiscoverer,
  OpenAiCompatibleProvider,
} from "@caseweaver/openai-compatible";
import type { ProviderCapabilityTestTemplateLookup } from "@caseweaver/postgres";

/** Backward-compatible API composition name; implementation is reusable host code. */
export { EnvironmentAiSecretResolver as EnvironmentSecretResolver };

/**
 * Server-owned bounded capability-test templates. They contain neither a
 * browser prompt nor a model/endpoint/secret selection. Other registered
 * providers appear as unavailable until they contribute a template here.
 */
export function providerCapabilityTestTemplates(): ProviderCapabilityTestTemplateLookup {
  const generationRequest: MeteredAiRequest = Object.freeze({
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
  const embeddingRequest: MeteredAiRequest = Object.freeze({
    kind: "embedding",
    role: "embedding",
    request: Object.freeze({
      input: Object.freeze(["CaseWeaver provider capability test."]),
    }),
    maximumInputTokens: 16,
    timeoutMs: 30_000,
    budget: Object.freeze({
      currency: "USD",
      hard: false,
      allowUnknownPricing: true,
    }),
  });
  const template = (request: MeteredAiRequest) =>
    Object.freeze({
      templateDigest: createHash("sha256")
        .update(JSON.stringify(request), "utf8")
        .digest("hex"),
      request,
      timeoutMs: 30_000,
    });
  return Object.freeze({
    load: async ({
      providerType,
      testOperation,
      wireApi,
    }: Readonly<{
      readonly providerType: string;
      readonly testOperation: string;
      readonly wireApi: string;
    }>) =>
      providerType === "openai-compatible" && testOperation === "provider.test"
        ? template(
            wireApi === "embeddings" ? embeddingRequest : generationRequest,
          )
        : undefined,
  });
}

export function registeredAiProviderDispatcher(): RegisteredAiProviderDispatcher {
  const contributions: readonly AiProviderRuntimeContribution[] = [
    {
      providerType: "openai-compatible",
      dispatcher: new OpenAiCompatibleProvider(),
    },
  ];
  return new RegisteredAiProviderDispatcher(contributions);
}

/**
 * Provider inventory composition is deliberately independent of execution:
 * it performs only a bounded metadata request using an opaque secret resolved
 * in this trusted layer. Feature code and the browser never receive that
 * resolver or choose an endpoint/model-discovery implementation.
 */
export function registeredAiProviderModelDiscovery(
  environment: NodeJS.ProcessEnv,
): RegisteredAiProviderModelDiscovery {
  return new RegisteredAiProviderModelDiscovery(
    [
      {
        providerType: "openai-compatible",
        discoverer: new OpenAiCompatibleModelDiscoverer(),
      },
    ],
    new EnvironmentAiSecretResolver(environment),
  );
}
