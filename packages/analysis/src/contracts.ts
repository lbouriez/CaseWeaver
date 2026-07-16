import type { EnvelopeFor } from "@caseweaver/domain";
import {
  type AnalysisPromptBuilder,
  type AnalysisPromptBudgets,
  type AnalysisPromptTemplate,
  type PromptTokenCounter,
  analysisPromptBudgetsSchema,
  analysisPromptTemplateSchema,
  CASE_ANALYSIS_SCHEMA_VERSION,
} from "@caseweaver/prompts";
import { z } from "zod";

const identifier = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-fA-F0-9]{64}$/u);
const stagePolicy = z.enum(["required", "optional", "disabled"]);

export const analysisEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: identifier,
      kind: z.literal("caseSnapshot"),
      content: z.string().min(1).max(1_000_000),
      contentHash: digest,
      caseSnapshotId: identifier,
      revision: identifier,
    })
    .strict(),
  z
    .object({
      id: identifier,
      kind: z.literal("caseMessage"),
      content: z.string().min(1).max(1_000_000),
      contentHash: digest,
      caseSnapshotId: identifier,
      messageId: identifier,
    })
    .strict(),
  z
    .object({
      id: identifier,
      kind: z.literal("attachment"),
      content: z.string().min(1).max(1_000_000),
      contentHash: digest,
      attachmentId: identifier,
      derivativeId: identifier,
      processorVersion: identifier,
    })
    .strict(),
  z
    .object({
      id: identifier,
      kind: z.literal("knowledge"),
      content: z.string().min(1).max(1_000_000),
      contentHash: digest,
      itemId: identifier,
      revisionId: identifier,
      chunkId: identifier,
      sourceUrl: z.url(),
    })
    .strict(),
  z
    .object({
      id: identifier,
      kind: z.literal("repository"),
      content: z.string().min(1).max(1_000_000),
      contentHash: digest,
      repositoryId: identifier,
      commit: z.string().regex(/^[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?$/u),
      path: z
        .string()
        .min(1)
        .max(1_024)
        .refine(
          (path) =>
            !path.startsWith("/") &&
            !path.startsWith("\\") &&
            !/^[a-z]:/iu.test(path) &&
            !path.split(/[\\/]/u).some((part) => part === ".." || part === ""),
          "Repository path is invalid.",
        ),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
      excerptHash: digest,
    })
    .strict()
    .refine((evidence) => evidence.endLine >= evidence.startLine, {
      message: "Repository evidence line range is invalid.",
      path: ["endLine"],
    }),
]);

export type AnalysisEvidence = z.infer<typeof analysisEvidenceSchema>;

/**
 * An append-only reference captured with a case snapshot.  It deliberately
 * contains no object-storage location: only the server-private content reader
 * may resolve the derivative's opaque storage handle.
 */
export const snapshotAttachmentReferenceSchema = z
  .object({
    attachmentId: identifier,
    derivativeId: identifier,
    processorVersion: identifier,
    /** SHA-256 of the normalized, safe-to-prompt derivative text. */
    outputContentHash: digest,
  })
  .strict();

export type SnapshotAttachmentReference = z.infer<
  typeof snapshotAttachmentReferenceSchema
>;

/**
 * Implemented by persistence. References are selected by the immutable
 * snapshot identity, never by a current external-reference lookup.
 */
export interface SnapshotAttachmentReferenceStore {
  listSnapshotAttachmentReferences(input: {
    readonly workspaceId: string;
    readonly caseSnapshotId: string;
    readonly signal: AbortSignal;
  }): Promise<readonly SnapshotAttachmentReference[]>;
}

/**
 * A server-private reader for normalized attachment derivatives. Implementors
 * must enforce workspace, retention, and storage access rules and must never
 * disclose object locations or credentials through this contract.
 */
