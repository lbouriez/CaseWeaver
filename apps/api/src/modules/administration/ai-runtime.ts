import { createHash } from "node:crypto";

import type { MeteredAiRequest } from "@caseweaver/ai-execution";
import {
  type AiProviderRuntimeContribution,
  EnvironmentAiSecretResolver,
  RegisteredAiProviderDispatcher,
} from "@caseweaver/ai-provider-runtime";
import { OpenAiCompatibleProvider } from "@caseweaver/openai-compatible";
import type { ProviderCapabilityTestTemplateLookup } from "@caseweaver/postgres";

/** Backward-compatible API composition name; implementation is reusable host code. */
export { EnvironmentAiSecretResolver as EnvironmentSecretResolver };

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

export function registeredAiProviderDispatcher(): RegisteredAiProviderDispatcher {
  const contributions: readonly AiProviderRuntimeContribution[] = [
    {
      providerType: "openai-compatible",
      dispatcher: new OpenAiCompatibleProvider(),
    },
  ];
  return new RegisteredAiProviderDispatcher(contributions);
}
