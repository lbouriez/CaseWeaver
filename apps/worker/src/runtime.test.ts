import {
  analysisIdentityId,
  analysisJobId,
  analysisResultId,
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
  createWorkerCommandDispatcher,
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

function createAnalysisRuntime(input: {
  readonly knowledge: KnowledgeCommandHandlers;
  readonly execute: ReturnType<typeof vi.fn>;
}) {
  return createWorkerRuntime(
    createWorkerCommandDispatcher({
      ...input.knowledge,
      analysis: { execute: { handle: input.execute } },
    }),
  );
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
      payload: {
        sourceId: "knowledge-source-1",
        configurationVersion: "knowledge-source-version-1",
        trigger: "manual",
      },
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
      payload: {
        sourceId: "knowledge-source-1",
        configurationVersion: "knowledge-source-version-1",
        trigger: "manual",
      },
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

  it("registers analysis execution without routing a completed event", async () => {
    const execute = vi.fn(async () => {});
    const runtime = createAnalysisRuntime({
      knowledge: {
        synchronize: { handle: async () => {} },
        fullRescan: { handle: async () => {} },
      },
      execute,
    });
    const envelope = createEnvelope({
      ...envelopeMetadata,
      type: "analysis.execute.v1",
      payload: {
        analysisJobId: analysisJobId("analysis-job-1"),
        analysisIdentityId: analysisIdentityId("analysis-identity-1"),
      },
    });
    const signal = new AbortController().signal;

    await runtime.consume(envelope, signal);

    expect(execute).toHaveBeenCalledWith(envelope, signal);
    await expect(
      runtime.consume(
        createEnvelope({
          ...envelopeMetadata,
          id: outboxEnvelopeId("outbox-completed-1"),
          kind: "domainEvent",
          type: "analysis.completed.v1",
          payload: {
            analysisJobId: analysisJobId("analysis-job-1"),
            analysisResultId: analysisResultId("analysis-result-1"),
          },
        }),
        signal,
      ),
    ).rejects.toMatchObject({ code: "worker.unsupportedEnvelope" });
  });

  it("routes retention purge through the durable operations handler", async () => {
    const purge = vi.fn(async () => {});
    const runtime = createWorkerRuntime(
      createWorkerCommandDispatcher({
        synchronize: { handle: async () => {} },
        fullRescan: { handle: async () => {} },
        analysis: { execute: { handle: async () => {} } },
        operations: {
          retention: {
            reap: { handle: async () => {} },
            purge: { handle: purge },
          },
        },
      }),
    );
    const envelope = createEnvelope({
      ...envelopeMetadata,
      type: "retention.purge.v1",
      payload: { workItemId: "retention-work-1" },
    });
    const signal = new AbortController().signal;

    await runtime.consume(envelope, signal);

    expect(purge).toHaveBeenCalledWith(envelope, signal);
  });

  it("routes the opaque diagnostic export command only when its handler is composed", async () => {
    const generate = vi.fn(async () => {});
    const runtime = createWorkerRuntime(
      createWorkerCommandDispatcher({
        synchronize: { handle: async () => {} },
        fullRescan: { handle: async () => {} },
        analysis: { execute: { handle: async () => {} } },
        diagnostics: { generate: { handle: generate } },
      }),
    );
    const envelope = createEnvelope({
      ...envelopeMetadata,
      id: outboxEnvelopeId("outbox-diagnostic-export-1"),
      type: "diagnostics.export.generate.v1",
      payload: { exportId: "diagnostic-export-1" },
    });
    const signal = new AbortController().signal;

    await runtime.consume(envelope, signal);

    expect(generate).toHaveBeenCalledWith(envelope, signal);
  });
});
