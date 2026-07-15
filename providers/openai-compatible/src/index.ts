import {
  AiConfigurationError,
  type AiProviderDispatcher,
  AiProviderError,
  type EmbeddingRequest,
  type EmbeddingResult,
  type GenerationRequest,
  type GenerationResult,
  type NormalizedUsage,
  type ProviderInvocation,
  type ProviderReportedCost,
  type ProviderResponseMetadata,
  type ProviderResult,
  type RepositoryAgentRequest,
  type RepositoryAgentResult,
  type RerankerRequest,
  type RerankerResult,
  type VisionRequest,
  type VisionResult,
} from "@caseweaver/ai-sdk";

export * from "./administration-descriptor.js";
import { z } from "zod";

const recordSchema = z.record(z.string(), z.unknown());
const embeddingResponseSchema = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number().finite()),
    }),
  ),
  model: z.string().optional(),
  usage: recordSchema.optional(),
});
const completionResponseSchema = z.object({
  model: z.string().optional(),
  choices: z.array(
    z.object({
      finish_reason: z.string().nullable().optional(),
      message: z
        .object({
          content: z
            .union([z.string(), z.array(z.unknown()), z.null()])
            .optional(),
        })
        .optional(),
    }),
  ),
  usage: recordSchema.optional(),
});
const responsesApiSchema = z.object({
  model: z.string().optional(),
  output_text: z.string().optional(),
  output: z.array(z.unknown()).optional(),
  usage: recordSchema.optional(),
});

export interface OpenAiCompatibleProviderOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

function asSafeUsage(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AiProviderError("The provider returned invalid usage.", {
      provider: "openai-compatible",
    });
  }
  return value as number;
}

function nested(
  source: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const value = source[key];
  return recordSchema.safeParse(value).success
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function normalizeUsage(
  value: Readonly<Record<string, unknown>> | undefined,
): NormalizedUsage | undefined {
  if (value === undefined) return undefined;
  const inputDetails = nested(value, "prompt_tokens_details");
  const outputDetails = nested(value, "completion_tokens_details");
  const responseInputDetails = nested(value, "input_tokens_details");
  const responseOutputDetails = nested(value, "output_tokens_details");
  return Object.freeze({
    inputTokens: asSafeUsage(value.prompt_tokens ?? value.input_tokens),
    outputTokens: asSafeUsage(value.completion_tokens ?? value.output_tokens),
    cacheReadInputTokens: asSafeUsage(
      inputDetails.cached_tokens ?? responseInputDetails.cached_tokens,
    ),
    cacheCreationInputTokens: asSafeUsage(
      inputDetails.cache_creation_input_tokens ??
        responseInputDetails.cache_creation_input_tokens,
    ),
    reasoningTokens: asSafeUsage(
      outputDetails.reasoning_tokens ?? responseOutputDetails.reasoning_tokens,
    ),
  });
}

function providerCost(
  value: Readonly<Record<string, unknown>>,
): ProviderReportedCost | undefined {
  const raw = recordSchema.safeParse(value.cost);
  if (!raw.success) return undefined;
  const amount = raw.data.amount;
  const currency = raw.data.currency;
  if (
    (typeof amount !== "number" && typeof amount !== "string") ||
    typeof currency !== "string" ||
    !/^[A-Z]{3}$/.test(currency) ||
    (typeof amount === "number" && (!Number.isFinite(amount) || amount < 0)) ||
    (typeof amount === "string" && !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount))
  ) {
    return undefined;
  }
  return Object.freeze({ amount: String(amount), currency });
}

function joinEndpoint(endpoint: string, path: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new AiConfigurationError("OpenAI-compatible endpoint must be a URL.");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new AiConfigurationError("OpenAI-compatible endpoint is unsafe.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path}`;
  return url.toString();
}

function parameters(
  invocation: ProviderInvocation<unknown>,
): Readonly<Record<string, unknown>> {
  const parsed = recordSchema.safeParse(invocation.binding.parameters);
  if (!parsed.success) {
    throw new AiConfigurationError(
      "OpenAI-compatible parameters must be an object.",
    );
  }
  const temperature = parsed.data.temperature;
  if (
    temperature !== undefined &&
    (typeof temperature !== "number" ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2)
  ) {
    throw new AiConfigurationError("OpenAI-compatible temperature is invalid.");
  }
  return parsed.data;
}

function textFromContent(value: string | unknown[] | null | undefined): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  const texts = value.flatMap((part) => {
    const candidate = recordSchema.safeParse(part);
    if (!candidate.success || typeof candidate.data.text !== "string")
      return [];
    return [candidate.data.text];
  });
  return texts.join("");
}

