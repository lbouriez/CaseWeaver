import type { CaseDiscoveryStateStore } from "@caseweaver/application";
import { createEnvelope, causationId, correlationId, outboxEnvelopeId, utcInstant, workspaceId } from "@caseweaver/domain";
import { describe, expect, it, vi } from "vitest";

import {
  AnalysisDiscoveryRuntimeUnavailableError,
  RuntimeCaseDiscoveryService,
} from "./analysis-discovery.js";

const command = createEnvelope({
  id: outboxEnvelopeId("outbox-discovery-1"),
  kind: "command",
  type: "analysis.discover.v1",
  schemaVersion: 1,
  workspaceId: workspaceId("workspace-1"),
  occurredAt: utcInstant("2026-07-17T18:00:00.000Z"),
  correlationId: correlationId("correlation-1"),
  causationId: causationId("causation-1"),
  payload: {
    scheduleId: "schedule-version-1",
    scheduleConfigurationVersionId: "schedule-version-1",
    triggerId: "trigger-1",
    triggerVersionId: "trigger-version-1",
    connectorRegistrationId: "connector-1",
    connectorConfigurationVersionId: "connector-version-1",
    occurrenceKey: "scheduled-occurrence-1",
  },
});

function state(): CaseDiscoveryStateStore {
  return {
    claim: vi.fn(async () => ({
      kind: "claimed" as const,
      claim: { fencingToken: 1n, actorPrincipalId: "principal-1" as never },
    })),
    advance: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  };
}

describe("RuntimeCaseDiscoveryService", () => {
  it("converts a discovered case into an exact pinned trigger request before advancing its private cursor", async () => {
    const cursorState = state();
    const requestTrigger = { execute: vi.fn(async () => ({ replayed: false })) };
    const source = {
      async *discoverCases() {
        yield {
          mode: "delta" as const,
          events: [
            {
              kind: "upsert" as const,
              item: {
                reference: {
                  connectorInstanceId: "connector-1",
                  resourceType: "case",
                  externalId: "case-9",
                },
                fingerprint: { version: "jitbit.v1", value: "opaque-change" },
              },
            },
          ],
          nextCursor: { version: "jitbit.cursor.v1", value: "opaque-cursor" },
          complete: true,
        };
      },
    };
    const service = new RuntimeCaseDiscoveryService({
      state: cursorState,
      connectors: {
        resolveCaseSource: vi.fn(async () => source),
      } as never,
      requestTrigger,
      leaseMs: 60_000,
    });

    await expect(
      service.execute(command, new AbortController().signal),
    ).resolves.toBe("completed");

    expect(requestTrigger.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerId: "trigger-1",
        expectedTriggerVersionId: "trigger-version-1",
        source: "schedule",
        target: {
          connectorInstanceId: "connector-1",
          resourceType: "case",
          externalId: "case-9",
        },
      }),
      expect.objectContaining({
        workspaceId: "workspace-1",
        principalId: "principal-1",
      }),
    );
    expect(cursorState.advance).toHaveBeenCalledWith(
      expect.objectContaining({
        command,
        cursor: { version: "jitbit.cursor.v1", value: "opaque-cursor" },
      }),
    );
    expect(cursorState.complete).toHaveBeenCalledWith(
      expect.objectContaining({ command }),
    );
    expect(JSON.stringify(requestTrigger.execute.mock.calls)).not.toContain(
      "opaque-cursor",
    );
  });

  it("fails closed without resolving a connector when the pinned schedule is unavailable", async () => {
    const cursorState: CaseDiscoveryStateStore = {
      ...state(),
      claim: vi.fn(async () => ({ kind: "unavailable" as const })),
    };
    const resolveCaseSource = vi.fn();
    const service = new RuntimeCaseDiscoveryService({
      state: cursorState,
      connectors: { resolveCaseSource } as never,
      requestTrigger: { execute: vi.fn() },
      leaseMs: 60_000,
    });

    await expect(
      service.execute(command, new AbortController().signal),
    ).rejects.toBeInstanceOf(AnalysisDiscoveryRuntimeUnavailableError);
    expect(resolveCaseSource).not.toHaveBeenCalled();
  });
});
