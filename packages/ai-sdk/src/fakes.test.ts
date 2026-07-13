import { describe, expect, it } from "vitest";

import { DeterministicAiProviderDispatcher } from "./fakes.js";

describe("DeterministicAiProviderDispatcher", () => {
  it("records only safe call metadata", async () => {
    const provider = new DeterministicAiProviderDispatcher({
      generate: async () => ({
        value: { text: "ok" },
        metadata: { retryCount: 0 },
      }),
    });

    await provider.generate({
      binding: {
        bindingVersionId: "binding-1",
        providerInstanceVersionId: "provider-version-1",
        providerType: "fake",
        endpoint: "https://example.invalid",
        canonicalModel: "fake-model",
        wireApi: "chatCompletions",
        parameters: {},
        capabilities: new Set(),
        secretReference: "vault:fake",
      },
      secret: { value: "not-recorded" },
      request: { messages: [{ role: "user", content: "not-recorded" }] },
      signal: new AbortController().signal,
    });

    expect(provider.calls).toEqual([
      { operation: "generation", bindingVersionId: "binding-1" },
    ]);
  });
});