function textFromResponsesOutput(
  output: readonly unknown[] | undefined,
): string {
  if (output === undefined) return "";
  const texts: string[] = [];
  for (const item of output) {
    const record = recordSchema.safeParse(item);
    if (!record.success) continue;
    const content = recordSchema.safeParse(record.data.content);
    if (!content.success || !Array.isArray(record.data.content)) continue;
    for (const part of record.data.content) {
      const partRecord = recordSchema.safeParse(part);
      if (partRecord.success && typeof partRecord.data.text === "string") {
        texts.push(partRecord.data.text);
      }
    }
  }
  return texts.join("");
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export class OpenAiCompatibleProvider implements AiProviderDispatcher {
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => number;

  public constructor(options: OpenAiCompatibleProviderOptions = {}) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  public async embed(
    invocation: ProviderInvocation<EmbeddingRequest>,
  ): Promise<ProviderResult<EmbeddingResult>> {
    if (invocation.binding.wireApi !== "embeddings") {
      throw new AiConfigurationError(
        "Embedding binding must use the embeddings wire API.",
      );
    }
    if (invocation.request.input.length === 0) {
      throw new AiConfigurationError("Embedding input cannot be empty.");
    }
    const response = await this.post(invocation, "embeddings", {
      model: invocation.binding.canonicalModel,
      input: invocation.request.input,
      ...(invocation.request.dimensions === undefined
        ? {}
        : { dimensions: invocation.request.dimensions }),
    });
    const parsed = embeddingResponseSchema.safeParse(response.body);
    if (!parsed.success) throw this.invalidResponse();
    return {
      value: {
        vectors: parsed.data.data.map((item) => Object.freeze(item.embedding)),
      },
      usage: normalizeUsage(parsed.data.usage),
      providerCost: providerCost(response.body),
      metadata: response.metadata(parsed.data.model),
    };
  }

  public async analyzeVision(
    invocation: ProviderInvocation<VisionRequest>,
  ): Promise<ProviderResult<VisionResult>> {
    if (invocation.binding.wireApi !== "chatCompletions") {
      throw new AiConfigurationError(
        "Vision binding must use chat completions.",
      );
    }
    if (invocation.request.images.length === 0) {
      throw new AiConfigurationError(
        "Vision request requires at least one image.",
      );
    }
    const response = await this.post(
      invocation,
      "chat/completions",
      this.chatCompletionBody(
        invocation,
        [
          {
            role: "user",
            content: [
              { type: "text", text: invocation.request.prompt },
              ...invocation.request.images.map((image) => ({
                type: "image_url",
                image_url: { url: image.url },
              })),
            ],
          },
        ],
        invocation.request.maxOutputTokens,
        undefined,
      ),
    );
    return this.completionResult(response, "vision");
  }

  public async generate(
    invocation: ProviderInvocation<GenerationRequest>,
  ): Promise<ProviderResult<GenerationResult>> {
    if (invocation.binding.wireApi === "chatCompletions") {
      const response = await this.post(
        invocation,
        "chat/completions",
        this.chatCompletionBody(
          invocation,
          invocation.request.messages,
          invocation.request.maxOutputTokens,
          invocation.request.responseFormat,
        ),
      );
      return this.completionResult(response, "generation");
    }
    if (invocation.binding.wireApi !== "responses") {
      throw new AiConfigurationError(
        "Generation binding has an unsupported wire API.",
      );
    }
    const response = await this.post(invocation, "responses", {
      model: invocation.binding.canonicalModel,
      input: invocation.request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      ...(invocation.request.maxOutputTokens === undefined
        ? {}
        : { max_output_tokens: invocation.request.maxOutputTokens }),
      ...(invocation.request.responseFormat === "jsonObject"
        ? { text: { format: { type: "json_object" } } }
        : {}),
    });
    const parsed = responsesApiSchema.safeParse(response.body);
    if (!parsed.success) throw this.invalidResponse();
    return {
      value: {
        text:
          parsed.data.output_text ??
          textFromResponsesOutput(parsed.data.output),
      },
      usage: normalizeUsage(parsed.data.usage),
      providerCost: providerCost(response.body),
      metadata: response.metadata(parsed.data.model),
    };
  }

  public async rerank(
    _invocation: ProviderInvocation<RerankerRequest>,
  ): Promise<ProviderResult<RerankerResult>> {
    throw new AiConfigurationError(
      "The OpenAI-compatible adapter does not implement reranking.",
    );
  }

  public async runRepositoryAgent(
    _invocation: ProviderInvocation<RepositoryAgentRequest>,
  ): Promise<ProviderResult<RepositoryAgentResult>> {
    throw new AiConfigurationError(
      "The OpenAI-compatible adapter does not implement repository agents.",
    );
  }

  private chatCompletionBody(
    invocation: ProviderInvocation<unknown>,
    messages: readonly unknown[],
    maxOutputTokens: number | undefined,
    responseFormat: GenerationRequest["responseFormat"] | undefined,
  ): Readonly<Record<string, unknown>> {
    const configured = parameters(invocation);
    return {
      model: invocation.binding.canonicalModel,
      messages,
      ...(maxOutputTokens === undefined ? {} : { max_tokens: maxOutputTokens }),
      ...(configured.temperature === undefined
        ? {}
        : { temperature: configured.temperature }),
      ...(responseFormat === "jsonObject"
        ? { response_format: { type: "json_object" } }
        : {}),
    };
  }

  private completionResult(
    response: {
      readonly body: Readonly<Record<string, unknown>>;
      readonly metadata: (model?: string) => ProviderResponseMetadata;
    },
    _purpose: string,
  ): ProviderResult<GenerationResult> {
    const parsed = completionResponseSchema.safeParse(response.body);
    if (!parsed.success || parsed.data.choices[0] === undefined) {
      throw this.invalidResponse();
    }
    const choice = parsed.data.choices[0];
    return {
      value: {
        text: textFromContent(choice.message?.content),
        ...(choice.finish_reason === undefined || choice.finish_reason === null
          ? {}
          : { finishReason: choice.finish_reason }),
      },
      usage: normalizeUsage(parsed.data.usage),
      providerCost: providerCost(response.body),
      metadata: response.metadata(parsed.data.model),
    };
  }

  private async post(
    invocation: ProviderInvocation<unknown>,
    path: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<{
    readonly body: Readonly<Record<string, unknown>>;
    readonly metadata: (model?: string) => ProviderResponseMetadata;
  }> {
    if (invocation.secret.value.length === 0) {
      throw new AiConfigurationError("OpenAI-compatible credential is empty.");
    }
    const started = this.now();
    let response: Response;
    try {
      response = await this.fetchImplementation(
        joinEndpoint(invocation.binding.endpoint, path),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${invocation.secret.value}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: invocation.signal,
        },
      );
    } catch (cause) {
      if (invocation.signal.aborted) throw cause;
      throw new AiProviderError(
        "The OpenAI-compatible endpoint could not be reached.",
        { retryable: true, provider: "openai-compatible" },
        cause,
      );
    }
    const latencyMs = Math.max(0, this.now() - started);
    const text = await response.text();
    if (text.length > 1_000_000) {
      throw new AiProviderError(
        "The provider response exceeded the safe size limit.",
        {
          provider: "openai-compatible",
        },
      );
    }
    let responseBody: unknown = {};
    if (text.length > 0) {
      try {
        responseBody = JSON.parse(text);
      } catch {
        if (response.ok) throw this.invalidResponse();
      }
    }
    const bodyRecord = recordSchema.safeParse(responseBody);
    if (!response.ok) {
      throw new AiProviderError(
        "The OpenAI-compatible endpoint rejected the request.",
        {
          provider: "openai-compatible",
          retryable: response.status === 429 || response.status >= 500,
          statusCode: response.status,
          retryAfterMs: retryAfterMilliseconds(
            response.headers.get("retry-after"),
          ),
        },
      );
    }
    if (!bodyRecord.success) throw this.invalidResponse();
    const requestId =
      response.headers.get("x-request-id") ??
      response.headers.get("request-id") ??
      undefined;
    return {
      body: bodyRecord.data,
      metadata: (model) => ({
        ...(requestId === undefined ? {} : { providerRequestId: requestId }),
        ...(model === undefined ? {} : { effectiveModel: model }),
        latencyMs,
        retryCount: 0,
        rawRedacted: { statusCode: response.status },
      }),
    };
  }

  private invalidResponse(): AiProviderError {
    return new AiProviderError(
      "The provider response did not match its contract.",
      {
        provider: "openai-compatible",
      },
    );
  }
}
