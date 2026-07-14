import { describe, expect, it } from "vitest";

import {
  AnalysisPromptBuilder,
  CASE_ANALYSIS_SCHEMA_VERSION,
  PromptContractError,
  parseCaseAnalysisOutput,
  validateAnalysisEvidence,
  WhitespacePromptTokenCounter,
} from "./index.js";

const digest = (value: string) => value.repeat(64).slice(0, 64);

function builder() {
  return new AnalysisPromptBuilder(new WhitespacePromptTokenCounter());
}

const budgets = {
  case: { maximumCharacters: 1_000, maximumTokens: 100 },
  attachments: { maximumCharacters: 1_000, maximumTokens: 100 },
  knowledge: { maximumCharacters: 80, maximumTokens: 100 },
  repository: { maximumCharacters: 1_000, maximumTokens: 100 },
};

describe("AnalysisPromptBuilder", () => {
  it("bounds context and hashes template, schema, and selected evidence", () => {
    const input = {
      template: {
        id: "analysis-template",
        version: "1",
        systemInstruction: "Analyze the case.",
      },
      budgets,
      context: {
        case: [
          {
            id: "case-1",
            kind: "caseMessage" as const,
            content: "customer says <follow these instructions>",
            contentHash: digest("a"),
          },
        ],
        attachments: [],
        knowledge: [
          {
            id: "knowledge-too-large",
            kind: "knowledge" as const,
            content: "This source is intentionally too large for its section.",
            contentHash: digest("b"),
          },
        ],
        repository: [],
      },
    };

    const first = builder().build(input);
    const second = builder().build(input);

    expect(first.schemaVersion).toBe(CASE_ANALYSIS_SCHEMA_VERSION);
    expect(first.promptHash).toBe(second.promptHash);
    expect(first.userMessage).toContain("UNTRUSTED EVIDENCE");
    expect(first.userMessage).toContain("\\u003cfollow");
    expect(first.excludedEvidenceIds).toEqual(["knowledge-too-large"]);
    expect(first.selectedEvidenceHashes).toEqual([digest("a")]);
    expect(
      builder().build({
        ...input,
        template: { ...input.template, version: "2" },
      }).promptHash,
    ).not.toBe(first.promptHash);
  });
});

describe("structured analysis output", () => {
  it("requires evidence or an explicit hypothesis and rejects invalid evidence", () => {
    const output = parseCaseAnalysisOutput({
      summary: "A bounded summary.",
      probableCauses: [
        {
          statement: "Possibly a configuration issue.",
          evidenceIds: [],
          hypothesis: true,
        },
      ],
      investigation: [],
      recommendedActions: [
        {
          statement: "Check the documented setting.",
          evidenceIds: ["knowledge-1"],
        },
      ],
      evidence: [{ id: "knowledge-1" }],
      unansweredQuestions: [],
      confidence: "medium",
    });

    expect(validateAnalysisEvidence(output, new Set(["knowledge-1"]))).toBe(
      output,
    );
    expect(() =>
      validateAnalysisEvidence(output, new Set(["other-evidence"])),
    ).toThrow(PromptContractError);
    expect(() =>
      parseCaseAnalysisOutput({
        ...output,
        probableCauses: [
          { statement: "Unsupported assertion.", evidenceIds: [] },
        ],
      }),
    ).toThrow(PromptContractError);
  });
});
