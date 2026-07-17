import type { EnvelopeFor } from "@caseweaver/domain";
import {
  type AnalysisPromptBudgets,
  type AnalysisPromptBuilder,
  type AnalysisPromptTemplate,
  analysisPromptBudgetsSchema,
  analysisPromptTemplateSchema,
  CASE_ANALYSIS_SCHEMA_VERSION,
  type PromptTokenCounter,
} from "@caseweaver/prompts";
import { z } from "zod";

const identifier = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-fA-F0-9]{64}$/u);
const repositoryCommit = z
  .string()
  .regex(/^[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?$/u);
const stagePolicy = z.enum(["required", "optional", "disabled"]);

/**
 * A repository agent can inspect many files, but a support analysis must not
 * accept an unbounded collection of model-authored findings. One hundred
 * evidence-linked findings is substantially more than a single case can use
 * while keeping validation, persistence, and prompt selection bounded.
 */
export const MAXIMUM_REPOSITORY_FINDINGS = 100;

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
      commit: repositoryCommit,
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
    /** Optional only for historical snapshots predating occurrence evidence. */
    occurrenceIdentity: identifier.optional(),
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
 * Attachment preparation is frozen before identity creation. A skipped or
 * failed optional occurrence is retained as a bounded warning so retries and
 * later result inspection do not silently reinterpret the available context.
 * No locator, filename, source URL, MIME detail, or derivative text appears
 * in this analysis-layer contract.
 */
export const preparedAttachmentEvidenceSchema = z
  .object({
    /** One binary may occur repeatedly while sharing one derivative cache entry. */
    occurrenceIdentity: identifier.optional(),
    attachmentId: identifier,
    derivativeId: identifier.optional(),
    outputContentHash: digest.optional(),
    outcome: z.enum(["ready", "skipped", "failed"]),
    required: z.boolean(),
    warningCode: identifier.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const complete =
      value.derivativeId !== undefined && value.outputContentHash !== undefined;
    if (value.outcome === "ready" && !complete) {
      context.addIssue({
        code: "custom",
        message:
          "Prepared attachment evidence must retain its exact derivative.",
      });
    }
    if (value.outcome !== "ready" && complete) {
      context.addIssue({
        code: "custom",
        message: "Unavailable attachment evidence cannot retain a derivative.",
      });
    }
    if (value.outcome === "ready" && value.warningCode !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Ready attachment evidence cannot carry a warning.",
      });
    }
    if (value.outcome !== "ready" && value.warningCode === undefined) {
      context.addIssue({
        code: "custom",
        message: "Unavailable attachment evidence requires a warning code.",
      });
    }
  });

export type PreparedAttachmentEvidence = Readonly<{
  readonly occurrenceIdentity?: string;
  readonly attachmentId: string;
  readonly derivativeId?: string;
  readonly outputContentHash?: string;
  readonly outcome: "ready" | "skipped" | "failed";
  readonly required: boolean;
  readonly warningCode?: string;
}>;

export const preparedAttachmentEvidenceSetSchema = z
  .object({
    identityHash: digest,
    evidence: z.array(preparedAttachmentEvidenceSchema).max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    const identifiers = new Set<string>();
    for (const [index, item] of value.evidence.entries()) {
      const identity = item.occurrenceIdentity ?? item.attachmentId;
      if (identifiers.has(identity)) {
        context.addIssue({
          code: "custom",
          message:
            "Prepared attachment evidence cannot repeat an attachment occurrence.",
          path: ["evidence"],
        });
      }
      identifiers.add(identity);
      if (item.required && item.outcome !== "ready") {
        context.addIssue({
          code: "custom",
          message: "Required attachment preparation must be ready.",
          path: ["evidence", index, "outcome"],
        });
      }
    }
  });

export type PreparedAttachmentEvidenceSet = Readonly<{
  readonly identityHash: string;
  readonly evidence: readonly PreparedAttachmentEvidence[];
}>;

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

