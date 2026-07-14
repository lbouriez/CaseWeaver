import type { ExecutionContext } from "@caseweaver/application";
import {
  correlationId,
  principalId,
  requestId,
  workspaceId,
} from "@caseweaver/domain";
import { describe, expect, it, vi } from "vitest";

import { runPbi013Cli } from "./pbi-013.js";

const context: ExecutionContext = {
  requestId: requestId("request-1"),
  workspaceId: workspaceId("workspace-1"),
  principalId: principalId("principal-1"),
  correlationId: correlationId("correlation-1"),
  signal: new AbortController().signal,
};

const mutation = JSON.stringify({
  idempotencyKeyDigest: "a".repeat(64),
  requestDigest: "a".repeat(64),
});

function operations() {
  return {
    context,
    inspectDeadLetters: vi.fn(async () => []),
    retryDeadLetter: vi.fn(async () => ({ analysisJobId: "job-2" })),
    cancelJob: vi.fn(async () => ({ cancelled: true })),
    recoverExpiredJob: vi.fn(async () => ({ recovered: true })),
    queryCosts: vi.fn(async () => []),
    purgeCaseSnapshot: vi.fn(async () => ({ purged: true })),
    queueRetention: vi.fn(async () => ({ queued: 1 })),
  };
}

describe("PBI-013 CLI", () => {
  it("uses injected trusted context for a dead-letter retry", async () => {
    const output = { log: vi.fn(), error: vi.fn() };
    const injected = operations();

    await expect(
      runPbi013Cli(["retry", "job-1", mutation], output, injected),
    ).resolves.toBe(0);

    expect(injected.retryDeadLetter).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ requestDigest: "a".repeat(64) }),
      context,
    );
    expect(output.error).not.toHaveBeenCalled();
  });
});
