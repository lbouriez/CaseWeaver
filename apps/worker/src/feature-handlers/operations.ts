import type { EnvelopeFor } from "@caseweaver/domain";

import { createOperationsHandlers as createRetentionOperationsHandlers } from "../modules/operations/index.js";
import type { OperationsCommandHandlers } from "../runtime.js";
import { createUnavailableWorkerCommandHandler } from "../runtime-registry.js";

export interface RetentionReaperUseCase {
  execute(
    command: EnvelopeFor<"retention.reap.v1">,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface RetentionPurgeUseCase {
  execute(
    workspaceId: EnvelopeFor<"retention.purge.v1">["workspaceId"],
    workItemId: string,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface OperationsRuntimeDependencies {
  readonly retention: Readonly<{
    readonly reaper: RetentionReaperUseCase;
    readonly purge: RetentionPurgeUseCase;
  }>;
}

/**
 * Retention work is composed only with a real fenced application use case and
 * backend-aware object store. Incomplete hosts remain observable and fail
 * closed without acknowledging a durable deletion command.
 */
export function createOperationsHandlers(
  dependencies?: OperationsRuntimeDependencies,
): OperationsCommandHandlers {
  if (dependencies !== undefined) {
    return createRetentionOperationsHandlers({
      reaper: {
        reap: (command, signal) =>
          dependencies.retention.reaper.execute(command, signal),
      },
      purge: {
        purge: (command, signal) =>
          dependencies.retention.purge.execute(
            command.workspaceId,
            command.payload.workItemId,
            signal,
          ),
      },
    });
  }
  return Object.freeze({
    retention: Object.freeze({
      reap: createUnavailableWorkerCommandHandler("retention"),
      purge: createUnavailableWorkerCommandHandler("retention"),
    }),
  });
}
