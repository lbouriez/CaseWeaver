import { describe, expect, it, vi } from "vitest";

import { RepositoryAnalysisAdministrationAuthorizer } from "./repository-analysis-authorizer.js";

const context = Object.freeze({
  principalId: "principal-a",
  workspaceId: "workspace-a",
  sessionId: "session-a",
  permissions: ["configuration.read"] as const,
  requestId: "request-a",
  correlationId: "correlation-a",
});

describe("RepositoryAnalysisAdministrationAuthorizer", () => {
  it("audits a successful sensitive read before returning", async () => {
    const append = vi.fn(async () => undefined);
    const subject = new RepositoryAnalysisAdministrationAuthorizer({
      unitOfWork: { transaction: async (operation) => operation({} as never) },
      auditStore: { append },
      eventId: () => "event-a",
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });

    await expect(
      subject.require({
        context,
        permission: "configuration.read",
        action: "admin.repositoryAnalysis.options.read",
        targetType: "repository-analysis-options",
        targetId: "workspace",
        mutation: false,
      }),
    ).resolves.toBeUndefined();
    expect(append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcome: "succeeded",
        permission: "configuration.read",
      }),
    );
  });

  it("does not pre-audit a successful mutation but records a denied attempt", async () => {
    const append = vi.fn(async () => undefined);
    const subject = new RepositoryAnalysisAdministrationAuthorizer({
      unitOfWork: { transaction: async (operation) => operation({} as never) },
      auditStore: { append },
      eventId: () => "event-a",
    });

    await expect(
      subject.require({
        context: { ...context, permissions: ["configuration.manage"] },
        permission: "configuration.manage",
        action: "admin.repositoryAnalysis.draft.create",
        targetType: "code-repositories",
        targetId: "repository-a",
        mutation: true,
      }),
    ).resolves.toBeUndefined();
    expect(append).not.toHaveBeenCalled();

    await expect(
      subject.require({
        context,
        permission: "configuration.manage",
        action: "admin.repositoryAnalysis.draft.create",
        targetType: "code-repositories",
        targetId: "repository-a",
        mutation: true,
      }),
    ).rejects.toThrow("authorization.denied");
    expect(append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcome: "denied",
        reasonCode: "authorization.denied",
      }),
    );
  });
});
