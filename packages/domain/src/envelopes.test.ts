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
  it("creates a typed synchronization command with a source ID", () => {
    const envelope = createEnvelope({
      ...envelopeMetadata,
      type: "knowledge.synchronize.v1",
      payload: { sourceId: "knowledge-source-1" },
    });

    expect(envelope).toMatchObject<EnvelopeFor<"knowledge.synchronize.v1">>({
      type: "knowledge.synchronize.v1",
      kind: "command",
      payload: { sourceId: "knowledge-source-1" },
    });
    expect(Object.isFrozen(envelope.payload)).toBe(true);
  });

  it("deserializes a full-rescan command with its source ID", () => {
    const envelope = deserializeEnvelope({
      ...envelopeMetadata,
      type: "knowledge.full-rescan.v1",
      payload: { sourceId: "knowledge-source-1" },
    });

    expect(envelope).toMatchObject<EnvelopeFor<"knowledge.full-rescan.v1">>({
      type: "knowledge.full-rescan.v1",
      kind: "command",
      payload: { sourceId: "knowledge-source-1" },
    });
  });

  it("rejects invalid knowledge command payloads", () => {
    expect(() =>
      deserializeEnvelope({
        ...envelopeMetadata,
        type: "knowledge.synchronize.v1",
        payload: { sourceId: "" },
      }),
    ).toThrow("Envelope is invalid");

    expect(() =>
      deserializeEnvelope({
        ...envelopeMetadata,
        type: "knowledge.full-rescan.v1",
        payload: { sourceId: 1 },
      }),
    ).toThrow("Envelope is invalid");
  });
});
