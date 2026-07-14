import type { EnvelopeFor } from "@caseweaver/domain";

export type AnalysisExecuteCommand = EnvelopeFor<"analysis.execute.v1">;

export interface AnalysisExecutionHandler {
  execute(
    command: AnalysisExecuteCommand,
    signal: AbortSignal,
  ): Promise<unknown>;
}

/**
 * PBI-011's independently composable worker handler. The worker registry is
 * intentionally not changed here; the delivery-wave integration owner composes it.
 */
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
