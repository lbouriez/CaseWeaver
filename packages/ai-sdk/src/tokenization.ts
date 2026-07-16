import type { AiProviderBinding } from "./contracts.js";

/**
 * Exact, model-compatible text measurement supplied by an AI provider adapter.
 * It is deliberately separate from request dispatch: token accounting must not
 * make a network request or select a default/current model.
 */
export interface AiModelTokenizer {
  count(text: string): number;
}

/**
 * Provider-owned tokenizer construction.  The outer runtime selects a
 * contribution only from the already resolved immutable binding's provider
 * type; feature code never names a provider, model, or encoding.
 */
export interface AiModelTokenizerContribution {
  readonly providerType: string;
  create(binding: AiProviderBinding): AiModelTokenizer;
}
