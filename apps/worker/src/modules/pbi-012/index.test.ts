import {
  analysisJobId,
  analysisResultId,
  causationId,
  correlationId,
  createEnvelope,
  outboxEnvelopeId,
  publicationIntentId,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { describe, expect, it, vi } from "vitest";

import { createPbi012Handlers } from "./index.js";

const metadata = {
  id: outboxEnvelopeId("outbox-1"),
  kind: "command" as const,
  schemaVersion: 1 as const,
  workspaceId: workspaceId("workspace-1"),
  occurredAt: utcInstant("2026-07-14T16:00:00.000Z"),
  correlationId: correlationId("correlation-1"),
  causationId: causationId("cause-1"),
};

describe("PBI-012 worker handlers", () => {
  it("routes analysis completion only to the durable publication scheduler", async () => {
    const complete = vi.fn(async () => undefined);
    const handlers = createPbi012Handlers({
      trigger: { trigger: async () => undefined },
      publication: {
        execute: async () => undefined,
        reconcile: async () => undefined,
      },
      analysisCompleted: { complete },
    });
    const event = createEnvelope({
      ...metadata,
      id: outboxEnvelopeId("analysis-completed-1"),
      kind: "domainEvent",
      type: "analysis.completed.v1",
      payload: {
        analysisJobId: analysisJobId("analysis-job-1"),
        analysisResultId: analysisResultId("analysis-result-1"),
      },
    });

    await handlers.analysisCompleted.handle(
      event,
      new AbortController().signal,
    );

    expect(complete).toHaveBeenCalledWith(event);
  });

  it("forwards publication reconciliation without selecting a destination", async () => {
    const reconcile = vi.fn(async () => undefined);
    const handlers = createPbi012Handlers({
      trigger: { trigger: async () => undefined },
      publication: { execute: async () => undefined, reconcile },
      analysisCompleted: { complete: async () => undefined },
    });
    const command = createEnvelope({
      ...metadata,
      type: "publication.reconcile.v1",
      payload: { publicationIntentId: publicationIntentId("intent-1") },
    });

    await handlers.publication.reconcile.handle(
      command,
      new AbortController().signal,
    );

    expect(reconcile).toHaveBeenCalledWith(command, expect.any(AbortSignal));
  });
});
