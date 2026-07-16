import {
  causationId,
  correlationId,
  createEnvelope,
  outboxEnvelopeId,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { describe, expect, it, vi } from "vitest";

import { createKnowledgeHandlers } from "./knowledge.js";

const command = createEnvelope({
  id: outboxEnvelopeId("knowledge-handler-envelope-1"),
  kind: "command",
  type: "knowledge.synchronize.v2",
  schemaVersion: 1,
  workspaceId: workspaceId("workspace-1"),
  occurredAt: utcInstant("2026-07-15T12:00:00.000Z"),
  correlationId: correlationId("correlation-1"),
  causationId: causationId("causation-1"),
  payload: {
    sourceId: "source-1",
    sourceConfigurationVersionId: "source-version-1",
    connectorConfigurationVersionId: "connector-version-1",
    trigger: "manual",
  },
});

describe("knowledge worker handlers", () => {
  it("resolves the connector from the exact source runtime pin before executing", async () => {
    const source = {};
    const execute = vi.fn(async () => ({ kind: "completed" as const }));
    const resolveSource = vi.fn(async () => source);
    const handlers = createKnowledgeHandlers({
      sourceConfigurations: {
        resolve: vi.fn(async () => ({
          connectorRegistrationId: "connector-1",
        })),
      } as never,
      connectors: { resolveKnowledgeSource: resolveSource } as never,
      coordinator: { execute } as never,
    });

    await handlers.synchronize.handle(command, new AbortController().signal);

    expect(resolveSource).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      connectorRegistrationId: "connector-1",
      connectorConfigurationVersionId: "connector-version-1",
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        sourceConfigurationVersionId: "source-version-1",
        connectorConfigurationVersionId: "connector-version-1",
        mode: "incremental",
        source,
      }),
    );
  });

  it("fails before connector construction when the source's immutable runtime pin is unavailable", async () => {
    const resolveKnowledgeSource = vi.fn();
    const handlers = createKnowledgeHandlers({
      sourceConfigurations: { resolve: vi.fn(async () => undefined) } as never,
      connectors: { resolveKnowledgeSource } as never,
      coordinator: { execute: vi.fn() } as never,
    });

    await expect(
      handlers.synchronize.handle(command, new AbortController().signal),
    ).rejects.toMatchObject({ code: "knowledge.runtimeUnavailable" });
    expect(resolveKnowledgeSource).not.toHaveBeenCalled();
  });
});
