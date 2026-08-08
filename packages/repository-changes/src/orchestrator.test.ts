import {
  causationId,
  correlationId,
  createEnvelope,
  outboxEnvelopeId,
  repositoryChangeRequestId,
  workspaceId,
} from "@caseweaver/domain";
import { describe, expect, it } from "vitest";

import type {
  ClaimedRepositoryChange,
  RepositoryChangeRequest,
  RepositoryChangeStore,
} from "./contracts.js";
import {
  ExecuteRepositoryChange,
  ScheduleRepositoryChangeForCompletedAnalysis,
} from "./orchestrator.js";

const workspace = workspaceId("workspace-a");
const request: RepositoryChangeRequest = Object.freeze({
  id: repositoryChangeRequestId("repository-change-a"),
  workspaceId: workspace,
  state: "queued",
  issue: Object.freeze({
    analysisResultId: "analysis-result-a" as never,
    summary: "A null retry counter is dereferenced.",
    diagnosis: "Guard the missing retry counter before incrementing it.",
    confidence: "high",
  }),
  runtime: Object.freeze({
    runtimeVersionId: "recipe-version-a",
    repositoryId: "repository-a",
    analyzedCommit: "a".repeat(40),
    targetBranch: "main",
  }),
  createdAt: "2026-08-07T00:00:00.000Z",
});

function completed() {
  return createEnvelope<"analysis.completed.v1">({
    id: outboxEnvelopeId("outbox-a"),
    kind: "domainEvent",
    type: "analysis.completed.v1",
    schemaVersion: 1,
    workspaceId: workspace,
    occurredAt: "2026-08-07T00:00:00.000Z" as never,
    correlationId: correlationId("correlation-a"),
    causationId: causationId("causation-a"),
    payload: {
      analysisJobId: "analysis-job-a" as never,
      analysisResultId: "analysis-result-a" as never,
    },
  });
}

class MemoryStore implements RepositoryChangeStore {
  public scheduled = 0;
  public readonly states: string[] = [];

  public async scheduleFromCompletedAnalysis() {
    this.scheduled += 1;
    return "scheduled" as const;
  }

  public async claim(): Promise<ClaimedRepositoryChange> {
    return Object.freeze({ request, leaseToken: "lease-a" });
  }

  public async markPlanning() {
    this.states.push("planning");
  }

  public async markAuthoring(
    _claim: ClaimedRepositoryChange,
    input: {
      readonly architectSummary: string;
      readonly documentationImpact: string;
    },
  ) {
    this.states.push(`authoring:${input.architectSummary}`);
  }

  public async markNoChange() {
    this.states.push("no_change");
  }

  public async markDraftCreated(
    _claim: ClaimedRepositoryChange,
    input: { readonly pullRequestUrl: string; readonly targetCommit: string },
  ) {
    this.states.push(
      `draft_created:${input.targetCommit}:${input.pullRequestUrl}`,
    );
  }

  public async markFailed(
    _claim: ClaimedRepositoryChange,
    input: { readonly code: string },
  ) {
    this.states.push(`failed:${input.code}`);
  }
}

describe("repository-change workflow", () => {
  it("schedules once, plans before authoring, and creates a review-only draft without executing target tests", async () => {
    const store = new MemoryStore();
    const scheduled = new ScheduleRepositoryChangeForCompletedAnalysis(store);
    await scheduled.execute(completed(), new AbortController().signal);
    expect(store.scheduled).toBe(1);

    const calls: string[] = [];
    const workflow = new ExecuteRepositoryChange({
      store,
      preparation: {
        async prepare() {
          calls.push("prepare");
          return {
            targetCommit: "b".repeat(40),
            runtimePin: {
              workspaceId: workspace,
              runtimeVersionId: "recipe-version-a",
              repositoryId: "repository-a",
              pinnedCommit: "b".repeat(40),
            },
          };
        },
      },
      author: {
        async plan() {
          calls.push("plan");
          return {
            summary: "Add a missing null guard.",
            documentationImpact: "No operator documentation change.",
            shouldChange: true,
          };
        },
        async author() {
          calls.push("author");
          return {
            title: "Guard missing retry counter",
            description: "Target-repository tests were not run.",
            files: [
              { path: "src/retry.ts", content: "export const retries = 0;\n" },
            ],
          };
        },
      },
      publisher: {
        async createDraft(input) {
          calls.push("draft");
          expect(input.draft.description).toContain("tests were not run");
          return {
            url: "https://dev.azure.com/org/project/_git/repo/pullrequest/12",
          };
        },
      },
    });
    await workflow.execute(
      createEnvelope<"repository-change.execute.v1">({
        id: outboxEnvelopeId("outbox-b"),
        kind: "command",
        type: "repository-change.execute.v1",
        schemaVersion: 1,
        workspaceId: workspace,
        occurredAt: "2026-08-07T00:00:00.000Z" as never,
        correlationId: correlationId("correlation-a"),
        causationId: causationId("causation-a"),
        payload: { repositoryChangeRequestId: request.id },
      }),
      new AbortController().signal,
    );

    expect(calls).toEqual(["prepare", "plan", "author", "draft"]);
    expect(store.states).toEqual([
      "planning",
      "authoring:Add a missing null guard.",
      "draft_created:" +
        "b".repeat(40) +
        ":https://dev.azure.com/org/project/_git/repo/pullrequest/12",
    ]);
  });
});
