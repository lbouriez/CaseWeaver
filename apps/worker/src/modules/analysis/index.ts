import type { EnvelopeFor } from "@caseweaver/domain";

export {
  createProductionAnalysisExecutionService,
  type AnalysisProductionDependencies,
} from "./production-factory.js";
export {
  PinnedRepositoryInvestigationPort,
  RepositoryInvestigationRuntimeError,
} from "./repository-investigation.js";
export {
  CompositePinnedRepositoryAgentRuntimeResolver,
  CompositeRepositoryRuntimeExecutionResolver,
  ComposedPinnedRepositoryAgentRuntimeResolver,
  createLocalGitOciPinnedRepositoryRuntimeResolver,
  createRepositoryAnalysisPinnedRuntimeResolver,
  RepositoryAnalysisRuntimeExecutionResolver,
} from "./pinned-repository-runtime.js";

export type AnalysisExecuteCommand = EnvelopeFor<"analysis.execute.v1">;

export interface AnalysisExecutionHandler {
  execute(
    command: AnalysisExecuteCommand,
    signal: AbortSignal,
  ): Promise<unknown>;
}

/** Analysis execution is composed separately from other worker workflows. */
export function createAnalysisExecuteHandler(
  handler: AnalysisExecutionHandler,
): {
  readonly handle: (
    command: AnalysisExecuteCommand,
    signal: AbortSignal,
  ) => Promise<void>;
} {
  return Object.freeze({
    async handle(command, signal): Promise<void> {
      await handler.execute(command, signal);
    },
  });
}
