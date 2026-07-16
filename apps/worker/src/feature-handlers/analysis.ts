import type { EnvelopeFor } from "@caseweaver/domain";

import {
  createAnalysisExecuteHandler as createPrebuiltAnalysisExecuteHandler,
  type AnalysisExecutionHandler,
} from "../modules/analysis/index.js";
import type { WorkerCommandHandler } from "../runtime.js";

export type AnalysisExecuteCommand = EnvelopeFor<"analysis.execute.v1">;

/**
 * Transitional compatibility for the shared production-composition registry.
 * The factory must return an already-composed production service; it is never
 * given unavailable/fake evidence ports by this feature handler.
 */
export interface AnalysisOrchestratorFactory {
  create(): AnalysisExecutionService;
}

export interface AnalysisExecutionService extends AnalysisExecutionHandler {}

function isExecutionService(
  input: AnalysisExecutionService | AnalysisOrchestratorFactory,
): input is AnalysisExecutionService {
  return "execute" in input && typeof input.execute === "function";
}

/**
 * Adapts only a prebuilt analysis service to the worker command boundary.
 * Production composition owns construction of attachment/retrieval/repository
 * ports and the exclusive AI gateway; it cannot be silently replaced here.
 */
export function createAnalysisExecuteHandler(
  input: AnalysisExecutionService | AnalysisOrchestratorFactory,
): WorkerCommandHandler<AnalysisExecuteCommand> {
  const execution = isExecutionService(input) ? input : input.create();
  return createPrebuiltAnalysisExecuteHandler(execution);
}
