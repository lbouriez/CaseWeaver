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

import { createProductionWorkerCommandHandlers } from "./production-composition.js";

const metadata = {
  id: outboxEnvelopeId("outbox-worker-composition-1"),
  schemaVersion: 1 as const,
  workspaceId: workspaceId("workspace-1"),
  occurredAt: utcInstant("2026-07-15T12:00:00.000Z"),
  correlationId: correlationId("correlation-1"),
  causationId: causationId("causation-1"),
};

describe("production worker command composition", () => {
  it("delegates diagnostics, analysis, and completed-analysis publication scheduling", async () => {
    const claimGeneration = vi.fn(async () => undefined);
    const analysisExecute = vi.fn(async () => ({ kind: "alreadyRunning" }));
    const create = vi.fn(() => ({ execute: analysisExecute }));
    const captureAndSubmit = vi.fn(async () => ({ submitted: true }));
    const deliverPublication = vi.fn(async () => ({ published: true }));
    const schedulePublication = vi.fn(async () => ({ scheduled: 1 }));
    const handlers = createProductionWorkerCommandHandlers({
      knowledge: {
        sourceConfigurations: {
          resolve: vi.fn(async () => undefined),
        } as never,
        connectors: { resolveKnowledgeSource: vi.fn() } as never,
        coordinator: { execute: vi.fn() } as never,
      },
      diagnostics: {
        requests: { claimGeneration } as never,
        source: {} as never,
        artifacts: {} as never,
        digest: {} as never,
        clock: { now: () => "2026-07-15T12:00:00.000Z" },
      },
      analysis: { create },
      publication: {
        trigger: { trigger: captureAndSubmit },
        executor: { execute: deliverPublication },
        completedAnalysis: { complete: schedulePublication },
      },
      operations: {
        retention: {
          reaper: { execute: vi.fn(async () => undefined) },
          purge: { execute: vi.fn(async () => undefined) },
        },
      },
    });
    const publication = handlers.publication;
    const diagnostics = handlers.diagnostics;
    if (publication === undefined || diagnostics === undefined) {
      throw new Error("Production composition must register known handlers.");
    }
    const signal = new AbortController().signal;
    const analysis = createEnvelope({
      ...metadata,
      kind: "command",
      type: "analysis.execute.v1",
      payload: {
        analysisJobId: analysisJobId("analysis-job-1"),
        analysisIdentityId: analysisIdentityId("analysis-identity-1"),
      },
    });
    const completed = createEnvelope({
      ...metadata,
      id: outboxEnvelopeId("outbox-analysis-completed-1"),
      kind: "domainEvent",
      type: "analysis.completed.v1",
      payload: {
        analysisJobId: analysisJobId("analysis-job-1"),
        analysisResultId: analysisResultId("analysis-result-1"),
      },
    });
    const diagnostic = createEnvelope({
      ...metadata,
      id: outboxEnvelopeId("outbox-diagnostic-export-1"),
      kind: "command",
      type: "diagnostics.export.generate.v1",
      payload: { exportId: "diagnostic-export-1" },
    });

    await handlers.analysis.execute.handle(analysis, signal);
    await publication.analysisCompleted.handle(completed, signal);
    await diagnostics.generate.handle(diagnostic, signal);

    expect(create).toHaveBeenCalledOnce();
    expect(analysisExecute).toHaveBeenCalledWith(analysis, signal);
    expect(schedulePublication).toHaveBeenCalledWith(completed);
    expect(claimGeneration).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      exportId: "diagnostic-export-1",
      now: "2026-07-15T12:00:00.000Z",
    });
  });

  it("fails unconfigured knowledge before I/O and dispatches registered workflows", async () => {
    const deliverPublication = vi.fn(async () => undefined);
    const purge = vi.fn(async () => undefined);
    const handlers = createProductionWorkerCommandHandlers({
      knowledge: {
        sourceConfigurations: {
          resolve: vi.fn(async () => undefined),
        } as never,
        connectors: { resolveKnowledgeSource: vi.fn() } as never,
        coordinator: { execute: vi.fn() } as never,
      },
      diagnostics: {
        requests: {} as never,
        source: {} as never,
        artifacts: {} as never,
        digest: {} as never,
        clock: { now: () => "2026-07-15T12:00:00.000Z" },
      },
      analysis: { create: () => ({ execute: async () => undefined }) },
      publication: {
        trigger: { trigger: async () => undefined },
        executor: { execute: deliverPublication },
        completedAnalysis: { complete: async () => undefined },
      },
      operations: {
        retention: {
          reaper: { execute: async () => undefined },
          purge: { execute: purge },
        },
      },
    });
    const publication = handlers.publication;
    const operations = handlers.operations;
    if (publication === undefined || operations === undefined) {
      throw new Error("Production composition must register known handlers.");
    }
    const signal = new AbortController().signal;
    const synchronize = createEnvelope({
      ...metadata,
      kind: "command",
      type: "knowledge.synchronize.v2",
      payload: {
        sourceId: "source-1",
        sourceConfigurationVersionId: "source-version-1",
        connectorConfigurationVersionId: "connector-version-1",
        trigger: "manual",
      },
    });
    const publish = createEnvelope({
      ...metadata,
      kind: "command",
      type: "publication.execute.v1",
      payload: { publicationIntentId: "publication-intent-1" },
    });
    const purgeCommand = createEnvelope({
      ...metadata,
      kind: "command",
      type: "retention.purge.v1",
      payload: { workItemId: "retention-work-1" },
    });

    await expect(
      handlers.synchronize.handle(synchronize, signal),
    ).rejects.toMatchObject({
      code: "knowledge.runtimeUnavailable",
      retryable: false,
    });
    await publication.delivery.execute.handle(publish, signal);
    await operations.retention.purge.handle(purgeCommand, signal);
    expect(deliverPublication).toHaveBeenCalledWith(publish, signal);
    expect(purge).toHaveBeenCalledWith(
      "workspace-1",
      "retention-work-1",
      signal,
    );
  });
});
