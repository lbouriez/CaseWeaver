import type { EnvelopeFor } from "@caseweaver/domain";

import type {
  PublicationWorkflowCommandHandlers,
  WorkerCommandHandler,
} from "../runtime.js";
import { createUnavailableWorkerCommandHandler } from "../runtime-registry.js";

/**
 * The application use case SchedulePublicationForCompletedAnalysis structurally
 * satisfies this contract. It is injected so this package need not import an
 * undeclared application dependency.
 */
export interface CompletedAnalysisPublicationScheduler {
  execute(event: EnvelopeFor<"analysis.completed.v1">): Promise<unknown>;
}

export function createPublicationHandlers(
  scheduler: CompletedAnalysisPublicationScheduler,
): PublicationWorkflowCommandHandlers {
  const analysisCompleted: WorkerCommandHandler<
    EnvelopeFor<"analysis.completed.v1">
  > = Object.freeze({
    async handle(
      event: EnvelopeFor<"analysis.completed.v1">,
      _signal: AbortSignal,
    ): Promise<void> {
      await scheduler.execute(event);
    },
  });

  return Object.freeze({
    trigger: createUnavailableWorkerCommandHandler("publication"),
    delivery: Object.freeze({
      execute: createUnavailableWorkerCommandHandler("publication"),
      reconcile: createUnavailableWorkerCommandHandler("publication"),
    }),
    analysisCompleted,
  });
}
