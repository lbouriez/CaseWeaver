import {
  analysisIdentityId,
  analysisJobId,
  causationId,
  correlationId,
  createEnvelope,
  outboxEnvelopeId,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { describe, expect, it, vi } from "vitest";

import { createAnalysisExecuteHandler } from "./analysis.js";

describe("analysis feature handler", () => {
  it("uses the prebuilt real execution service without manufacturing stage ports", async () => {
    const execute = vi.fn(async () => undefined);
    const create = vi.fn(() => ({ execute }));
    const handler = createAnalysisExecuteHandler({ create });
    const command = createEnvelope({
      id: outboxEnvelopeId("outbox-analysis-feature-1"),
      kind: "command",
      type: "analysis.execute.v1",
      schemaVersion: 1,
      workspaceId: workspaceId("workspace-1"),
      occurredAt: utcInstant("2026-07-15T12:00:00.000Z"),
      correlationId: correlationId("correlation-1"),
      causationId: causationId("causation-1"),
      payload: {
        analysisJobId: analysisJobId("analysis-job-1"),
        analysisIdentityId: analysisIdentityId("analysis-identity-1"),
      },
    });
    const signal = new AbortController().signal;

    await handler.handle(command, signal);

    expect(create).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(command, signal);
  });
});
