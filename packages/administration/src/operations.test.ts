import { describe, expect, it } from "vitest";

import {
  digestOperationCommand,
  operationsQuery,
  requiredOperationPermission,
  requiredOperationsReadPermission,
  validateOperationCommand,
} from "./operations.js";

describe("administration operations contracts", () => {
  it("bounds all operational list queries to a small page size", () => {
    expect(
      operationsQuery({ workspaceId: "workspace" as never, limit: 100 }),
    ).toMatchObject({ limit: 100 });
    expect(() =>
      operationsQuery({ workspaceId: "workspace" as never, limit: 101 }),
    ).toThrow(/between 1 and 100/u);
    expect(
      operationsQuery({
        workspaceId: "workspace" as never,
        after: { sortKey: "2026-07-14T00:00:00.000Z", id: "job-1" },
      }),
    ).toMatchObject({
      limit: 50,
      after: { sortKey: "2026-07-14T00:00:00.000Z", id: "job-1" },
    });
  });

  it("requires semantic targets and a bounded reason for privacy purges", () => {
    expect(() =>
      validateOperationCommand({
        action: "privacy.purge",
        target: { resource: "caseSnapshot", id: "snapshot-1" },
        parameters: { reason: "Data-subject request" },
      }),
    ).not.toThrow();
    expect(() =>
      validateOperationCommand({
        action: "privacy.purge",
        target: { resource: "job", id: "job-1" },
        parameters: { reason: "Data-subject request" },
      }),
    ).toThrow(/target/u);
    expect(() =>
      validateOperationCommand({
        action: "privacy.purge",
        target: { resource: "caseSnapshot", id: "snapshot-1" },
        parameters: { reason: "" },
      }),
    ).toThrow(/reason/u);
  });

  it("uses a canonical digest without retaining raw operation parameters", () => {
    const first = digestOperationCommand({
      action: "privacy.purge",
      target: { resource: "caseSnapshot", id: "snapshot-1" },
      parameters: { reason: "Data-subject request" },
    });
    const second = digestOperationCommand({
      parameters: { reason: "Data-subject request" },
      target: { id: "snapshot-1", resource: "caseSnapshot" },
      action: "privacy.purge",
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toContain("Data-subject request");
  });

  it("does not allow a retention action to be redirected to a resource id", () => {
    expect(() =>
      validateOperationCommand({
        action: "retention.reap",
        target: { resource: "retention", id: "arbitrary" },
        parameters: { limit: 100 },
      }),
    ).toThrow(/target/u);
  });

  it("keeps action and read permissions server-owned", () => {
    expect(requiredOperationPermission("privacy.purge")).toBe("privacy.delete");
    expect(requiredOperationPermission("deadLetter.retry")).toBe(
      "operations.retry",
    );
    expect(requiredOperationsReadPermission("costs")).toBe("cost.read");
    expect(requiredOperationsReadPermission("auditEvents")).toBe("audit.read");
  });

  it("accepts each supported action only with its own semantic target", () => {
    const commands = [
      {
        action: "analysis.forceRerun" as const,
        target: { resource: "analysis" as const, id: "analysis-1" },
        parameters: {},
      },
      {
        action: "knowledgeSource.synchronize" as const,
        target: { resource: "knowledgeSource" as const, id: "source-1" },
        parameters: { kind: "synchronize" as const },
      },
      {
        action: "knowledgeSource.fullRescan" as const,
        target: { resource: "knowledgeSource" as const, id: "source-1" },
        parameters: { kind: "fullRescan" as const },
      },
      {
        action: "publication.approve" as const,
        target: { resource: "publication" as const, id: "publication-1" },
        parameters: {},
      },
      {
        action: "deadLetter.retry" as const,
        target: { resource: "deadLetter" as const, id: "job-1" },
        parameters: {},
      },
      {
        action: "job.cancel" as const,
        target: { resource: "job" as const, id: "job-1" },
        parameters: {},
      },
      {
        action: "job.recover" as const,
        target: { resource: "job" as const, id: "job-1" },
        parameters: {},
      },
      {
        action: "retention.reap" as const,
        target: { resource: "retention" as const },
        parameters: { limit: 1_000 },
      },
      {
        action: "privacy.purge" as const,
        target: { resource: "caseSnapshot" as const, id: "snapshot-1" },
        parameters: { reason: "Data-subject request" },
      },
    ];

    for (const command of commands) {
      expect(() => validateOperationCommand(command)).not.toThrow();
    }
  });

  it("rejects parameters that could change a fixed operation's meaning", () => {
    expect(() =>
      validateOperationCommand({
        action: "job.cancel",
        target: { resource: "job", id: "job-1" },
        parameters: { limit: 1 },
      }),
    ).toThrow(/does not accept/u);
    expect(() =>
      validateOperationCommand({
        action: "retention.reap",
        target: { resource: "retention" },
        parameters: { limit: 1_001 },
      }),
    ).toThrow(/bounded/u);
    expect(() =>
      validateOperationCommand({
        action: "knowledgeSource.synchronize",
        target: { resource: "knowledgeSource", id: "source-1" },
        parameters: { kind: "fullRescan" },
      }),
    ).toThrow(/knowledge source/iu);
  });

  it("rejects malformed runtime commands before they can be previewed or digested", () => {
    expect(() =>
      validateOperationCommand({
        action: "not-a-real-action",
        target: { resource: "job", id: "job-1" },
        parameters: {},
      } as never),
    ).toThrow(/action is invalid/u);
    expect(() =>
      validateOperationCommand({
        action: "job.cancel",
        target: { resource: "job", id: "job-1" },
        parameters: [],
      } as never),
    ).toThrow(/command is invalid/u);
    expect(() =>
      validateOperationCommand({
        action: "job.cancel",
        target: null,
        parameters: {},
      } as never),
    ).toThrow(/command is invalid/u);
  });
});
