import { expect, test } from "@playwright/test";
import type {
  ClaimedRepositoryChange,
  RepositoryChangeRequest,
  RepositoryChangeStore,
} from "../../apps/worker/src/test-support/repository-change-e2e.js";
import {
  causationId,
  correlationId,
  createEnvelope,
  createWorkerCommandDispatcher,
  ExecuteRepositoryChange,
  outboxEnvelopeId,
  repositoryChangeRequestId,
  ScheduleRepositoryChangeForCompletedAnalysis,
  workspaceId,
} from "../../apps/worker/src/test-support/repository-change-e2e.js";

const workspace = workspaceId("e2e-workspace");
const request: RepositoryChangeRequest = {
  id: repositoryChangeRequestId("e2e-repository-change"),
  workspaceId: workspace,
  state: "queued",
  issue: {
    analysisResultId: "e2e-analysis-result" as never,
    summary: "The retry counter can be absent.",
    diagnosis: "Guard the absent retry counter.",
    confidence: "high",
  },
  runtime: {
    runtimeVersionId: "e2e-recipe-version",
    repositoryId: "e2e-repository",
    analyzedCommit: "a".repeat(40),
    targetBranch: "main",
  },
  createdAt: "2026-08-07T00:00:00.000Z",
};

class JourneyStore implements RepositoryChangeStore {
  public scheduled = 0;
  public draftUrl: string | undefined;

  public async scheduleFromCompletedAnalysis() {
    this.scheduled += 1;
    return "scheduled" as const;
  }
  public async claim(): Promise<ClaimedRepositoryChange> {
    return { request, leaseToken: "e2e-lease" };
  }
  public async markPlanning() {}
  public async markAuthoring() {}
  public async markNoChange() {}
  public async markDraftCreated(
    _claim: ClaimedRepositoryChange,
    input: { readonly pullRequestUrl: string },
  ) {
    this.draftUrl = input.pullRequestUrl;
  }
  public async markFailed() {}
}

test("eligible analysis -> architect -> author -> review-only draft PR, with no target-test step", async () => {
  const store = new JourneyStore();
  const schedule = new ScheduleRepositoryChangeForCompletedAnalysis(store);
  const publisherCalls: string[] = [];
  const execute = new ExecuteRepositoryChange({
    store,
    preparation: {
      async prepare() {
        return {
          targetCommit: "b".repeat(40),
          runtimePin: {
            workspaceId: workspace,
            runtimeVersionId: request.runtime.runtimeVersionId,
            repositoryId: request.runtime.repositoryId,
            pinnedCommit: "b".repeat(40),
          },
        };
      },
    },
    author: {
      async plan() {
        publisherCalls.push("architect");
        return {
          summary: "Add a guard.",
          documentationImpact: "None.",
          shouldChange: true,
        };
      },
      async author() {
        publisherCalls.push("author");
        return {
          title: "Guard retry counter",
          description: "Target-repository tests were not run.",
          files: [
            { path: "src/retry.ts", content: "export const retries = 0;\n" },
          ],
        };
      },
    },
    publisher: {
      async createDraft(input) {
        publisherCalls.push("draft-pr");
        expect(input.draft.description).toContain("tests were not run");
        return {
          url: "https://dev.azure.com/org/project/_git/repo/pullrequest/7",
        };
      },
    },
  });
  const dispatcher = createWorkerCommandDispatcher({
    synchronize: { handle: async () => {} },
    fullRescan: { handle: async () => {} },
    analysis: { execute: { handle: async () => {} } },
    repositoryChanges: {
      analysisCompleted: {
        handle: (event, signal) => schedule.execute(event, signal),
      },
      execute: {
        handle: (command, signal) => execute.execute(command, signal),
      },
    },
  });
  const signal = new AbortController().signal;
  await dispatcher.dispatch(
    createEnvelope({
      id: outboxEnvelopeId("e2e-analysis-completed"),
      kind: "domainEvent",
      type: "analysis.completed.v1",
      schemaVersion: 1,
      workspaceId: workspace,
      occurredAt: "2026-08-07T00:00:00.000Z" as never,
      correlationId: correlationId("e2e-correlation"),
      causationId: causationId("e2e-causation"),
      payload: {
        analysisJobId: "e2e-analysis-job" as never,
        analysisResultId: request.issue.analysisResultId,
      },
    }),
    signal,
  );
  await dispatcher.dispatch(
    createEnvelope({
      id: outboxEnvelopeId("e2e-repository-change-command"),
      kind: "command",
      type: "repository-change.execute.v1",
      schemaVersion: 1,
      workspaceId: workspace,
      occurredAt: "2026-08-07T00:00:00.000Z" as never,
      correlationId: correlationId("e2e-correlation"),
      causationId: causationId("e2e-causation"),
      payload: { repositoryChangeRequestId: request.id },
    }),
    signal,
  );
  expect(store.scheduled).toBe(1);
  expect(publisherCalls).toEqual(["architect", "author", "draft-pr"]);
  expect(store.draftUrl).toContain("pullrequest/7");
});
