import {
  AiConfigurationError,
  AiProviderError,
  type ProviderDiscoveredModel,
  type ProviderModelDiscoverer,
  type ProviderModelDiscoveryInvocation,
} from "@caseweaver/ai-sdk";
import { z } from "zod";

const recordSchema = z.record(z.string(), z.unknown());
const modelListSchema = z.object({
  data: z.array(recordSchema).max(2_000),
});

export interface OpenAiCompatibleModelDiscovererOptions {
  readonly fetch?: typeof fetch;
}

function endpointForModels(
  endpoint: string,
  wireApi: ProviderModelDiscoveryInvocation["wireApi"],
): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new AiConfigurationError("OpenAI-compatible endpoint must be a URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new AiConfigurationError("OpenAI-compatible endpoint is unsafe.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  // OpenRouter's generic `/models` response defaults to text output. Its
  // documented modality filter is also safe for compatible endpoints that
  // ignore unknown query parameters, and it makes an immutable embeddings
  // instance discover the endpoint's embedding models rather than silently
  // treating a text-only default response as the complete inventory.
  if (wireApi === "embeddings") {
    url.searchParams.set("output_modalities", "embeddings");
  }
  return url.toString();
}

function strings(value: unknown, maximum: number): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0 && item.length <= 120)
      .slice(0, maximum),
  );
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : undefined;
}

function modelFrom(
  entry: Readonly<Record<string, unknown>>,
  wireApi: ProviderModelDiscoveryInvocation["wireApi"],
): ProviderDiscoveredModel | undefined {
  const canonicalModel = entry.id;
  if (
    typeof canonicalModel !== "string" ||
    canonicalModel.trim().length === 0 ||
    canonicalModel.length > 500 ||
    hasControlCharacter(canonicalModel)
  ) {
    return undefined;
  }
  const architecture = recordSchema.safeParse(entry.architecture).success
    ? (entry.architecture as Readonly<Record<string, unknown>>)
    : undefined;
  const outputModalities = strings(architecture?.output_modalities, 12);
  const inputModalities = strings(architecture?.input_modalities, 12);
  // A provider may expose only the minimal OpenAI `/models` response. In that
  // case the configured immutable wire API is the only reliable role signal.
  // Richer endpoints let us exclude known-incompatible modality families
  // without guessing missing capabilities.
  if (
    outputModalities.length > 0 &&
    wireApi === "embeddings" &&
    !outputModalities.includes("embeddings")
  ) {
    return undefined;
  }
  if (
    outputModalities.length > 0 &&
    wireApi !== "embeddings" &&
    outputModalities.includes("embeddings") &&
    outputModalities.length === 1
  ) {
    return undefined;
  }
  const parameters = strings(entry.supported_parameters, 64);
  const capabilities: string[] = [];
  if (parameters.includes("tools")) capabilities.push("tools");
  if (
    parameters.includes("structured_outputs") ||
    parameters.includes("response_format")
  ) {
    capabilities.push("structuredOutput");
  }
  if (parameters.includes("prompt_caching")) capabilities.push("promptCaching");
  const supportedRoles: string[] =
    wireApi === "embeddings"
      ? ["embedding"]
      : ["analysis", "chat", "keywordExtraction"];
  if (wireApi === "chatCompletions" && inputModalities.includes("image")) {
    supportedRoles.push("vision");
    capabilities.push("vision");
  }
  const topProvider = recordSchema.safeParse(entry.top_provider).success
    ? (entry.top_provider as Readonly<Record<string, unknown>>)
    : undefined;
  const maximumInputTokens = positiveInteger(entry.context_length);
  const maximumOutputTokens = positiveInteger(
    topProvider?.max_completion_tokens,
  );
  return Object.freeze({
    canonicalModel: canonicalModel.trim(),
    supportedRoles: Object.freeze(
      supportedRoles,
    ) as ProviderDiscoveredModel["supportedRoles"],
    capabilities: Object.freeze(
      capabilities,
    ) as ProviderDiscoveredModel["capabilities"],
    ...(maximumInputTokens === undefined ? {} : { maximumInputTokens }),
    ...(maximumOutputTokens === undefined ? {} : { maximumOutputTokens }),
  });
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}

/**
 * Reads the standard OpenAI-compatible model inventory from the configured
 * endpoint. It accepts only a bounded, normalized allowlist of model fields;
 * provider responses, account metadata, endpoint details, and credentials are
 * neither returned nor persisted by this adapter.
 */
export class OpenAiCompatibleModelDiscoverer
  implements ProviderModelDiscoverer
{
  private readonly fetchImplementation: typeof fetch;

  public constructor(input: OpenAiCompatibleModelDiscovererOptions = {}) {
    this.fetchImplementation = input.fetch ?? fetch;
  }

  public async discoverModels(
    invocation: ProviderModelDiscoveryInvocation,
  ): Promise<readonly ProviderDiscoveredModel[]> {
    if (invocation.secret.value.length === 0) {
      throw new AiConfigurationError("OpenAI-compatible credential is empty.");
    }
    const modelEndpoint = endpointForModels(
      invocation.endpoint,
      invocation.wireApi,
    );
    let response: Response;
    try {
      response = await this.fetchImplementation(modelEndpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${invocation.secret.value}` },
        signal: invocation.signal,
      });
    } catch (cause) {
      if (invocation.signal.aborted) throw cause;
      throw new AiProviderError(
        "The OpenAI-compatible model inventory could not be reached.",
        { provider: "openai-compatible", retryable: true },
        cause,
      );
    }
    const text = await response.text();
    if (text.length > 4_000_000) {
      throw new AiProviderError(
        "The provider model inventory exceeded the safe size limit.",
        { provider: "openai-compatible" },
      );
    }
    if (!response.ok) {
      throw new AiProviderError(
        "The OpenAI-compatible model inventory was rejected.",
        {
          provider: "openai-compatible",
          retryable: response.status === 429 || response.status >= 500,
          statusCode: response.status,
        },
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new AiProviderError(
        "The provider model inventory did not match its contract.",
        { provider: "openai-compatible" },
      );
    }
    const parsed = modelListSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AiProviderError(
        "The provider model inventory did not match its contract.",
        { provider: "openai-compatible" },
      );
    }
    const models = new Map<string, ProviderDiscoveredModel>();
    for (const entry of parsed.data.data) {
      const model = modelFrom(entry, invocation.wireApi);
      if (model !== undefined) models.set(model.canonicalModel, model);
    }
    return Object.freeze(
      [...models.values()].sort((left, right) =>
        left.canonicalModel.localeCompare(right.canonicalModel),
      ),
    );
  }
}
