import { RuntimeConnectorCapabilityUnavailableError } from "@caseweaver/connector-runtime";
import {
  analysisJobId,
  analysisResultId,
  analysisTriggerId,
  analysisTriggerRequestId,
  analysisTriggerVersionId,
  causationId,
  correlationId,
  createEnvelope,
  outboxEnvelopeId,
  publicationIntentId,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { describe, expect, it, vi } from "vitest";

import {
  createPublicationService,
  createPublicationWorkflowHandlers,
  RuntimePublicationDestinationResolver,
} from "./index.js";

const metadata = {
  id: outboxEnvelopeId("outbox-1"),
  kind: "command" as const,
  schemaVersion: 1 as const,
  workspaceId: workspaceId("workspace-1"),
  occurredAt: utcInstant("2026-07-14T16:00:00.000Z"),
  correlationId: correlationId("correlation-1"),
  causationId: causationId("cause-1"),
};

describe("publication worker runtime", () => {
  it("resolves a destination only through the exact durable configuration pin", async () => {
    const destination = { publish: vi.fn(), findPublication: vi.fn() };
    const resolveAnalysisDestination = vi.fn(async () => destination);
    const resolver = new RuntimePublicationDestinationResolver({
      resolveAnalysisDestination,
    } as never);
    const signal = new AbortController().signal;

    await expect(
      resolver.resolve({
        workspaceId: "workspace-1",
        connectorRegistrationId: "connector-1",
        connectorConfigurationVersionId: "configuration-version-7",
        signal,
      }),
    ).resolves.toBe(destination);

    expect(resolveAnalysisDestination).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      connectorRegistrationId: "connector-1",
      connectorConfigurationVersionId: "configuration-version-7",
    });
  });

  it("fails closed without adapter I/O when the exact runtime capability is unavailable", async () => {
    const resolveAnalysisDestination = vi.fn(async () => {
      throw new RuntimeConnectorCapabilityUnavailableError();
    });
    const resolver = new RuntimePublicationDestinationResolver({
      resolveAnalysisDestination,
    } as never);

    await expect(
      resolver.resolve({
        workspaceId: "workspace-1",
        connectorRegistrationId: "connector-1",
        connectorConfigurationVersionId: "configuration-version-7",
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();
    expect(resolveAnalysisDestination).toHaveBeenCalledTimes(1);
  });

  it("does not resolve a destination after cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const resolveAnalysisDestination = vi.fn();
    const resolver = new RuntimePublicationDestinationResolver({
      resolveAnalysisDestination,
    } as never);

    await expect(
      resolver.resolve({
        workspaceId: "workspace-1",
        connectorRegistrationId: "connector-1",
        connectorConfigurationVersionId: "configuration-version-7",
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(resolveAnalysisDestination).not.toHaveBeenCalled();
  });

  it("forwards execute and reconciliation envelopes to one injected executor", async () => {
    const execute = vi.fn(async () => undefined);
    const service = createPublicationService({ execute });
    const signal = new AbortController().signal;
    const publication = createEnvelope({
      ...metadata,
      type: "publication.execute.v1",
      payload: { publicationIntentId: publicationIntentId("intent-1") },
    });
    const reconciliation = createEnvelope({
      ...metadata,
      id: outboxEnvelopeId("outbox-reconcile-1"),
      type: "publication.reconcile.v1",
      payload: { publicationIntentId: publicationIntentId("intent-1") },
    });

    await service.execute(publication, signal);
    await service.reconcile(reconciliation, signal);

    expect(execute).toHaveBeenNthCalledWith(1, publication, signal);
    expect(execute).toHaveBeenNthCalledWith(2, reconciliation, signal);
  });

  it("routes only a version-pinned trigger to the injected capture service", async () => {
    const trigger = vi.fn(async () => undefined);
    const handlers = createPublicationWorkflowHandlers({
      trigger: { trigger },
      publication: createPublicationService({ execute: async () => undefined }),
      analysisCompleted: { complete: async () => undefined },
    });
    const command = createEnvelope({
      ...metadata,
      id: outboxEnvelopeId("analysis-trigger-v2-1"),
      type: "analysis.trigger.v2",
      payload: {
        triggerRequestId: analysisTriggerRequestId("trigger-request-1"),
        triggerId: analysisTriggerId("trigger-1"),
        triggerVersionId: analysisTriggerVersionId("trigger-version-1"),
        connectorRegistrationId: "connector-1",
        connectorConfigurationVersionId: "connector-configuration-1",
        source: "manual",
        target: {
          connectorInstanceId: "connector-1",
          resourceType: "case",
          externalId: "case-1",
        },
      },
    });
    const signal = new AbortController().signal;

    await handlers.trigger.handle(command, signal);

    expect(trigger).toHaveBeenCalledWith(command, signal);
  });

  it("routes analysis completion only to the durable publication scheduler", async () => {
    const complete = vi.fn(async () => undefined);
    const handlers = createPublicationWorkflowHandlers({
      trigger: { trigger: async () => undefined },
      publication: createPublicationService({ execute: async () => undefined }),
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
});
