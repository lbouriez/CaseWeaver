import {
  AnalysisPromptBuilder,
  type PromptTokenCounter,
} from "@caseweaver/prompts";

import type {
  AnalysisPromptBuilderResolver,
  AnalysisPromptTokenCounterResolver,
} from "./contracts.js";

/**
 * Converts a retained-binding tokenizer resolver into the execution-scoped
 * prompt-builder boundary consumed by AnalysisOrchestrator. This class makes
 * no model/provider choice and intentionally has no whitespace/default path.
 */
export class PinnedAnalysisPromptBuilderResolver
  implements AnalysisPromptBuilderResolver
{
  public constructor(
    private readonly tokenCounters: AnalysisPromptTokenCounterResolver,
  ) {}

  public async resolve(
    input: Parameters<AnalysisPromptBuilderResolver["resolve"]>[0],
  ): Promise<AnalysisPromptBuilder> {
    const counter: PromptTokenCounter = await this.tokenCounters.resolve({
      workspaceId: input.execution.workspaceId,
      bindingVersionId: input.execution.profile.analysisBindingVersionId,
      signal: input.signal,
    });
    return new AnalysisPromptBuilder(counter);
  }
}
