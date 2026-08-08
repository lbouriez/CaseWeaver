import {
  repositoryChangeRequestId,
  secretReference,
  workspaceId,
} from "@caseweaver/domain";
import type { RepositoryChangeRequest } from "@caseweaver/repository-changes";
import { describe, expect, it, vi } from "vitest";

import {
  AzureDevOpsRepositoryChangeGateway,
  AzureDevOpsRepositoryError,
  AzureDevOpsRestApi,
} from "./index.js";

const request: RepositoryChangeRequest = {
  id: repositoryChangeRequestId("repository-change-a"),
  workspaceId: workspaceId("workspace-a"),
  state: "queued",
  issue: {
    analysisResultId: "analysis-result-a" as never,
    summary: "A null retry counter is dereferenced.",
    diagnosis: "Guard the missing retry counter.",
    confidence: "high",
  },
  runtime: {
    runtimeVersionId: "recipe-version-a",
    repositoryId: "repository-a",
    analyzedCommit: "a".repeat(40),
    targetBranch: "main",
  },
  createdAt: "2026-08-07T00:00:00.000Z",
};

describe("AzureDevOpsRepositoryChangeGateway", () => {
  it("uses the configured branch head, a deterministic source branch, and a draft pull request", async () => {
    const resolveBranch = vi.fn(async () => ({ commit: "b".repeat(40) }));
    const findDraft = vi.fn(async () => undefined);
    const createCommit = vi.fn(async () => undefined);
    const createDraftPullRequest = vi.fn(async () => ({
      url: "https://dev.azure.com/org/project/_git/repo/pullrequest/42",
    }));
    const gateway = new AzureDevOpsRepositoryChangeGateway({
      configurations: {
        async resolve() {
          return {
            remoteUrl:
              "https://dev.azure.com/organization/project/_git/repository",
            checkoutSecretReference: secretReference("env:AZURE_DEVOPS_TOKEN"),
          };
        },
      },
      tokens: {
        async resolve() {
          return { value: "test-token" };
        },
      },
      api: { resolveBranch, findDraft, createCommit, createDraftPullRequest },
    });
    const prepared = await gateway.prepare(
      request,
      new AbortController().signal,
    );
    await gateway.createDraft(
      {
        request,
        prepared,
        plan: {
          summary: "Add a guard.",
          documentationImpact: "None.",
          shouldChange: true,
        },
        draft: {
          title: "Guard retry counter",
          description: "Target-repository tests were not run.",
          files: [
            { path: "src/retry.ts", content: "export const retries = 0;\n" },
          ],
        },
      },
      new AbortController().signal,
    );
    expect(resolveBranch).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "main", token: "test-token" }),
      expect.any(AbortSignal),
    );
    expect(createCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRef: "refs/heads/caseweaver/analysis/repository-change-a",
        parentCommit: "b".repeat(40),
      }),
      expect.any(AbortSignal),
    );
    expect(createDraftPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRef: "refs/heads/caseweaver/analysis/repository-change-a",
        targetRef: "refs/heads/main",
        description: expect.stringContaining(
          "CaseWeaver analysis: analysis-result-a",
        ),
      }),
      expect.any(AbortSignal),
    );
  });

  it("rejects a non-Azure-DevOps remote before it can receive the repository credential", async () => {
    const tokens = { resolve: vi.fn(async () => ({ value: "test-token" })) };
    const gateway = new AzureDevOpsRepositoryChangeGateway({
      configurations: {
        async resolve() {
          return {
            remoteUrl: "https://github.com/caseweaver/repository.git",
            checkoutSecretReference: secretReference("env:AZURE_DEVOPS_TOKEN"),
          };
        },
      },
      tokens,
      api: {} as never,
    });
    await expect(
      gateway.prepare(request, new AbortController().signal),
    ).rejects.toBeInstanceOf(AzureDevOpsRepositoryError);
    expect(tokens.resolve).not.toHaveBeenCalled();
  });
});

describe("AzureDevOpsRestApi", () => {
  it("sends a Git push with optimistic branch creation and creates a draft PR", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ value: [{ objectId: "b".repeat(40) }] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 201 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: "https://dev.azure.com/pr/42" }), {
          status: 201,
        }),
      );
    const api = new AzureDevOpsRestApi({ fetch });
    const location = {
      organization: "organization",
      project: "project",
      repository: "repository",
    };
    const signal = new AbortController().signal;
    await api.resolveBranch(
      { location, branch: "main", token: "token" },
      signal,
    );
    await api.findDraft(
      {
        location,
        sourceRef: "refs/heads/caseweaver/analysis/request",
        token: "token",
      },
      signal,
    );
    await api.createCommit(
      {
        location,
        sourceRef: "refs/heads/caseweaver/analysis/request",
        parentCommit: "b".repeat(40),
        message: "CaseWeaver: Guard retry counter",
        files: [
          { path: "src/retry.ts", content: "export const retries = 0;\n" },
        ],
        token: "token",
      },
      signal,
    );
    await api.createDraftPullRequest(
      {
        location,
        sourceRef: "refs/heads/caseweaver/analysis/request",
        targetRef: "refs/heads/main",
        title: "Guard retry counter",
        description: "Target-repository tests were not run.",
        token: "token",
      },
      signal,
    );
    const pushRequest = fetch.mock.calls[2]?.[1] as RequestInit;
    expect(JSON.parse(pushRequest.body as string)).toEqual(
      expect.objectContaining({
        refUpdates: [
          {
            name: "refs/heads/caseweaver/analysis/request",
            oldObjectId: "0000000000000000000000000000000000000000",
          },
        ],
      }),
    );
    const prRequest = fetch.mock.calls[3]?.[1] as RequestInit;
    expect(JSON.parse(prRequest.body as string)).toEqual(
      expect.objectContaining({
        isDraft: true,
        targetRefName: "refs/heads/main",
      }),
    );
  });
});
