import type { ExecutionContext } from "@caseweaver/application";
import {
  correlationId,
  principalId,
  requestId,
  workspaceId,
} from "@caseweaver/domain";
import { describe, expect, it, vi } from "vitest";

import { buildApi } from "../../app.js";
import type { ApiConfig } from "../../config.js";
import { createLogger } from "../../logger.js";

const config: ApiConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  databaseUrl: "postgresql://localhost/caseweaver_test",
  workspaceId: "workspace-1",
  principalId: "principal-1",
  databaseReadinessTimeoutMs: 500,
};

const context: ExecutionContext = {
  requestId: requestId("request-1"),
  workspaceId: workspaceId("workspace-1"),
  principalId: principalId("principal-1"),
  correlationId: correlationId("correlation-1"),
  signal: new AbortController().signal,
};

const digest = "a".repeat(64);

function app() {
  const operations = {
    inspectDeadLetters: vi.fn(async () => []),
    retryDeadLetter: vi.fn(async () => ({
      analysisJobId: "replacement-1",
      replayed: false,
    })),
    cancelJob: vi.fn(async () => ({ cancelled: true, replayed: false })),
    recoverExpiredJob: vi.fn(async () => ({
      recovered: true,
      replayed: false,
    })),
    queryCosts: vi.fn(async () => []),
    purgeCaseSnapshot: vi.fn(async () => ({ purged: true, replayed: false })),
    queueRetention: vi.fn(async () => ({ queued: 1, replayed: false })),
  };
  return {
    operations,
    app: buildApi({
      config,
      logger: createLogger(config),
      readinessProbe: { check: async () => "ready" },
      pbi013: {
        context: { resolve: vi.fn(async () => context) },
        operations,
      },
    }),
  };
}

describe("PBI-013 API routes", () => {
  it("submits an idempotent dead-letter retry with the authenticated context", async () => {
    const built = app();
    const response = await built.app.inject({
      method: "POST",
      url: "/v1/operations/dead-letters/failed-job-1/retry",
      payload: { idempotencyKeyDigest: digest, requestDigest: digest },
    });

    expect(response.statusCode).toBe(202);
    expect(built.operations.retryDeadLetter).toHaveBeenCalledWith(
      "failed-job-1",
      { idempotencyKeyDigest: digest, requestDigest: digest },
      context,
    );
    await built.app.close();
  });

  it("validates exact cost filters and privacy purge input at the boundary", async () => {
    const built = app();
    const costs = await built.app.inject({
      method: "GET",
      url: "/v1/costs?analysisJobId=job-1&role=analysis&startedAfter=2026-07-14T18%3A00%3A00.000Z",
    });
    const purge = await built.app.inject({
      method: "POST",
      url: "/v1/privacy/case-snapshots/snapshot-1/purge",
      payload: {
        idempotencyKeyDigest: digest,
        requestDigest: digest,
        reason: "privacy request",
      },
    });

    expect(costs.statusCode).toBe(200);
    expect(built.operations.queryCosts).toHaveBeenCalledWith(
      expect.objectContaining({
        analysisJobId: "job-1",
        role: "analysis",
        startedAfter: "2026-07-14T18:00:00.000Z",
      }),
      context,
    );
    expect(purge.statusCode).toBe(202);
    expect(built.operations.purgeCaseSnapshot).toHaveBeenCalledWith(
      "snapshot-1",
      "privacy request",
      { idempotencyKeyDigest: digest, requestDigest: digest },
      context,
    );
    await built.app.close();
  });
});