/**
 * Exact repository material selected before an analysis job is created. The
 * resolver obtains `pinnedCommit` from the immutable repository version's
 * allowed ref; a recipe never stores a moving branch or a commit. This record
 * is server-side execution input, not an administration/public read model.
 */
export const repositoryRunPinSchema = z
  .object({
    repositoryId: identifier,
    repositoryVersionId: identifier,
    /** Exact server-created repository runtime projection; never inferred. */
    runtimePinId: identifier,
    executionPolicyId: identifier,
    executionPolicyVersionId: identifier,
    repositoryAgentBindingVersionId: identifier,
    pinnedCommit: repositoryCommit,
    resolvedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type RepositoryRunPin = z.infer<typeof repositoryRunPinSchema>;

/**
 * Repository-agent text is untrusted evidence. It is bounded and linked to
 * verified repository evidence before a prompt builder may consume it. It
 * must never be treated as an instruction or sent through audit/log DTOs.
 */
export const repositoryFindingSchema = z
  .object({
    id: identifier,
    summary: z.string().min(1).max(16_000),
    evidenceIds: z.array(identifier).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.evidenceIds).size !== value.evidenceIds.length) {
      context.addIssue({
        code: "custom",
        message: "Repository finding evidence identifiers must be unique.",
        path: ["evidenceIds"],
      });
    }
  });

export type RepositoryFinding = z.infer<typeof repositoryFindingSchema>;

/**
 * Provider output crosses this contract as evidence, never as an unbounded
 * stream. The orchestrator validates this list before it maps findings to
 * prompt evidence or stores an immutable result.
 */
export const repositoryFindingsSchema = z
  .array(repositoryFindingSchema)
  .max(MAXIMUM_REPOSITORY_FINDINGS);

/**
 * Retained only through a governed internal-content reader. Generic
 * administration DTOs, audit records, diagnostics, and logs must not expose
 * these fields.
 */
