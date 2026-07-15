import {
  createEnvelope,
  causationId,
  correlationId,
  outboxEnvelopeId,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { describe, expect, it, vi } from "vitest";

import { createDiagnosticExportGenerateHandler } from "./diagnostic-export-handler.js";

describe("diagnostic export worker handler", () => {
  it("generates only the requested workspace-scoped export", async () => {
    const requests = {
      claimGeneration: vi.fn(async () => undefined),
    };
    const handler = createDiagnosticExportGenerateHandler({
      requests: requests as never,
      source: {} as never,
      artifacts: {} as never,
      digest: {} as never,
      clock: { now: () => "2026-07-15T12:00:00.000Z" },
    });
    const command = createEnvelope({
      id: outboxEnvelopeId("outbox-diagnostic-export-1"),
      kind: "command",
      type: "diagnostics.export.generate.v1",
      schemaVersion: 1,
      workspaceId: workspaceId("workspace-1"),
      occurredAt: utcInstant("2026-07-15T12:00:00.000Z"),
      correlationId: correlationId("correlation-1"),
      causationId: causationId("causation-1"),
      payload: { exportId: "diagnostic-export-1" },
    });

    await handler.handle(command, new AbortController().signal);

    expect(requests.claimGeneration).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      exportId: "diagnostic-export-1",
      now: "2026-07-15T12:00:00.000Z",
    });
  });
});
