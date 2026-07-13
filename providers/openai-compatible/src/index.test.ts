import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AiProviderBinding, AiProviderError } from "@caseweaver/ai-sdk";
import { describe, expect, it } from "vitest";

import { OpenAiCompatibleProvider } from "./index.js";

function binding(wireApi: AiProviderBinding["wireApi"]): AiProviderBinding {
  return {
    bindingVersionId: "binding-1",
    providerInstanceVersionId: "provider-version-1",
    providerType: "openai-compatible",
    endpoint: "https://models.example/v1",
    canonicalModel: "model-1",
    wireApi,
    parameters: { temperature: 0 },
    capabilities: new Set(["vision"]),
    secretReference: "vault:models",
  };
}

function fixtureFetch(body: unknown, headers: Record<string, string> = {}) {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "x-request-id": "request-1", ...headers },
    });
}

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(resolve(process.cwd(), "src", "fixtures", name), "utf8"),
  ) as unknown;
}

describe("OpenAiCompatibleProvider", () => {
  it("normalizes recorded embedding usage and request metadata", async () => {
    const provider = new OpenAiCompatibleProvider({
      fetch: fixtureFetch(await fixture("embedding.json")),
      now: () => 5,
    });

    const result = await provider.embed({
      binding: binding("embeddings"),
      secret: { value: "secret" },
      request: { input: ["fixture input"] },
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      value: { vectors: [[0.1, 0.2]] },
      usage: { inputTokens: 5, cacheReadInputTokens: 2 },
      metadata: {
        providerRequestId: "request-1",
        effectiveModel: "effective-embedding",
      },
    });
  });

  it("normalizes recorded vision and generation fixtures for both wire APIs", async () => {
    const chatProvider = new OpenAiCompatibleProvider({
      fetch: fixtureFetch(await fixture("vision.json")),
    });
    const vision = await chatProvider.analyzeVision({
      binding: binding("chatCompletions"),
      secret: { value: "secret" },
      request: {
        prompt: "fixture image",
        images: [{ url: "https://image.example/1" }],
      },
      signal: new AbortController().signal,
    });
    expect(vision).toMatchObject({
      value: { text: "fixture answer", finishReason: "stop" },
      usage: { inputTokens: 3, outputTokens: 4, reasoningTokens: 1 },
    });

    const responsesProvider = new OpenAiCompatibleProvider({
      fetch: fixtureFetch(await fixture("generation-responses.json")),
    });
    await expect(
      responsesProvider.generate({
        binding: binding("responses"),
        secret: { value: "secret" },
        request: { messages: [{ role: "user", content: "fixture" }] },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      value: { text: "structured fixture" },
      usage: { inputTokens: 2, outputTokens: 1 },
    });
  });

  it("maps rate limits and passes cancellation to fetch without exposing response data", async () => {
    const rateLimited = new OpenAiCompatibleProvider({
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "not retained" } }), {
          status: 429,
          headers: { "retry-after": "2" },
        }),
    });
    await expect(
      rateLimited.embed({
        binding: binding("embeddings"),
        secret: { value: "secret" },
        request: { input: ["fixture"] },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject<Partial<AiProviderError>>({
      code: "ai.provider",
      retryable: true,
      details: { retryAfterMs: 2_000, statusCode: 429 },
    });

    const controller = new AbortController();
    const aborted = new OpenAiCompatibleProvider({
      fetch: async (_url, init) => {
        expect(init?.signal).toBe(controller.signal);
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
    });
    await expect(
      aborted.embed({
        binding: binding("embeddings"),
        secret: { value: "secret" },
        request: { input: ["fixture"] },
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
  });
});
