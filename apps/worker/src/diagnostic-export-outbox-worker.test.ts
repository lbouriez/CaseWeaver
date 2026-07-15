import {
  causationId,
  correlationId,
  createEnvelope,
  outboxEnvelopeId,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { describe, expect, it, vi } from "vitest";

import { processDiagnosticExportClaim } from "./diagnostic-export-outbox-worker.js";

describe("diagnostic export outbox worker", () => {
  it("acknowledges an export envelope only after its handler completes", async () => {
    const claim = {
      claimToken: "claim-1",
      envelope: createEnvelope<"diagnostics.export.generate.v1">({
        id: outboxEnvelopeId("outbox-diagnostic-export-1"),
        kind: "command",
        type: "diagnostics.export.generate.v1",
        schemaVersion: 1,
        workspaceId: workspaceId("workspace-1"),
        occurredAt: utcInstant("2026-07-15T12:00:00.000Z"),
        correlationId: correlationId("correlation-1"),
        causationId: causationId("causation-1"),
        payload: { exportId: "diagnostic-export-1" },
      }),
    };
    const calls: string[] = [];
    await processDiagnosticExportClaim({
      claim,
      handle: vi.fn(async () => {
        calls.push("handle");
      }),
      acknowledge: vi.fn(async () => {
        calls.push("acknowledge");
      }),
      signal: new AbortController().signal,
    });

    expect(calls).toEqual(["handle", "acknowledge"]);
  });

  it("does not acknowledge when export generation fails", async () => {
    const acknowledge = vi.fn(async () => undefined);
    await expect(
      processDiagnosticExportClaim({
        claim: {
          claimToken: "claim-1",
          envelope: createEnvelope<"diagnostics.export.generate.v1">({
            id: outboxEnvelopeId("outbox-diagnostic-export-1"),
            kind: "command",
            type: "diagnostics.export.generate.v1",
            schemaVersion: 1,
            workspaceId: workspaceId("workspace-1"),
            occurredAt: utcInstant("2026-07-15T12:00:00.000Z"),
            correlationId: correlationId("correlation-1"),
            causationId: causationId("causation-1"),
            payload: { exportId: "diagnostic-export-1" },
          }),
        },
        handle: async () => {
          throw new Error("generation failed");
        },
        acknowledge,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("generation failed");
    expect(acknowledge).not.toHaveBeenCalled();
  });
});
