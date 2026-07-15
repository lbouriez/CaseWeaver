import type { ExecutionContext } from "@caseweaver/application";
import {
  correlationId,
  principalId,
  publicationIntentId,
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
  databaseReadinessTimeoutMs: 500,
  workspaceId: "workspace-1",
  principalId: "principal-1",
  allowedAdminOrigins: [],
  trustedProxyCidrs: [],
};

const context: ExecutionContext = {
  requestId: requestId("request-1"),
  workspaceId: workspaceId("workspace-1"),
  principalId: principalId("principal-1"),
  correlationId: correlationId("correlation-1"),
  signal: new AbortController().signal,
};

const digest = "a".repeat(64);

function app(
  operations = {
    requestAnalysis: vi.fn(async () => ({
      analysisJobId: "job-1",
      publicationIntentId: "intent-1",
      replayed: false,
      preview: false,
    })),
    approvePublication: vi.fn(async () => ({
      approved: true,
      replayed: false,
    })),
  },
) {
  return {
    app: buildApi({
      config,
      logger: createLogger(config),
      readinessProbe: { check: async () => "ready" },
      publication: {
        context: { resolve: vi.fn(async () => context) },
        operations,
      },
    }),
    operations,
  };
}

describe("publication API routes", () => {
  it("uses injected authenticated context for a manual analysis-publication trigger", async () => {
    const built = app();
    const response = await built.app.inject({
      method: "POST",
      url: "/v1/analysis-publications",
      payload: {
        idempotencyKeyDigest: digest,
        requestDigest: digest,
        identityHash: digest,
        analysisProfileVersionId: "analysis-profile-1",
        caseSnapshotId: "snapshot-1",
        publication: {
          profileId: "profile-1",
          profileVersion: "1",
          target: {
            connectorInstanceId: "connector-1",
            resourceType: "case",
            externalId: "case-1",
          },
          intentHash: digest,
        },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(built.operations.requestAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        publication: expect.objectContaining({ dryRun: false }),
      }),
      context,
    );
    await built.app.close();
  });

  it("rejects malformed manual triggers before authorization composition", async () => {
    const built = app();

    const response = await built.app.inject({
      method: "POST",
      url: "/v1/analysis-publications",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(built.operations.requestAnalysis).not.toHaveBeenCalled();
    await built.app.close();
  });

  it("composes an approval with the authenticated execution context", async () => {
    const built = app();

    const response = await built.app.inject({
      method: "POST",
      url: "/v1/publication-intents/intent-1/approval",
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ approved: true, replayed: false });
    expect(built.operations.approvePublication).toHaveBeenCalledWith(
      publicationIntentId("intent-1"),
      context,
    );
    await built.app.close();
  });

  it("does not report a rejected approval as accepted", async () => {
    const built = app({
      requestAnalysis: vi.fn(),
      approvePublication: vi.fn(async () => ({
        approved: false,
        replayed: false,
      })),
    });

    const response = await built.app.inject({
      method: "POST",
      url: "/v1/publication-intents/missing/approval",
    });

    expect(response.statusCode).toBe(404);
    await built.app.close();
  });
});
