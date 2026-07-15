import {
  type DiagnosticExportArtifactStore,
  type DiagnosticExportClock,
  type DiagnosticExportDigest,
  type DiagnosticExportRequestStore,
  type DiagnosticExportSource,
  expireDiagnosticExports,
  generateDiagnosticExport,
} from "@caseweaver/administration";

import type {
  DiagnosticsExportGenerateCommand,
  WorkerCommandHandler,
} from "./runtime.js";

/**
 * Adapter-neutral worker handler. The envelope contains only an opaque export
 * ID; audit projections and private artifact bytes remain behind injected
 * server-only ports.
 */
export function createDiagnosticExportGenerateHandler(
  dependencies: Readonly<{
    readonly requests: DiagnosticExportRequestStore;
    readonly source: DiagnosticExportSource;
    readonly artifacts: DiagnosticExportArtifactStore;
    readonly digest: DiagnosticExportDigest;
    readonly clock: DiagnosticExportClock;
  }>,
): WorkerCommandHandler<DiagnosticsExportGenerateCommand> {
  return Object.freeze({
    async handle(
      command: DiagnosticsExportGenerateCommand,
      signal: AbortSignal,
    ): Promise<void> {
      await generateDiagnosticExport(
        dependencies.requests,
        dependencies.source,
        dependencies.artifacts,
        dependencies.digest,
        dependencies.clock,
        {
          workspaceId: command.workspaceId,
          exportId: command.payload.exportId,
          signal,
        },
      );
    },
  });
}

/** Periodic bounded cleanup is safe to compose alongside normal command consumption. */
export async function runDiagnosticExportMaintenance(
  dependencies: Readonly<{
    readonly requests: DiagnosticExportRequestStore;
    readonly artifacts: DiagnosticExportArtifactStore;
    readonly clock: DiagnosticExportClock;
  }>,
  limit = 100,
): Promise<Readonly<{ readonly expired: number; readonly deleted: number }>> {
  return expireDiagnosticExports(
    dependencies.requests,
    dependencies.artifacts,
    dependencies.clock,
    limit,
  );
}