export const protectedAnalysisContentSchema = z
  .object({
    exchanges: z
      .array(
        z
          .object({
            systemPrompt: z.string().min(1).max(1_000_000),
            userPrompt: z.string().min(1).max(1_000_000),
            promptContentHash: digest,
            modelOutput: z.string().min(1).max(1_000_000),
            modelOutputHash: digest,
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict();

export type ProtectedAnalysisContent = Readonly<{
  readonly exchanges: readonly Readonly<{
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly promptContentHash: string;
    readonly modelOutput: string;
    readonly modelOutputHash: string;
  }>[];
}>;

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
        /** Immutable code-repository aggregate and selected version. */
        repositoryId: identifier.optional(),
        repositoryVersionId: identifier.optional(),
        /** Immutable repository execution/sandbox policy aggregate and version. */
        executionPolicyId: identifier.optional(),
        executionPolicyVersionId: identifier.optional(),
        /** Immutable provider-neutral binding with the `repositoryAgent` role. */
        repositoryAgentBindingVersionId: identifier.optional(),
        maximumContextCharacters: z.number().int().positive().max(64_000),
        maximumEvidenceCharacters: z.number().int().positive().max(64_000),
      })
      .strict()
      .superRefine((repository, context) => {
        if (
          repository.policy !== "disabled" &&
          (repository.repositoryId === undefined ||
            repository.repositoryVersionId === undefined ||
            repository.executionPolicyId === undefined ||
            repository.executionPolicyVersionId === undefined ||
            repository.repositoryAgentBindingVersionId === undefined)
        ) {
          context.addIssue({
            code: "custom",
            message:
              "An enabled repository stage requires immutable repository, execution-policy, and repository-agent binding versions.",
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
  /** Exact preparation outcomes selected before request identity creation. */
  readonly preparedAttachments?: PreparedAttachmentEvidenceSet;
  /** Required when the retained profile enables repository investigation. */
  readonly repositoryRun?: RepositoryRunPin;
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
  /** Exact selected repository material and bounded untrusted agent findings. */
  readonly repositoryInvestigation?: Readonly<{
    readonly run: RepositoryRunPin;
    readonly findings: readonly RepositoryFinding[];
  }>;
  /** Governed retained content; never serialize through generic read models. */
  readonly protectedContent?: ProtectedAnalysisContent;
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

/**
 * Resolves all attachment occurrences before an analysis job is created. The
 * implementation may invoke the attachment package/AI gateway as needed, but
 * this analysis package receives only immutable derivative identities and safe
 * warning codes. Required failures must reject rather than return an
 * incomplete preparation set.
 */
export interface PreparedAttachmentEvidenceResolver {
  resolve(input: {
    readonly workspaceId: string;
    readonly snapshot: ImmutableCaseSnapshot;
    readonly profile: AnalysisProfile;
    readonly signal: AbortSignal;
  }): Promise<PreparedAttachmentEvidenceSet>;
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
    readonly repository: RepositoryRunPin;
    readonly caseSummary: string;
    readonly evidence: readonly AnalysisEvidence[];
    readonly signal: AbortSignal;
  }): Promise<{
    readonly summary: string;
    readonly evidence: readonly AnalysisEvidence[];
    readonly findings: readonly RepositoryFinding[];
    readonly operationIds: readonly string[];
  }>;
}

/**
 * Composition resolves an allowed source ref to an exact commit before job
 * identity/idempotency is created. It may use server-private repository
 * configuration and secret material but exposes neither through this port.
 */
export interface RepositoryRunPinResolver {
  resolve(input: {
    readonly workspaceId: string;
    readonly profile: AnalysisProfile;
    readonly signal: AbortSignal;
  }): Promise<RepositoryRunPin>;
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
  readonly preparedAttachmentEvidenceHash?: string;
  readonly repositoryCommit?: string;
  readonly repositoryAgentBindingVersionId?: string;
  readonly repositoryVersionId?: string;
  readonly repositoryRuntimePinId?: string;
  readonly repositoryExecutionPolicyVersionId?: string;
}

export interface CapturedAnalysisRequest {
  readonly snapshot: ImmutableCaseSnapshot;
  readonly identity: AnalysisRequestIdentityInput;
  readonly repositoryRun?: RepositoryRunPin;
  readonly preparedAttachments?: PreparedAttachmentEvidenceSet;
}

/**
 * A destination-neutral publication receipt. A receipt is append-only and
 * linked to one immutable analysis result; a destination may call its returned
 * identifier a comment ID, message ID, or something else. Raw rendered content
 * and destination error details are deliberately absent.
 */
export const analysisPublicationReceiptSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    analysisResultId: identifier,
    publicationProfileVersionId: identifier,
    publicationIdentity: digest,
    externalPublicationId: identifier,
    publishedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type AnalysisPublicationReceipt = z.infer<
  typeof analysisPublicationReceiptSchema
>;

/**
 * Durable adapter boundary for a successful publication receipt. Implementors
 * insert/replay by publication identity and retain the receipt atomically with
 * the PBI-012 publication completion state; this package never posts remotely.
 */
export interface AnalysisPublicationReceiptStore {
  record(input: {
    readonly receipt: AnalysisPublicationReceipt;
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly kind: "recorded";
        readonly receipt: AnalysisPublicationReceipt;
      }
    | {
        readonly kind: "replayed";
        readonly receipt: AnalysisPublicationReceipt;
      }
    | { readonly kind: "conflict" }
  >;
}

/**
 * A protected-content read requires authorization, retention, and a
 * fail-closed sensitive-read audit in outer composition. This interface keeps
 * the content separate from generic analysis detail/list read models.
 */
export interface ProtectedAnalysisContentReader {
  read(input: {
    readonly workspaceId: string;
    readonly analysisResultId: string;
    readonly signal: AbortSignal;
  }): Promise<ProtectedAnalysisContent | undefined>;
}

export interface AnalysisProfilePrompt {
  readonly template: AnalysisPromptTemplate;
  readonly budgets: AnalysisPromptBudgets;
}
