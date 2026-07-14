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

import { createAnalysisExecuteHandler } from "./index.js";

describe("PBI-011 analysis worker module", () => {
  it("forwards only analysis execution commands and cancellation to its injected service", async () => {
    const execute = vi.fn(async () => undefined);
    const handler = createAnalysisExecuteHandler({ execute });
    const command = createEnvelope({
      id: outboxEnvelopeId("outbox-analysis-1"),
      kind: "command",
      type: "analysis.execute.v1",
      schemaVersion: 1,
      workspaceId: workspaceId("workspace-1"),
      occurredAt: utcInstant("2026-07-14T15:00:00.000Z"),
      correlationId: correlationId("correlation-1"),
      causationId: causationId("causation-1"),
      payload: {
        analysisJobId: analysisJobId("analysis-job-1"),
        analysisIdentityId: analysisIdentityId("analysis-identity-1"),
      },
    });
    const signal = new AbortController().signal;

    await handler.handle(command, signal);

    expect(execute).toHaveBeenCalledWith(command, signal);
  });
});
