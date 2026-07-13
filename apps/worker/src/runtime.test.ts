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

import {
  createKnowledgeCommandDispatcher,
  createWorkerRuntime,
  type KnowledgeCommandHandlers,
} from "./runtime.js";

const envelopeMetadata = {
  id: outboxEnvelopeId("outbox-knowledge-1"),
  kind: "command" as const,
  schemaVersion: 1 as const,
  workspaceId: workspaceId("workspace-1"),
  occurredAt: utcInstant("2026-07-13T20:00:00.000Z"),
  correlationId: correlationId("correlation-1"),
  causationId: causationId("causation-1"),
};

function createRuntime(handlers: KnowledgeCommandHandlers) {
  return createWorkerRuntime(createKnowledgeCommandDispatcher(handlers));
}

describe("worker command runtime", () => {
  it("dispatches a synchronization command to its injected handler", async () => {
    const synchronize = vi.fn(async () => {});
    const fullRescan = vi.fn(async () => {});
    const runtime = createRuntime({
      synchronize: { handle: synchronize },
      fullRescan: { handle: fullRescan },
    });
    const envelope = createEnvelope({
      ...envelopeMetadata,
      type: "knowledge.synchronize.v1",
      payload: { sourceId: "knowledge-source-1" },
    });
    const signal = new AbortController().signal;

    await runtime.consume(envelope, signal);

    expect(synchronize).toHaveBeenCalledWith(envelope, signal);
    expect(fullRescan).not.toHaveBeenCalled();
  });

  it("dispatches a full-rescan command to its injected handler", async () => {
    const synchronize = vi.fn(async () => {});
    const fullRescan = vi.fn(async () => {});
    const runtime = createRuntime({
      synchronize: { handle: synchronize },
      fullRescan: { handle: fullRescan },
    });
    const envelope = createEnvelope({
      ...envelopeMetadata,
      type: "knowledge.full-rescan.v1",
      payload: { sourceId: "knowledge-source-1" },
    });
    const signal = new AbortController().signal;

    await runtime.consume(envelope, signal);

    expect(fullRescan).toHaveBeenCalledWith(envelope, signal);
    expect(synchronize).not.toHaveBeenCalled();
  });

  it("rejects unsupported envelopes", async () => {
    const runtime = createRuntime({
      synchronize: { handle: async () => {} },
      fullRescan: { handle: async () => {} },
    });
    const envelope = createEnvelope({
      ...envelopeMetadata,
      type: "analysis.execute.v1",
      payload: {
        analysisJobId: analysisJobId("analysis-job-1"),
        analysisIdentityId: analysisIdentityId("analysis-identity-1"),
      },
    });

    await expect(
      runtime.consume(envelope, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "worker.unsupportedEnvelope",
      retryable: false,
    });
  });
});
