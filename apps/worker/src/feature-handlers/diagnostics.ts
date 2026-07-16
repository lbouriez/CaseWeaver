import type {
  DiagnosticExportArtifactStore,
  DiagnosticExportClock,
  DiagnosticExportDigest,
  DiagnosticExportRequestStore,
  DiagnosticExportSource,
} from "@caseweaver/administration";

import { createDiagnosticExportGenerateHandler } from "../diagnostic-export-handler.js";
import type { DiagnosticsCommandHandlers } from "../runtime.js";

export interface DiagnosticsRuntimeDependencies {
  readonly requests: DiagnosticExportRequestStore;
  readonly source: DiagnosticExportSource;
  readonly artifacts: DiagnosticExportArtifactStore;
  readonly digest: DiagnosticExportDigest;
  readonly clock: DiagnosticExportClock;
}

/** Diagnostics exports are fully implemented and use only opaque export IDs. */
export function createDiagnosticsHandlers(
  dependencies: DiagnosticsRuntimeDependencies,
): DiagnosticsCommandHandlers {
  return Object.freeze({
    generate: createDiagnosticExportGenerateHandler(dependencies),
  });
}
