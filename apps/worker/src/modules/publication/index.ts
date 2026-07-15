import type { EnvelopeFor } from "@caseweaver/domain";

export interface AnalysisTriggerService {
  trigger(
    command: EnvelopeFor<"analysis.trigger.v1">,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface PublicationService {
  execute(
    command: EnvelopeFor<"publication.execute.v1">,
    signal: AbortSignal,
  ): Promise<unknown>;
  reconcile(
    command: EnvelopeFor<"publication.reconcile.v1">,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface AnalysisCompletedService {
  complete(event: EnvelopeFor<"analysis.completed.v1">): Promise<unknown>;
}

/**
 * Publication workflow handlers contain no connector choice. Composition injects the
 * trigger resolver, publication executor, and analysis-completion consumer.
 */
export function createPublicationWorkflowHandlers(input: {
  readonly trigger: AnalysisTriggerService;
  readonly publication: PublicationService;
  readonly analysisCompleted: AnalysisCompletedService;
}) {
  return Object.freeze({
    trigger: {
      handle: async (
        command: EnvelopeFor<"analysis.trigger.v1">,
        signal: AbortSignal,
      ): Promise<void> => {
        await input.trigger.trigger(command, signal);
      },
    },
    publication: {
      execute: {
        handle: async (
          command: EnvelopeFor<"publication.execute.v1">,
          signal: AbortSignal,
        ): Promise<void> => {
          await input.publication.execute(command, signal);
        },
      },
      reconcile: {
        handle: async (
          command: EnvelopeFor<"publication.reconcile.v1">,
          signal: AbortSignal,
        ): Promise<void> => {
          await input.publication.reconcile(command, signal);
        },
      },
    },
    analysisCompleted: {
      handle: async (
        event: EnvelopeFor<"analysis.completed.v1">,
        _signal: AbortSignal,
      ): Promise<void> => {
        await input.analysisCompleted.complete(event);
      },
    },
  });
}
