import { z } from "zod";

const identifier = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-fA-F0-9]{64}$/u);
const plainText = z
  .string()
  .max(16_000)
  .refine(
    (value) => !/<\s*\/?\s*[a-z][^>]*>/iu.test(value),
    "Model-authored HTML is not allowed.",
  );

export const CASE_ANALYSIS_SCHEMA_VERSION = "case-analysis.v1";

export const evidenceKindSchema = z.enum([
  "caseSnapshot",
  "caseMessage",
  "attachment",
  "knowledge",
  "repository",
]);

export const analysisEvidenceReferenceSchema = z
  .object({
    id: identifier,
    explanation: plainText.max(2_000).optional(),
  })
  .strict();

const claimSchema = z
  .object({
    statement: plainText.max(4_000),
    evidenceIds: z.array(identifier).max(20),
    hypothesis: z.boolean().optional(),
  })
  .strict()
  .superRefine((claim, context) => {
    if (claim.evidenceIds.length === 0 && claim.hypothesis !== true) {
      context.addIssue({
        code: "custom",
        message:
          "Claims without evidence must be explicitly marked hypotheses.",
        path: ["hypothesis"],
      });
    }
  });

export const caseAnalysisOutputSchema = z
  .object({
    summary: plainText.max(8_000),
    probableCauses: z.array(claimSchema).max(20),
    investigation: z
      .array(
        z
          .object({
            step: plainText.max(4_000),
            evidenceIds: z.array(identifier).max(20).optional(),
          })
          .strict(),
      )
      .max(30),
    recommendedActions: z.array(claimSchema).max(30),
    evidence: z.array(analysisEvidenceReferenceSchema).max(100),
    unansweredQuestions: z.array(plainText.max(2_000)).max(30),
    confidence: z.enum(["low", "medium", "high"]),
    customerSafeSummary: plainText.max(8_000).optional(),
  })
  .strict()
  .superRefine((analysis, context) => {
    const seen = new Set<string>();
    for (const [index, evidence] of analysis.evidence.entries()) {
      if (seen.has(evidence.id)) {
        context.addIssue({
          code: "custom",
          message: "Evidence references must be unique.",
          path: ["evidence", index, "id"],
        });
      }
      seen.add(evidence.id);
    }
  });

export type CaseAnalysisOutput = z.infer<typeof caseAnalysisOutputSchema>;

export const promptBudgetSchema = z
  .object({
    maximumCharacters: z.number().int().positive(),
    maximumTokens: z.number().int().positive(),
  })
  .strict();

export const analysisPromptBudgetsSchema = z
  .object({
    case: promptBudgetSchema,
    attachments: promptBudgetSchema,
    knowledge: promptBudgetSchema,
    repository: promptBudgetSchema,
  })
  .strict();

export type AnalysisPromptBudgets = z.infer<typeof analysisPromptBudgetsSchema>;

export const analysisPromptTemplateSchema = z
  .object({
    id: identifier,
    version: identifier,
    systemInstruction: z.string().min(1).max(16_000),
  })
  .strict();

export type AnalysisPromptTemplate = z.infer<
  typeof analysisPromptTemplateSchema
>;

export const promptContextItemSchema = z
  .object({
    id: identifier,
    kind: evidenceKindSchema,
    content: z.string().min(1).max(1_000_000),
    contentHash: digest,
  })
  .strict();

export type PromptContextItem = z.infer<typeof promptContextItemSchema>;

export const analysisPromptContextSchema = z
  .object({
    case: z.array(promptContextItemSchema),
    attachments: z.array(promptContextItemSchema),
    knowledge: z.array(promptContextItemSchema),
    repository: z.array(promptContextItemSchema),
  })
  .strict();

export type AnalysisPromptContext = z.infer<typeof analysisPromptContextSchema>;

export class PromptContractError extends Error {
  public readonly code:
    | "prompts.invalidOutput"
    | "prompts.invalidEvidence"
    | "prompts.invalidBudget";
  public readonly retryable = false;

  public constructor(
    code: PromptContractError["code"],
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "PromptContractError";
    this.code = code;
  }
}

export function parseCaseAnalysisOutput(value: unknown): CaseAnalysisOutput {
  let candidate = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch {
      throw new PromptContractError(
        "prompts.invalidOutput",
        "Analysis output must be a JSON object.",
      );
    }
  }
  const parsed = caseAnalysisOutputSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new PromptContractError(
      "prompts.invalidOutput",
      "Analysis output does not satisfy the structured schema.",
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

export function validateAnalysisEvidence(
  output: CaseAnalysisOutput,
  availableEvidenceIds: ReadonlySet<string>,
): CaseAnalysisOutput {
  const declared = new Set(output.evidence.map((evidence) => evidence.id));
  const claimReferences = [
    ...output.probableCauses.flatMap((claim) => claim.evidenceIds),
    ...output.recommendedActions.flatMap((claim) => claim.evidenceIds),
    ...output.investigation.flatMap((step) => step.evidenceIds ?? []),
  ];
  for (const id of [...declared, ...claimReferences]) {
    if (!availableEvidenceIds.has(id)) {
      throw new PromptContractError(
        "prompts.invalidEvidence",
        "Analysis output references evidence that was not supplied to the model.",
        { evidenceId: id },
      );
    }
    if (!declared.has(id)) {
      throw new PromptContractError(
        "prompts.invalidEvidence",
        "Analysis claims must reference an evidence entry in the structured result.",
        { evidenceId: id },
      );
    }
  }
  return output;
}