export interface AttachmentDerivativeEvidenceContentReader {
  readDerivativeText(input: {
    readonly workspaceId: string;
    readonly attachmentId: string;
    readonly derivativeId: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly content: string;
    readonly contentHash: string;
  }>;
}

export const caseSnapshotTombstoneSchema = z
  .object({
    actorPrincipalId: identifier,
    tombstonedAt: z.string().datetime({ offset: true }),
    reason: z.string().min(1).max(4_000),
  })
  .strict();

export type CaseSnapshotTombstone = z.infer<typeof caseSnapshotTombstoneSchema>;

export const immutableCaseSnapshotSchema = z
  .object({
    id: identifier,
    revision: identifier,
    capturedAt: z.string().datetime({ offset: true }),
    title: z.string().min(1).max(16_000),
    summary: z.string().min(1).max(64_000),
    contentHash: digest,
    messages: z
      .array(
        z
          .object({
            id: identifier,
            content: z.string().min(1).max(1_000_000),
            contentHash: digest,
          })
          .strict(),
      )
      .max(1_000),
    tombstone: caseSnapshotTombstoneSchema.optional(),
  })
  .strict();

export type ImmutableCaseSnapshot = z.infer<typeof immutableCaseSnapshotSchema>;

export interface CaseSnapshotTombstoneStore {
  /**
   * Marks a captured snapshot as deleted without changing its hashed payload.
   * Repeated calls preserve the first audit record rather than overwriting it.
   */
  tombstone(input: {
    readonly workspaceId: string;
    readonly caseSnapshotId: string;
    readonly tombstone: CaseSnapshotTombstone;
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly kind: "tombstoned";
        readonly snapshot: ImmutableCaseSnapshot;
      }
    | {
        readonly kind: "alreadyTombstoned";
        readonly snapshot: ImmutableCaseSnapshot;
      }
    | { readonly kind: "notFound" }
  >;
}

export const analysisProfileSchema = z
  .object({
    id: identifier,
    version: identifier,
    analysisBindingVersionId: identifier,
    prompt: z
      .object({
        template: analysisPromptTemplateSchema,
        schemaVersion: z.literal(CASE_ANALYSIS_SCHEMA_VERSION),
        budgets: analysisPromptBudgetsSchema,
      })
      .strict(),
    retrieval: z
      .object({
        policy: stagePolicy,
        profileId: identifier,
        /** Exact immutable retrieval runtime configuration version ID. */
        profileVersion: identifier,
        collectionIds: z.array(identifier).min(1).max(100),
        maximumQueryCharacters: z.number().int().positive().max(64_000),
      })
      .strict(),
    attachments: z
      .object({
        policy: stagePolicy,
      })
      .strict(),
    repository: z
      .object({
        policy: stagePolicy,
        /** Exact immutable server-side repository runtime configuration. */
        runtimeVersionId: identifier.optional(),
        bindingVersionId: identifier.optional(),
        repositoryId: identifier.optional(),
        pinnedCommit: z
          .string()
          .regex(/^[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?$/u)
          .optional(),
        maximumContextCharacters: z.number().int().positive().max(64_000),
        maximumEvidenceCharacters: z.number().int().positive().max(64_000),
      })
      .strict()
      .superRefine((repository, context) => {
        if (
          repository.policy !== "disabled" &&
          (repository.runtimeVersionId === undefined ||
            repository.bindingVersionId === undefined ||
            repository.repositoryId === undefined ||
            repository.pinnedCommit === undefined)
        ) {
          context.addIssue({
            code: "custom",
            message:
              "An enabled repository stage requires immutable runtime, binding, repository, and commit references.",
          });
        }
      }),
    generation: z
      .object({
        maximumInputTokens: z.number().int().positive(),
        maximumOutputTokens: z.number().int().positive(),
        timeoutMs: z.number().int().positive().optional(),
        budget: z
          .object({
            currency: z.string().min(1).max(16),
            hard: z.boolean(),
            allowUnknownPricing: z.boolean().optional(),
          })
          .strict(),
      })
      .strict(),
    repair: z
      .object({
        maximumAttempts: z.number().int().min(0).max(3),
        maximumInputCharacters: z.number().int().positive().max(64_000),
      })
      .strict(),
  })
  .strict();

export type AnalysisProfile = z.infer<typeof analysisProfileSchema>;

export interface AnalysisExecution {
  readonly workspaceId: string;
  readonly analysisJobId: string;
  readonly analysisIdentityId: string;
  readonly analysisAttemptId: string;
  readonly snapshot: ImmutableCaseSnapshot;
  readonly profile: AnalysisProfile;
}

export type AnalysisStageName =
  | "attachments"
  | "retrieval"
  | "repository"
  | "prompt"
  | "generation"
  | "validation";

export interface AnalysisStageStatus {
  readonly stage: AnalysisStageName;
  readonly status: "completed" | "skipped" | "failed";
  readonly policy?: z.infer<typeof stagePolicy>;
  readonly error?: {
    readonly code: string;
    readonly retryable: boolean;
  };
}

export interface AnalysisResultRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly analysisJobId: string;
  readonly analysisIdentityId: string;
  readonly analysisAttemptId: string;
  readonly caseSnapshotId: string;
  readonly caseRevision: string;
  readonly analysisProfileId: string;
  readonly analysisProfileVersion: string;
  readonly analysisBindingVersionId: string;
  readonly promptTemplate: AnalysisPromptTemplate;
  readonly promptHash: string;
  readonly outputSchemaVersion: typeof CASE_ANALYSIS_SCHEMA_VERSION;
  readonly selectedEvidenceHashes: readonly string[];
  readonly evidence: readonly AnalysisEvidence[];
  readonly output: import("@caseweaver/prompts").CaseAnalysisOutput;
  readonly stages: readonly AnalysisStageStatus[];
  readonly operationIds: readonly string[];
  readonly createdAt: string;
}

export interface AnalysisExecutionStore {
  /**
   * Atomically verifies the command identity, starts one durable attempt, and
   * returns only immutable input versions.
   */
  claim(
    command: EnvelopeFor<"analysis.execute.v1">,
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "claimed"; readonly execution: AnalysisExecution }
    | { readonly kind: "completed"; readonly resultId: string }
    | { readonly kind: "alreadyRunning" }
    | { readonly kind: "notFound" }
  >;
  /**
   * Atomically inserts the immutable result, closes the attempt/job, and
   * appends the supplied AnalysisCompleted outbox event.
   */
  complete(
    input: {
      readonly execution: AnalysisExecution;
      readonly result: AnalysisResultRecord;
      readonly event: EnvelopeFor<"analysis.completed.v1">;
    },
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * Atomically records the terminal failed or cancelled attempt before a worker
   * releases its queue lease.
   */
  fail(
    input: {
      readonly execution: AnalysisExecution;
      readonly outcome: "failed" | "cancelled";
      readonly stages: readonly AnalysisStageStatus[];
      readonly error: { readonly code: string; readonly retryable: boolean };
    },
    signal: AbortSignal,
  ): Promise<void>;
}

export interface AnalysisEvidenceStageResult {
  readonly evidence: readonly AnalysisEvidence[];
  /** Metered operations performed by this stage, retained with the analysis. */
  readonly operationIds: readonly string[];
}

export interface AttachmentEvidencePort {
  resolve(input: {
    readonly execution: AnalysisExecution;
    readonly signal: AbortSignal;
  }): Promise<AnalysisEvidenceStageResult>;
}

export interface RetrievalEvidencePort {
  retrieve(input: {
    readonly execution: AnalysisExecution;
    readonly query: string;
    readonly profileId: string;
    readonly profileVersion: string;
    readonly collectionIds: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<AnalysisEvidenceStageResult>;
}

/**
 * Prompt construction needs the tokenizer belonging to the exact retained
 * analysis binding. The resolver is asynchronous because production
 * composition may first resolve that immutable server-side binding. It never
 * selects a current/default model from analysis content.
 */
export interface AnalysisPromptBuilderResolver {
  resolve(input: {
    readonly execution: AnalysisExecution;
    readonly signal: AbortSignal;
  }): Promise<AnalysisPromptBuilder>;
}

/**
 * Outer runtime composition resolves a model-compatible counter for this
 * exact retained binding. It must reject an unavailable tokenizer instead of
 * selecting a current/default provider or model.
 */
export interface AnalysisPromptTokenCounterResolver {
  resolve(input: {
    readonly workspaceId: string;
    readonly bindingVersionId: string;
    readonly signal: AbortSignal;
  }): Promise<PromptTokenCounter>;
}

export interface RepositoryInvestigationPort {
  investigate(input: {
    readonly execution: AnalysisExecution;
    readonly runtimeVersionId: string;
    readonly bindingVersionId: string;
    readonly repositoryId: string;
    readonly pinnedCommit: string;
    readonly caseSummary: string;
    readonly evidence: readonly AnalysisEvidence[];
    readonly signal: AbortSignal;
  }): Promise<{
    readonly summary: string;
    readonly evidence: readonly AnalysisEvidence[];
    readonly operationIds: readonly string[];
  }>;
}

export interface AnalysisClock {
  now(): string;
}

export interface AnalysisIdGenerator {
  next(kind: "analysisResult" | "outboxEnvelope"): string;
}

export interface CaseSnapshotCapturePort {
  /** Captures and persists an immutable revision before request idempotency. */
  capture(input: {
    readonly workspaceId: string;
    readonly caseReference: string;
    readonly signal: AbortSignal;
  }): Promise<ImmutableCaseSnapshot>;
}

export interface AnalysisRequestIdentityInput {
  readonly caseSnapshotId: string;
  readonly caseRevision: string;
  readonly analysisProfileVersion: string;
  readonly analysisBindingVersionId: string;
  readonly retrievalProfileVersion: string;
  readonly collectionIds: readonly string[];
  readonly promptTemplateVersion: string;
  readonly outputSchemaVersion: string;
  readonly repositoryCommit?: string;
  readonly repositoryBindingVersionId?: string;
  readonly repositoryRuntimeVersionId?: string;
}

export interface CapturedAnalysisRequest {
  readonly snapshot: ImmutableCaseSnapshot;
  readonly identity: AnalysisRequestIdentityInput;
}

export interface AnalysisProfilePrompt {
  readonly template: AnalysisPromptTemplate;
  readonly budgets: AnalysisPromptBudgets;
}
