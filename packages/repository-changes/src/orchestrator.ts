import type { EnvelopeFor } from "@caseweaver/domain";

import type {
  RepositoryChangeAuthor,
  RepositoryChangePreparation,
  RepositoryChangeStore,
  RepositoryDraftPullRequestPublisher,
} from "./contracts.js";

function validText(value: string, maximum: number): boolean {
  return (
    value.trim().length > 0 &&
    value.length <= maximum &&
    !/[\r\n\0]/u.test(value)
  );
}

function validateDraft(input: {
  readonly title: string;
  readonly description: string;
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}): void {
  if (!validText(input.title, 240) || input.description.length > 32_000) {
    throw new RepositoryChangeValidationError(
      "The generated draft metadata is invalid.",
    );
  }
  if (input.files.length === 0 || input.files.length > 25) {
    throw new RepositoryChangeValidationError(
      "The generated draft has an invalid number of files.",
    );
  }
  let bytes = 0;
  const paths = new Set<string>();
  for (const file of input.files) {
    if (
      file.path.length === 0 ||
      file.path.length > 1_024 ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path
        .split("/")
        .some((part) => part === "" || part === "." || part === "..") ||
      paths.has(file.path)
    ) {
      throw new RepositoryChangeValidationError(
        "The generated draft contains an invalid file path.",
      );
    }
    paths.add(file.path);
    bytes += new TextEncoder().encode(file.content).byteLength;
  }
  if (bytes > 512 * 1_024) {
    throw new RepositoryChangeValidationError(
      "The generated draft is too large.",
    );
  }
}

export class RepositoryChangeValidationError extends Error {
  public readonly code = "repositoryChange.invalidDraft";
  public readonly retryable = false;

  public constructor(message: string) {
    super(message);
    this.name = "RepositoryChangeValidationError";
  }
}

export class ScheduleRepositoryChangeForCompletedAnalysis {
  public constructor(private readonly store: RepositoryChangeStore) {}

  public async execute(
    event: EnvelopeFor<"analysis.completed.v1">,
    signal: AbortSignal,
  ): Promise<void> {
    await this.store.scheduleFromCompletedAnalysis(event, signal);
  }
}

/** Executes only the reviewable branch/PR path. Target-repository tests are never invoked. */
export class ExecuteRepositoryChange {
  public constructor(
    private readonly dependencies: {
      readonly store: RepositoryChangeStore;
      readonly preparation: RepositoryChangePreparation;
      readonly author: RepositoryChangeAuthor;
      readonly publisher: RepositoryDraftPullRequestPublisher;
    },
  ) {}

  public async execute(
    command: EnvelopeFor<"repository-change.execute.v1">,
    signal: AbortSignal,
  ): Promise<void> {
    const claimed = await this.dependencies.store.claim(
      command.payload.repositoryChangeRequestId,
      command.workspaceId,
      signal,
    );
    if (
      claimed === "completed" ||
      claimed === "already_running" ||
      claimed === "not_found"
    )
      return;
    try {
      await this.dependencies.store.markPlanning(claimed, signal);
      const prepared = await this.dependencies.preparation.prepare(
        claimed.request,
        signal,
      );
      const plan = await this.dependencies.author.plan(
        { issue: claimed.request.issue, repository: prepared },
        signal,
      );
      if (!plan.shouldChange) {
        await this.dependencies.store.markNoChange(claimed, signal);
        return;
      }
      if (
        !validText(plan.summary, 16_000) ||
        plan.documentationImpact.length > 16_000
      ) {
        throw new RepositoryChangeValidationError(
          "The architect result is invalid.",
        );
      }
      await this.dependencies.store.markAuthoring(
        claimed,
        {
          architectSummary: plan.summary,
          documentationImpact: plan.documentationImpact,
        },
        signal,
      );
      const draft = await this.dependencies.author.author(
        { issue: claimed.request.issue, repository: prepared, plan },
        signal,
      );
      if (draft === "no_change") {
        await this.dependencies.store.markNoChange(claimed, signal);
        return;
      }
      validateDraft(draft);
      const pullRequest = await this.dependencies.publisher.createDraft(
        { request: claimed.request, prepared, plan, draft },
        signal,
      );
      if (!validText(pullRequest.url, 4_096)) {
        throw new RepositoryChangeValidationError(
          "The repository provider returned an invalid pull request URL.",
        );
      }
      await this.dependencies.store.markDraftCreated(
        claimed,
        {
          pullRequestUrl: pullRequest.url,
          targetCommit: prepared.targetCommit,
        },
        signal,
      );
    } catch (error) {
      await this.dependencies.store.markFailed(
        claimed,
        {
          code:
            error instanceof RepositoryChangeValidationError
              ? error.code
              : "repositoryChange.executionFailed",
          outcomeUnknown: !(error instanceof RepositoryChangeValidationError),
        },
        new AbortController().signal,
      );
      throw error;
    }
  }
}
