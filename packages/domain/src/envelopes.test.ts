import { describe, expect, it } from "vitest";

import {
  analysisTriggerId,
  analysisTriggerRequestId,
  analysisTriggerVersionId,
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

describe("analysis trigger command envelopes", () => {
  it("creates a target-free, exact-pinned case-discovery command", () => {
    const envelope = createEnvelope({
      ...envelopeMetadata,
      type: "analysis.discover.v1",
      payload: {
        scheduleId: "intake-schedule-1",
        scheduleConfigurationVersionId: "intake-schedule-version-3",
        triggerId: analysisTriggerId("trigger-1"),
        triggerVersionId: analysisTriggerVersionId("trigger-version-2"),
        connectorRegistrationId: "connector-1",
        connectorConfigurationVersionId: "connector-configuration-8",
        occurrenceKey: "occurrence-1",
      },
    });

    expect(envelope).toMatchObject<EnvelopeFor<"analysis.discover.v1">>({
      type: "analysis.discover.v1",
      kind: "command",
      payload: {
        scheduleId: "intake-schedule-1",
        scheduleConfigurationVersionId: "intake-schedule-version-3",
        triggerId: "trigger-1",
        triggerVersionId: "trigger-version-2",
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("cursor");
    expect(JSON.stringify(envelope)).not.toContain("secret");
  });

  it("creates a version-pinned trigger v2 command without configuration data", () => {
    const envelope = createEnvelope({
      ...envelopeMetadata,
      type: "analysis.trigger.v2",
      payload: {
        triggerRequestId: analysisTriggerRequestId("trigger-request-1"),
        triggerId: analysisTriggerId("trigger-1"),
        triggerVersionId: analysisTriggerVersionId("trigger-version-2"),
        connectorRegistrationId: "connector-1",
        connectorConfigurationVersionId: "connector-configuration-8",
        source: "webhook",
        occurrenceKey: "occurrence-1",
        target: {
          connectorInstanceId: "connector-1",
          resourceType: "case",
          externalId: "case-1",
        },
      },
    });

    expect(envelope).toMatchObject<EnvelopeFor<"analysis.trigger.v2">>({
      type: "analysis.trigger.v2",
      payload: {
        triggerRequestId: "trigger-request-1",
        triggerId: "trigger-1",
        triggerVersionId: "trigger-version-2",
        connectorRegistrationId: "connector-1",
        connectorConfigurationVersionId: "connector-configuration-8",
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("secret");
  });

  it("deserializes legacy v1 trigger work only for a stable unavailable outcome", () => {
    const serialized = {
      ...envelopeMetadata,
      type: "analysis.trigger.v1",
      payload: {
        triggerId: "legacy-trigger-1",
        source: "schedule",
      },
    };

    const envelope = deserializeEnvelope(serialized);

    expect(envelope).toMatchObject<EnvelopeFor<"analysis.trigger.v1">>({
      type: "analysis.trigger.v1",
      payload: {
        triggerId: "legacy-trigger-1",
        source: "schedule",
        legacy: true,
      },
    });
    expect(serialized.payload).not.toHaveProperty("legacy");
  });

  it("does not permit new v1 trigger commands", () => {
    expect(() =>
      createEnvelope({
        ...envelopeMetadata,
        type: "analysis.trigger.v1",
        payload: {
          triggerId: "legacy-trigger-1",
          source: "manual",
          legacy: true,
        },
      } as never),
    ).toThrow("Legacy analysis trigger command envelopes cannot be emitted.");
  });
});

describe("knowledge command envelopes", () => {
  it("keeps existing reaper v1 envelopes valid while accepting a bounded batch hint", () => {
    const legacyShape = deserializeEnvelope({
      ...envelopeMetadata,
      type: "retention.reap.v1",
      payload: { reason: "scheduled" },
    });
    const bounded = createEnvelope({
      ...envelopeMetadata,
      type: "retention.reap.v1",
      payload: { reason: "operator", limit: 25 },
    });

    expect(legacyShape).toMatchObject<EnvelopeFor<"retention.reap.v1">>({
      payload: { reason: "scheduled" },
    });
    expect(bounded).toMatchObject<EnvelopeFor<"retention.reap.v1">>({
      payload: { reason: "operator", limit: 25 },
    });
    expect(() =>
      deserializeEnvelope({
        ...envelopeMetadata,
        type: "retention.reap.v1",
        payload: { reason: "scheduled", limit: 0 },
      }),
    ).toThrow("Envelope payload is invalid");
  });

  it("creates a typed, version-pinned manual synchronization command", () => {
    const envelope = createEnvelope({
      ...envelopeMetadata,
      type: "knowledge.synchronize.v2",
      payload: {
        sourceId: "knowledge-source-1",
        sourceConfigurationVersionId: "source-configuration-1",
        connectorConfigurationVersionId: "connector-configuration-1",
        trigger: "manual",
      },
    });

    expect(envelope).toMatchObject<EnvelopeFor<"knowledge.synchronize.v2">>({
      type: "knowledge.synchronize.v2",
      kind: "command",
      payload: {
        sourceId: "knowledge-source-1",
        sourceConfigurationVersionId: "source-configuration-1",
        connectorConfigurationVersionId: "connector-configuration-1",
        trigger: "manual",
      },
    });
    expect(Object.isFrozen(envelope.payload)).toBe(true);
  });

  it("deserializes a version-pinned scheduled full-rescan command", () => {
    const envelope = deserializeEnvelope({
      ...envelopeMetadata,
      type: "knowledge.full-rescan.v2",
      payload: {
        sourceId: "knowledge-source-1",
        sourceConfigurationVersionId: "source-configuration-2",
        connectorConfigurationVersionId: "connector-configuration-2",
        trigger: "schedule",
      },
    });

    expect(envelope).toMatchObject<EnvelopeFor<"knowledge.full-rescan.v2">>({
      type: "knowledge.full-rescan.v2",
      kind: "command",
      payload: {
        sourceId: "knowledge-source-1",
        sourceConfigurationVersionId: "source-configuration-2",
        connectorConfigurationVersionId: "connector-configuration-2",
        trigger: "schedule",
      },
    });
  });

  it("classifies a deserialized v1 knowledge command as legacy without mutating its persisted shape", () => {
    const serialized = {
      ...envelopeMetadata,
      type: "knowledge.synchronize.v1",
      payload: {
        sourceId: "knowledge-source-1",
        configurationVersion: "historical-source-configuration-1",
        trigger: "schedule",
      },
    };

    const envelope = deserializeEnvelope(serialized);

    expect(envelope).toMatchObject<EnvelopeFor<"knowledge.synchronize.v1">>({
      type: "knowledge.synchronize.v1",
      payload: {
        sourceId: "knowledge-source-1",
        configurationVersion: "historical-source-configuration-1",
        trigger: "schedule",
        legacy: true,
      },
    });
    expect(serialized.payload).not.toHaveProperty("legacy");
    expect(envelope.payload).not.toHaveProperty(
      "connectorConfigurationVersionId",
    );
  });

  it("does not permit typed producers to emit legacy v1 knowledge commands", () => {
    expect(() =>
      createEnvelope({
        ...envelopeMetadata,
        type: "knowledge.full-rescan.v1",
        payload: {
          sourceId: "knowledge-source-1",
          configurationVersion: "historical-source-configuration-1",
          trigger: "manual",
        },
      } as never),
    ).toThrow("Legacy knowledge command envelopes cannot be emitted.");
  });

  it("rejects invalid knowledge command payloads", () => {
    expect(() =>
      deserializeEnvelope({
        ...envelopeMetadata,
        type: "knowledge.synchronize.v2",
        payload: {
          sourceId: "knowledge-source-1",
          connectorConfigurationVersionId: "connector-configuration-1",
          trigger: "manual",
        },
      }),
    ).toThrow("Envelope is invalid");
    expect(() =>
      deserializeEnvelope({
        ...envelopeMetadata,
        type: "knowledge.synchronize.v2",
        payload: {
          sourceId: "",
          sourceConfigurationVersionId: "source-configuration-1",
          connectorConfigurationVersionId: "connector-configuration-1",
          trigger: "manual",
        },
      }),
    ).toThrow("Envelope is invalid");

    expect(() =>
      deserializeEnvelope({
        ...envelopeMetadata,
        type: "knowledge.full-rescan.v2",
        payload: {
          sourceId: "knowledge-source-1",
          sourceConfigurationVersionId: "source-configuration-1",
          connectorConfigurationVersionId: 1,
          trigger: "manual",
        },
      }),
    ).toThrow("Envelope is invalid");

    expect(() =>
      deserializeEnvelope({
        ...envelopeMetadata,
        type: "knowledge.full-rescan.v2",
        payload: {
          sourceId: "knowledge-source-1",
          sourceConfigurationVersionId: "source-configuration-1",
          trigger: "manual",
        },
      }),
    ).toThrow("Envelope is invalid");
    expect(() =>
      deserializeEnvelope({
        ...envelopeMetadata,
        type: "knowledge.full-rescan.v2",
        payload: {
          sourceId: "knowledge-source-1",
          sourceConfigurationVersionId: "source-configuration-1",
          connectorConfigurationVersionId: "connector-configuration-1",
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
