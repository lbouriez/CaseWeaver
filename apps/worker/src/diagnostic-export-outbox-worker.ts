import { createHash } from "node:crypto";

import type {
  ClaimedDiagnosticExportEnvelope,
  PostgresPersistence,
} from "@caseweaver/postgres";

import { createDiagnosticExportGenerateHandler } from "./diagnostic-export-handler.js";

export interface DiagnosticExportOutboxWorker {
  runOnce(limit?: number, signal?: AbortSignal): Promise<number>;
}

/**
 * Dedicated PBI-016 outbox consumer. Filtering in the persistence adapter
 * prevents it from claiming analysis/publication work owned by other worker
 * compositions. A command is acknowledged only after its handler finishes.
 */
export function createDiagnosticExportOutboxWorker(
  persistence: Pick<
    PostgresPersistence,
    | "diagnosticExportStore"
    | "diagnosticExportSource"
    | "diagnosticExportArtifactStore"
    | "diagnosticExportDispatchStore"
  >,
): DiagnosticExportOutboxWorker {
  const clock = { now: () => new Date().toISOString() };
  const handler = createDiagnosticExportGenerateHandler({
    requests: persistence.diagnosticExportStore,
    source: persistence.diagnosticExportSource,
    artifacts: persistence.diagnosticExportArtifactStore,
    digest: {
      sha256: async (content) =>
        createHash("sha256").update(content).digest("hex"),
    },
    clock,
  });
  return Object.freeze({
    async runOnce(limit = 10, signal = new AbortController().signal) {
      const claimed = await persistence.diagnosticExportDispatchStore.claim({
        limit,
        leaseMs: 5 * 60_000,
        now: clock.now(),
      });
      for (const claim of claimed) {
        await handler.handle(claim.envelope, signal);
        await persistence.diagnosticExportDispatchStore.acknowledge({
          claim,
          deliveredAt: clock.now(),
        });
      }
      return claimed.length;
    },
  });
}

/** Narrow test seam for acknowledgement ordering without replacing real handlers. */
export async function processDiagnosticExportClaim(
  input: Readonly<{
    readonly claim: ClaimedDiagnosticExportEnvelope;
    readonly handle: (
      command: ClaimedDiagnosticExportEnvelope["envelope"],
      signal: AbortSignal,
    ) => Promise<void>;
    readonly acknowledge: (
      claim: ClaimedDiagnosticExportEnvelope,
    ) => Promise<void>;
    readonly signal: AbortSignal;
  }>,
): Promise<void> {
  await input.handle(input.claim.envelope, input.signal);
  await input.acknowledge(input.claim);
}
