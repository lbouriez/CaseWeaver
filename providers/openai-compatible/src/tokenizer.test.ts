import type { AiProviderBinding } from "@caseweaver/ai-sdk";
import { describe, expect, it } from "vitest";

import { openAiCompatibleTokenizerContribution } from "./tokenizer.js";

function binding(
  parameters: Readonly<Record<string, unknown>>,
): AiProviderBinding {
  return {
    bindingVersionId: "analysis-binding:1",
    providerInstanceVersionId: "provider-version:1",
    providerType: "openai-compatible",
    endpoint: "https://models.example/v1",
    canonicalModel: "deployment-owned-model",
    wireApi: "chatCompletions",
    parameters,
    capabilities: new Set(),
    secretReference: "env:MODEL_TOKEN",
  };
}

describe("OpenAI-compatible tokenizer contribution", () => {
  it("counts with the binding's explicit retained encoding", () => {
    const tokenizer = openAiCompatibleTokenizerContribution.create(
      binding({ tokenizerEncoding: "cl100k_base" }),
    );
    expect(tokenizer.count("CaseWeaver token accounting.")).toBeGreaterThan(0);
  });

  it("refuses a missing or unsupported encoding instead of guessing", () => {
    expect(() =>
      openAiCompatibleTokenizerContribution.create(binding({})),
    ).toThrow("immutable tokenizer encoding");
    expect(() =>
      openAiCompatibleTokenizerContribution.create(
        binding({ tokenizerEncoding: "unknown" }),
      ),
    ).toThrow("immutable tokenizer encoding");
  });
});
