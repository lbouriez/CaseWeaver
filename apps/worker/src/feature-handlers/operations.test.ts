import {
  createEnvelope,
  outboxEnvelopeId,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { describe, expect, it, vi } from "vitest";

import { createOperationsHandlers } from "./operations.js";

const metadata = {
  id: outboxEnvelopeId("retention-handler-envelope"),
  kind: "command" as const,
  schemaVersion: 1,
  workspaceId: workspaceId("workspace-retention-handler"),
  occurredAt: utcInstant("2026-07-15T00:00:00.000Z"),
  correlationId: "correlation-retention-handler",
  causationId: "causation-retention-handler",
};

describe("retention worker handlers", () => {
  it("delegates reaping and fenced purge through the application use cases", async () => {
    const reaper = { execute: vi.fn(async () => undefined) };
    const purge = { execute: vi.fn(async () => undefined) };
    const handlers = createOperationsHandlers({
      retention: { reaper, purge },
    });
    const signal = new AbortController().signal;
    const reap = createEnvelope({
      ...metadata,
      type: "retention.reap.v1",
      payload: { reason: "scheduled" },
    });
    const purgeCommand = createEnvelope({
      ...metadata,
      id: outboxEnvelopeId("retention-handler-purge"),
      type: "retention.purge.v1",
      payload: { workItemId: "retention-work-item" },
    });

    await handlers.retention.reap.handle(reap, signal);
    await handlers.retention.purge.handle(purgeCommand, signal);

    expect(reaper.execute).toHaveBeenCalledWith(reap, signal);
    expect(purge.execute).toHaveBeenCalledWith(
      metadata.workspaceId,
      "retention-work-item",
      signal,
    );
  });
});
