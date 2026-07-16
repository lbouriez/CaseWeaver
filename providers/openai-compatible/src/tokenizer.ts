import {
  AiConfigurationError,
  type AiModelTokenizer,
  type AiModelTokenizerContribution,
  type AiProviderBinding,
} from "@caseweaver/ai-sdk";
import { getEncoding, type TiktokenEncoding } from "js-tiktoken";

const supportedEncodings = new Set<TiktokenEncoding>([
  "gpt2",
  "r50k_base",
  "p50k_base",
  "p50k_edit",
  "cl100k_base",
  "o200k_base",
]);

function encodingFrom(binding: AiProviderBinding): TiktokenEncoding {
  if (binding.providerType !== "openai-compatible") {
    throw new AiConfigurationError(
      "OpenAI-compatible tokenizer binding is invalid.",
    );
  }
  const value = binding.parameters.tokenizerEncoding;
  if (
    typeof value !== "string" ||
    !supportedEncodings.has(value as TiktokenEncoding)
  ) {
    throw new AiConfigurationError(
      "OpenAI-compatible bindings require a supported immutable tokenizer encoding.",
    );
  }
  return value as TiktokenEncoding;
}

class TiktokenModelTokenizer implements AiModelTokenizer {
  public constructor(
    private readonly encoding: ReturnType<typeof getEncoding>,
  ) {}

  public count(text: string): number {
    if (typeof text !== "string") {
      throw new AiConfigurationError("Tokenizer input is invalid.");
    }
    return this.encoding.encode(text).length;
  }
}

/**
 * Uses the exact encoding retained on the immutable binding. This is explicit
 * because an OpenAI-compatible endpoint can expose arbitrary model names;
 * guessing a fallback encoding would make stored prompt budgets unreliable.
 */
export const openAiCompatibleTokenizerContribution: AiModelTokenizerContribution =
  Object.freeze({
    providerType: "openai-compatible",
    create(binding: AiProviderBinding): AiModelTokenizer {
      return new TiktokenModelTokenizer(getEncoding(encodingFrom(binding)));
    },
  });
