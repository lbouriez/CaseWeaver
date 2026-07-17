import {
  type AnalysisOrchestratorFactory,
  createAnalysisExecuteHandler,
} from "./feature-handlers/analysis.js";
import {
  createCaseDiscoveryHandler,
  type RuntimeCaseDiscoveryService,
} from "./feature-handlers/analysis-discovery.js";
import {
  createDiagnosticsHandlers,
  type DiagnosticsRuntimeDependencies,
} from "./feature-handlers/diagnostics.js";
import {
  createKnowledgeHandlers,
  type KnowledgeRuntimeDependencies,
} from "./feature-handlers/knowledge.js";
import {
  createOperationsHandlers,
  type OperationsRuntimeDependencies,
} from "./feature-handlers/operations.js";
import {
  type AnalysisCompletedService,
  type AnalysisTriggerService,
  createPublicationService,
  createPublicationWorkflowHandlers,
  type PublicationExecutorService,
} from "./modules/publication/index.js";
import type { WorkerCommandHandlers } from "./runtime.js";

/**
 * Deployment composition owns construction of concrete stores, prompts, and
 * ai-execution. This worker-only factory turns those real services into the
 * complete typed command registry without exposing any runtime settings.
 */
export interface ProductionWorkerCompositionDependencies {
  readonly knowledge: KnowledgeRuntimeDependencies;
  readonly diagnostics: DiagnosticsRuntimeDependencies;
  readonly analysis: AnalysisOrchestratorFactory;
  /** Target-free PBI-020 polling discovery before version-pinned capture. */
  readonly discovery: Pick<RuntimeCaseDiscoveryService, "execute">;
  readonly publication: Readonly<{
    /** Capture and submit a version-pinned analysis trigger. */
    readonly trigger: AnalysisTriggerService;
    /** Deliver or reconcile a version-pinned publication intent. */
    readonly executor: PublicationExecutorService;
    /** Schedule eligible publication after a completed analysis event. */
    readonly completedAnalysis: AnalysisCompletedService;
  }>;
  readonly operations: OperationsRuntimeDependencies;
}

/**
 * Returns handlers for every known worker envelope. Unsupported runtime
 * capabilities are represented by deliberate typed errors, never silent no-op
 * handlers or mutable configuration lookups.
 */
export function createProductionWorkerCommandHandlers(
  dependencies: ProductionWorkerCompositionDependencies,
): WorkerCommandHandlers {
  const publication = createPublicationWorkflowHandlers({
    trigger: dependencies.publication.trigger,
    publication: createPublicationService(dependencies.publication.executor),
    analysisCompleted: dependencies.publication.completedAnalysis,
  });
  return Object.freeze({
    ...createKnowledgeHandlers(dependencies.knowledge),
    analysis: Object.freeze({
      execute: createAnalysisExecuteHandler(dependencies.analysis),
      discover: createCaseDiscoveryHandler(dependencies.discovery),
    }),
    publication: Object.freeze({
      trigger: publication.trigger,
      delivery: publication.publication,
      analysisCompleted: publication.analysisCompleted,
    }),
    operations: createOperationsHandlers(dependencies.operations),
    diagnostics: createDiagnosticsHandlers(dependencies.diagnostics),
  });
}
