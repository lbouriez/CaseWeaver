import { describe, expect, it } from "vitest";

import {
  causationId,
  correlationId,
  createEnvelope,
  deserializeEnvelope,
  type EnvelopeFor,
  outboxEnvelopeId,
  utcInstant,
  workspaceId,
} from "./index.js";

const envelopeMetadata = {
  id: outboxEnvelopeId("outbox-knowledge-1"),
  kind: "command" as const,
  schemaVersion: 1 as const,
  workspaceId: workspaceId("workspace-1"),
  occurredAt: utcInstant("2026-07-13T20:00:00.000Z"),
  correlationId: correlationId("correlation-1"),
  causationId: causationId("causation-1"),
};

describe("knowledge command envelopes", () => {
  it("creates a typed, version-pinned manual synchronization command", () => {
    const envelope = createEnvelope({
      ...envelopeMetadata,
      type: "knowledge.synchronize.v1",
      payload: {
        sourceId: "knowledge-source-1",
        configurationVersion: "source-configuration-1",
        trigger: "manual",
      },
    });

    expect(envelope).toMatchObject<EnvelopeFor<"knowledge.synchronize.v1">>({
      type: "knowledge.synchronize.v1",
      kind: "command",
      payload: {
        sourceId: "knowledge-source-1",
        configurationVersion: "source-configuration-1",
        trigger: "manual",
      },
    });
    expect(Object.isFrozen(envelope.payload)).toBe(true);
  });

  it("deserializes a version-pinned scheduled full-rescan command", () => {
    const envelope = deserializeEnvelope({
      ...envelopeMetadata,
      type: "knowledge.full-rescan.v1",
      payload: {
        sourceId: "knowledge-source-1",
        configurationVersion: "source-configuration-2",
        trigger: "schedule",
      },
    });

    expect(envelope).toMatchObject<EnvelopeFor<"knowledge.full-rescan.v1">>({
      type: "knowledge.full-rescan.v1",
      kind: "command",
      payload: {
        sourceId: "knowledge-source-1",
        configurationVersion: "source-configuration-2",
        trigger: "schedule",
      },
    });
  });

  it("rejects invalid knowledge command payloads", () => {
    expect(() =>
      deserializeEnvelope({
        ...envelopeMetadata,
        type: "knowledge.synchronize.v1",
        payload: {
          sourceId: "",
          configurationVersion: "source-configuration-1",
          trigger: "manual",
        },
      }),
    ).toThrow("Envelope is invalid");

    expect(() =>
      deserializeEnvelope({
        ...envelopeMetadata,
        type: "knowledge.full-rescan.v1",
        payload: {
          sourceId: "knowledge-source-1",
          configurationVersion: 1,
          trigger: "manual",
        },
      }),
    ).toThrow("Envelope is invalid");
    expect(() =>
      deserializeEnvelope({
        ...envelopeMetadata,
        type: "knowledge.full-rescan.v1",
        payload: {
          sourceId: "knowledge-source-1",
          configurationVersion: "source-configuration-1",
          trigger: "webhook",
        },
      }),
    ).toThrow("Envelope payload is invalid");
  });

  it("preserves only validated W3C trace context on a durable retention command", () => {
    const envelope = createEnvelope({
      ...envelopeMetadata,
      type: "retention.purge.v1",
      traceContext: {
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      },
      payload: { workItemId: "retention-work-1" },
    });

    expect(envelope.traceContext).toEqual({
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    });
    expect(() =>
      deserializeEnvelope({
        ...envelopeMetadata,
        type: "retention.purge.v1",
        traceContext: { traceparent: "not-a-traceparent" },
        payload: { workItemId: "retention-work-1" },
      }),
    ).toThrow("trace context");
  });

  it("accepts a bounded diagnostic-export command without diagnostic content", () => {
    const envelope = createEnvelope({
      ...envelopeMetadata,
      id: outboxEnvelopeId("outbox-diagnostics-export-1"),
      type: "diagnostics.export.generate.v1",
      payload: { exportId: "diagnostic-export-1" },
    });

    expect(envelope).toMatchObject<
      EnvelopeFor<"diagnostics.export.generate.v1">
    >({
      type: "diagnostics.export.generate.v1",
      kind: "command",
      payload: { exportId: "diagnostic-export-1" },
    });
    expect(() =>
      deserializeEnvelope({
        ...envelopeMetadata,
        type: "diagnostics.export.generate.v1",
        payload: { exportId: "" },
      }),
    ).toThrow("Envelope is invalid");
  });
});
