import { WhitespacePromptTokenCounter } from "@caseweaver/prompts";
import { describe, expect, it } from "vitest";

import type { AnalysisExecution } from "./contracts.js";
import { PinnedAnalysisPromptBuilderResolver } from "./prompt-builder-resolver.js";

function execution(): AnalysisExecution {
  return {
    workspaceId: "workspace-a",
    analysisJobId: "job-a",
    analysisIdentityId: "identity-a",
    analysisAttemptId: "attempt-a",
    snapshot: {
      id: "snapshot-a",
      revision: "revision-a",
      capturedAt: "2026-07-15T00:00:00.000Z",
      title: "Case",
      summary: "Summary",
      contentHash: "a".repeat(64),
      messages: [],
    },
    profile: {
      id: "profile-a",
      version: "version-a",
      analysisBindingVersionId: "retained-analysis-binding-a",
      prompt: {
        template: {
          id: "prompt-a",
          version: "1",
          systemInstruction: "Analyze.",
        },
        schemaVersion: "case-analysis.v1",
        budgets: {
          case: { maximumCharacters: 10, maximumTokens: 10 },
          attachments: { maximumCharacters: 10, maximumTokens: 10 },
          knowledge: { maximumCharacters: 10, maximumTokens: 10 },
          repository: { maximumCharacters: 10, maximumTokens: 10 },
        },
      },
      retrieval: {
        policy: "disabled",
        profileId: "retrieval-profile-a",
        profileVersion: "retrieval-version-a",
        collectionIds: ["collection-a"],
        maximumQueryCharacters: 10,
      },
      attachments: { policy: "disabled" },
      repository: {
        policy: "disabled",
        maximumContextCharacters: 10,
        maximumEvidenceCharacters: 10,
      },
      generation: {
        maximumInputTokens: 10,
        maximumOutputTokens: 10,
        budget: { currency: "USD", hard: true },
      },
      repair: { maximumAttempts: 0, maximumInputCharacters: 10 },
    },
  };
}

describe("PinnedAnalysisPromptBuilderResolver", () => {
  it("resolves a tokenizer only for the execution's retained analysis binding", async () => {
    const calls: unknown[] = [];
    const resolver = new PinnedAnalysisPromptBuilderResolver({
      async resolve(input) {
        calls.push(input);
        return new WhitespacePromptTokenCounter();
      },
    });

    await expect(
      resolver.resolve({
        execution: execution(),
        signal: new AbortController().signal,
      }),
    ).resolves.toBeInstanceOf(Object);
    expect(calls).toEqual([
      expect.objectContaining({
        workspaceId: "workspace-a",
        bindingVersionId: "retained-analysis-binding-a",
      }),
    ]);
  });
});
