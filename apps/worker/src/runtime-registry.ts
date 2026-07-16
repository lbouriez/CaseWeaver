import type { Envelope } from "@caseweaver/domain";

import type { WorkerCommandHandler } from "./runtime.js";

const unavailableCodes = Object.freeze({
  knowledge: "worker.knowledgeRuntimeUnavailable",
  publication: "worker.publicationRuntimeUnavailable",
  retention: "worker.retentionRuntimeUnavailable",
} as const);

export type WorkerUnavailableRuntimeFeature = keyof typeof unavailableCodes;
export type WorkerUnavailableRuntimeCode =
  (typeof unavailableCodes)[WorkerUnavailableRuntimeFeature];

/**
 * Stable failure used when deployment composition has deliberately not supplied
 * an immutable runtime factory. It contains no command payload, settings, or
 * secret-reference information, so it is safe for queue diagnostics.
 */
export class WorkerFeatureRuntimeUnavailableError extends Error {
  public readonly retryable = false;

  public constructor(public readonly feature: WorkerUnavailableRuntimeFeature) {
    super(`The ${feature} worker runtime is not configured.`);
    this.name = "WorkerFeatureRuntimeUnavailableError";
  }

  public get code(): WorkerUnavailableRuntimeCode {
    return unavailableCodes[this.feature];
  }
}

/**
 * Known-but-unconfigured capabilities fail closed at the handler boundary.
 * In particular, no injected connector, destination, storage, or queue I/O is
 * reached before this error is raised.
 */
export function createUnavailableWorkerCommandHandler<Command extends Envelope>(
  feature: WorkerUnavailableRuntimeFeature,
): WorkerCommandHandler<Command> {
  return Object.freeze({
    async handle(): Promise<never> {
      throw new WorkerFeatureRuntimeUnavailableError(feature);
    },
  });
}
