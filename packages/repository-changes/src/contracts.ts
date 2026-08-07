import type {
  AnalysisResultId,
  EnvelopeFor,
  RepositoryChangeRequestId,
  WorkspaceId,
} from "@caseweaver/domain";

export type RepositoryChangeState =
  | "queued"
  | "planning"
  | "authoring"
  | "draft_created"
  | "no_change"
  | "failed"
  | "outcome_unknown";

export interface RepositoryChangeIssue {
  readonly analysisResultId: AnalysisResultId;
  readonly caseReference?: string;
  readonly workItemReference?: string;
  readonly summary: string;
  readonly diagnosis: string;
  readonly confidence: "high";
}

/** A source-free runtime identity. The outer runtime resolves its private location. */
export interface RepositoryChangeRuntimePin {
  readonly runtimeVersionId: string;
  readonly repositoryId: string;
  readonly analyzedCommit: string;
  readonly targetBranch: string;
}

export interface RepositoryChangeRequest {
  readonly id: RepositoryChangeRequestId;
  readonly workspaceId: WorkspaceId;
  readonly state: RepositoryChangeState;
  readonly issue: RepositoryChangeIssue;
  readonly runtime: RepositoryChangeRuntimePin;
  readonly createdAt: string;
}

export interface ClaimedRepositoryChange {
  readonly request: RepositoryChangeRequest;
  readonly leaseToken: string;
}

export interface RepositoryChangeStore {
  /** Atomically evaluates the immutable analysis result and appends an execute command. */
  scheduleFromCompletedAnalysis(
    event: EnvelopeFor<"analysis.completed.v1">,
    signal: AbortSignal,
  ): Promise<"scheduled" | "not_eligible">;
  claim(
    requestId: RepositoryChangeRequestId,
    workspaceId: WorkspaceId,
    signal: AbortSignal,
  ): Promise<
    ClaimedRepositoryChange | "completed" | "already_running" | "not_found"
  >;
  markPlanning(
    claim: ClaimedRepositoryChange,
    signal: AbortSignal,
  ): Promise<void>;
  markAuthoring(
    claim: ClaimedRepositoryChange,
    input: {
      readonly architectSummary: string;
      readonly documentationImpact: string;
    },
    signal: AbortSignal,
  ): Promise<void>;
  markNoChange(
    claim: ClaimedRepositoryChange,
    signal: AbortSignal,
  ): Promise<void>;
  markDraftCreated(
    claim: ClaimedRepositoryChange,
    input: { readonly pullRequestUrl: string; readonly targetCommit: string },
    signal: AbortSignal,
  ): Promise<void>;
  markFailed(
    claim: ClaimedRepositoryChange,
    input: { readonly code: string; readonly outcomeUnknown: boolean },
    signal: AbortSignal,
  ): Promise<void>;
}

export interface RepositoryChangePlan {
  readonly summary: string;
  readonly documentationImpact: string;
  readonly shouldChange: boolean;
}

/** Replacements are intentionally text-only; binary and rename changes are never automatic. */
export interface RepositoryChangeFile {
  readonly path: string;
  readonly content: string;
}

export interface RepositoryChangeDraft {
  readonly title: string;
  readonly description: string;
  readonly files: readonly RepositoryChangeFile[];
}

export interface PreparedRepositoryChange {
  readonly targetCommit: string;
  readonly runtimePin: Readonly<{
    readonly workspaceId: WorkspaceId;
    readonly runtimeVersionId: string;
    readonly repositoryId: string;
    readonly pinnedCommit: string;
  }>;
}

/**
 * Outer adapter. Its implementation must invoke the configured model only via
 * `@caseweaver/ai-execution`; application code never receives a provider or secret.
 */
export interface RepositoryChangeAuthor {
  plan(
    input: {
      readonly issue: RepositoryChangeIssue;
      readonly repository: PreparedRepositoryChange;
    },
    signal: AbortSignal,
  ): Promise<RepositoryChangePlan>;
  author(
    input: {
      readonly issue: RepositoryChangeIssue;
      readonly repository: PreparedRepositoryChange;
      readonly plan: RepositoryChangePlan;
    },
    signal: AbortSignal,
  ): Promise<RepositoryChangeDraft | "no_change">;
}

/** Resolves the latest configured target branch and its private checkout material. */
export interface RepositoryChangePreparation {
  prepare(
    input: RepositoryChangeRequest,
    signal: AbortSignal,
  ): Promise<PreparedRepositoryChange>;
}

/** Vendor adapter. It must create a review-only draft pull request. */
export interface RepositoryDraftPullRequestPublisher {
  createDraft(
    input: {
      readonly request: RepositoryChangeRequest;
      readonly prepared: PreparedRepositoryChange;
      readonly plan: RepositoryChangePlan;
      readonly draft: RepositoryChangeDraft;
    },
    signal: AbortSignal,
  ): Promise<{ readonly url: string }>;
}

export interface RepositoryChangeIdGenerator {
  next(prefix: "repositoryChange"): RepositoryChangeRequestId;
}
