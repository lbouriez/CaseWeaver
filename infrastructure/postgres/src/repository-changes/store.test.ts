import {
  causationId,
  correlationId,
  createEnvelope,
  outboxEnvelopeId,
  workspaceId,
} from "@caseweaver/domain";
import { describe, expect, it, vi } from "vitest";

import { PostgresRepositoryChangeStore } from "./store.js";

const workspace = workspaceId("workspace-a");

function completedAnalysis() {
  return createEnvelope<"analysis.completed.v1">({
    id: outboxEnvelopeId("repository-change-analysis-completed"),
    kind: "domainEvent",
    type: "analysis.completed.v1",
    schemaVersion: 1,
    workspaceId: workspace,
    occurredAt: "2026-08-07T00:00:00.000Z" as never,
    correlationId: correlationId("repository-change-correlation"),
    causationId: causationId("repository-change-causation"),
    payload: {
      analysisJobId: "analysis-job-a" as never,
      analysisResultId: "analysis-result-a" as never,
    },
  });
}

describe("PostgresRepositoryChangeStore", () => {
  it("atomically schedules one execute command only for an eligible immutable analysis", async () => {
    const requestCreate = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const outboxCreate = vi.fn(async () => undefined);
    const database = {
      analysisResult: {
        findUnique: vi.fn(async () => ({
          id: "analysis-result-a",
          analysisJobId: "analysis-job-a",
          record: {
            output: {
              confidence: "high",
              summary: "The retry counter is dereferenced when absent.",
              recommendedActions: [
                { statement: "Guard the missing retry counter." },
              ],
            },
            repositoryInvestigation: {
              run: {
                runtimeVersionId: "recipe-version-a",
                repositoryId: "repository-a",
                pinnedCommit: "a".repeat(40),
              },
              findings: [{ id: "repository-finding-a" }],
            },
          },
        })),
      },
      administrationConfigurationVersion: {
        findUnique: vi.fn(async () => ({
          settings: {
            repository: {
              mode: "remoteHttps",
              remoteUrl:
                "https://dev.azure.com/organization/project/_git/repository",
              checkoutSecretReferenceId: "repository-credential-a",
              checkoutRef: { kind: "branch", name: "main" },
              automation: { automaticDraftPullRequest: true },
            },
          },
        })),
      },
      repositoryChangeRequest: { createMany: requestCreate },
      outboxEnvelope: { create: outboxCreate },
    };
    const unitOfWork = {
      transaction: async (work: (transaction: object) => Promise<unknown>) =>
        work({}),
      get: () => database,
    };
    const store = new PostgresRepositoryChangeStore(unitOfWork as never);
    const signal = new AbortController().signal;

    await expect(
      store.scheduleFromCompletedAnalysis(completedAnalysis(), signal),
    ).resolves.toBe("scheduled");
    await expect(
      store.scheduleFromCompletedAnalysis(completedAnalysis(), signal),
    ).resolves.toBe("scheduled");

    expect(requestCreate).toHaveBeenCalledTimes(2);
    expect(requestCreate.mock.calls[0]?.[0]).toMatchObject({
      data: {
        workspaceId: "workspace-a",
        analysisResultId: "analysis-result-a",
        runtimeVersionId: "recipe-version-a",
        repositoryId: "repository-a",
        analyzedCommit: "a".repeat(40),
        targetBranch: "main",
        state: "queued",
      },
      skipDuplicates: true,
    });
    expect(outboxCreate).toHaveBeenCalledOnce();
    expect(outboxCreate.mock.calls[0]?.[0]).toMatchObject({
      data: {
        workspaceId: "workspace-a",
        kind: "command",
        type: "repository-change.execute.v1",
        payload: {
          repositoryChangeRequestId: requestCreate.mock.calls[0]?.[0].data.id,
        },
      },
    });
  });
});
