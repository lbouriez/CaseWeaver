import {
  AnalysisOrchestrator,
  type AnalysisOrchestratorDependencies,
} from "@caseweaver/analysis";

import type {
  AnalysisExecuteCommand,
  AnalysisExecutionHandler,
} from "./index.js";

/**
 * Feature-level construction boundary for analysis execution. Hosts supply
 * already-composed production ports; this module deliberately owns neither
 * environment loading, database/queue lifecycle, nor worker registration.
 */
export interface AnalysisProductionDependencies
  extends AnalysisOrchestratorDependencies {}

/**
 * Builds a worker transport service from real analysis ports. There are no
 * unavailable or deterministic fallbacks in this path: callers must provide
 * frozen evidence, binding-aware prompt construction, the exclusive AI
 * gateway, and the optional pinned repository adapter explicitly.
 */
export function createProductionAnalysisExecutionService(
  dependencies: AnalysisProductionDependencies,
): AnalysisExecutionHandler {
  const orchestrator = new AnalysisOrchestrator(dependencies);
  return Object.freeze({
    execute(command: AnalysisExecuteCommand, signal: AbortSignal) {
      return orchestrator.execute(command, signal);
    },
  });
}
