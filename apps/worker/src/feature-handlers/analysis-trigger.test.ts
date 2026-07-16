import type { AnalysisTriggerRequest } from "@caseweaver/application";
import { RuntimeConnectorCapabilityUnavailableError } from "@caseweaver/connector-runtime";
import {
  analysisProfileVersionId,
  analysisTriggerId,
  analysisTriggerRequestId,
  analysisTriggerVersionId,
  causationId,
  correlationId,
  createEnvelope,
  outboxEnvelopeId,
  sha256Digest,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { describe, expect, it, vi } from "vitest";

import {
  AnalysisTriggerCaptureIntegrityError,
  AnalysisTriggerRuntimeUnavailableError,
  createAnalysisTriggerCaptureHandler,
  RuntimeCaseSourceSnapshotCapture,
} from "./analysis-trigger.js";

const signal = new AbortController().signal;
const request: AnalysisTriggerRequest = {
  id: analysisTriggerRequestId("trigger-request-1"),
  workspaceId: workspaceId("workspace-1"),
  triggerId: analysisTriggerId("trigger-1"),
  triggerVersionId: analysisTriggerVersionId("trigger-version-1"),
  analysisProfileVersionId: analysisProfileVersionId("profile-version-1"),
  connectorRegistrationId: "connector-1",
  connectorConfigurationVersionId: "connector-configuration-1",
  source: "webhook",
  target: {
    connectorInstanceId: "connector-1",
    resourceType: "case",
    externalId: "case-1",
  },
  idempotencyKeyDigest: sha256Digest("a".repeat(64)),
  requestDigest: sha256Digest("b".repeat(64)),
};

const command = createEnvelope({
  id: outboxEnvelopeId("analysis-trigger-handler-1"),
  kind: "command",
  type: "analysis.trigger.v2",
  schemaVersion: 1,
  workspaceId: request.workspaceId,
  occurredAt: utcInstant("2026-07-15T20:00:00.000Z"),
  correlationId: correlationId("correlation-1"),
  causationId: causationId("causation-1"),
  payload: {
    triggerRequestId: request.id,
    triggerId: request.triggerId,
    triggerVersionId: request.triggerVersionId,
    connectorRegistrationId: request.connectorRegistrationId,
    connectorConfigurationVersionId: request.connectorConfigurationVersionId,
    source: request.source,
    target: request.target,
  },
});

describe("analysis trigger worker capture", () => {
  it("uses the exact durable connector pin before loading the persisted target", async () => {
    const normalizedCase = { reference: request.target };
    const loadCase = vi.fn(async () => normalizedCase);
    const resolveCaseSource = vi.fn(async () => ({ loadCase }));
    const project = vi.fn(async () => ({
      revision: "revision-1",
      capturedAt: utcInstant("2026-07-15T20:00:01.000Z"),
      title: "Case title",
      summary: "Case summary",
      contentHash: sha256Digest("c".repeat(64)),
      messages: [],
    }));
    const capture = new RuntimeCaseSourceSnapshotCapture(
      { resolveCaseSource } as never,
      { project },
    );

    await capture.capture({ request, signal });

    expect(resolveCaseSource).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      connectorRegistrationId: "connector-1",
      connectorConfigurationVersionId: "connector-configuration-1",
    });
    expect(loadCase).toHaveBeenCalledWith({
      reference: request.target,
      requestId: "trigger-request-1",
      signal,
    });
    expect(project).toHaveBeenCalledWith({ request, normalizedCase, signal });
  });

  it("fails before connector I/O when the immutable runtime pin is unavailable", async () => {
    const project = vi.fn();
    const resolveCaseSource = vi.fn(async () => {
      throw new RuntimeConnectorCapabilityUnavailableError();
    });
    const capture = new RuntimeCaseSourceSnapshotCapture(
      {
        resolveCaseSource,
      } as never,
      { project },
    );

    await expect(capture.capture({ request, signal })).rejects.toBeInstanceOf(
      AnalysisTriggerRuntimeUnavailableError,
    );
    expect(resolveCaseSource).toHaveBeenCalledTimes(1);
    expect(project).not.toHaveBeenCalled();
  });

  it("does not project a connector response for a different persisted target", async () => {
    const project = vi.fn();
    const capture = new RuntimeCaseSourceSnapshotCapture(
      {
        resolveCaseSource: vi.fn(async () => ({
          loadCase: vi.fn(async () => ({
            reference: {
              ...request.target,
              externalId: "different-case",
            },
          })),
        })),
      } as never,
      { project },
    );

    await expect(capture.capture({ request, signal })).rejects.toBeInstanceOf(
      AnalysisTriggerCaptureIntegrityError,
    );
    expect(project).not.toHaveBeenCalled();
  });

  it("does not load a case when cancellation occurs while resolving its runtime pin", async () => {
    const controller = new AbortController();
    const loadCase = vi.fn();
    const project = vi.fn();
    const capture = new RuntimeCaseSourceSnapshotCapture(
      {
        resolveCaseSource: vi.fn(async () => {
          controller.abort(new Error("Capture cancelled."));
          return { loadCase };
        }),
      } as never,
      { project },
    );

    await expect(
      capture.capture({ request, signal: controller.signal }),
    ).rejects.toThrow("Capture cancelled.");
    expect(loadCase).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
  });

  it("forwards only a v2 envelope to the capture use case", async () => {
    const execute = vi.fn(async () => undefined);
    const handler = createAnalysisTriggerCaptureHandler({ execute });

    await handler.handle(command, signal);

    expect(execute).toHaveBeenCalledWith(command, signal);
  });
});
