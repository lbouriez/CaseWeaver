import { describe, expect, it, vi } from "vitest";

import { OpenAiCompatibleModelDiscoverer } from "./model-discovery.js";

describe("OpenAiCompatibleModelDiscoverer", () => {
  it("normalizes a bounded OpenAI-compatible inventory without retaining provider response fields", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "openai/gpt-4o",
                architecture: {
                  input_modalities: ["text", "image"],
                  output_modalities: ["text"],
                },
                supported_parameters: ["tools", "structured_outputs"],
                context_length: 128000,
                top_provider: { max_completion_tokens: 16384 },
                private_account_field: "must-not-survive",
              },
              {
                id: "openai/text-embedding-3-small",
                architecture: { output_modalities: ["embeddings"] },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const discoverer = new OpenAiCompatibleModelDiscoverer({ fetch });

    await expect(
      discoverer.discoverModels({
        endpoint: "https://openrouter.ai/api/v1",
        wireApi: "chatCompletions",
        secret: { value: "never-persist-or-return" },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual([
      {
        canonicalModel: "openai/gpt-4o",
        supportedRoles: ["analysis", "chat", "keywordExtraction", "vision"],
        capabilities: ["tools", "structuredOutput", "vision"],
        maximumInputTokens: 128000,
        maximumOutputTokens: 16384,
      },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("fails safely for a rejected or malformed inventory without surfacing provider body text", async () => {
    const discoverer = new OpenAiCompatibleModelDiscoverer({
      fetch: async () =>
        new Response('{"error":"credential-or-account-detail"}', {
          status: 401,
        }),
    });
    const failure = await discoverer
      .discoverModels({
        endpoint: "https://provider.example/v1",
        wireApi: "embeddings",
        secret: { value: "secret" },
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      message: "The OpenAI-compatible model inventory was rejected.",
    });
    expect(JSON.stringify(failure)).not.toContain(
      "credential-or-account-detail",
    );
  });

  it("requests the provider's embedding inventory instead of accepting a text-only default model list", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "openai/text-embedding-3-small",
                architecture: { output_modalities: ["embeddings"] },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const discoverer = new OpenAiCompatibleModelDiscoverer({ fetch });

    await expect(
      discoverer.discoverModels({
        endpoint: "https://openrouter.ai/api/v1",
        wireApi: "embeddings",
        secret: { value: "never-persist-or-return" },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual([
      {
        canonicalModel: "openai/text-embedding-3-small",
        supportedRoles: ["embedding"],
        capabilities: [],
      },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models?output_modalities=embeddings",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects an insecure discovery endpoint before sending its credential", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const discoverer = new OpenAiCompatibleModelDiscoverer({ fetch });

    await expect(
      discoverer.discoverModels({
        endpoint: "http://localhost:4000/v1",
        wireApi: "embeddings",
        secret: { value: "must-not-be-sent" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      message: "OpenAI-compatible endpoint is unsafe.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
