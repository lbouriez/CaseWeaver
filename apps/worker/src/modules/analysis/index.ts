import type { EnvelopeFor } from "@caseweaver/domain";

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
