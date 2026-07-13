import { DomainValidationError, StateTransitionError } from "./errors.js";
import type {
  AnalysisAttemptId,
  AnalysisIdentityId,
  AnalysisJobId,
  UtcInstant,
  WorkspaceId,
} from "./ids.js";

export type AnalysisJobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type AnalysisAttemptState =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "leaseExpired";

export interface AnalysisJob {
  readonly id: AnalysisJobId;
  readonly workspaceId: WorkspaceId;
  readonly analysisIdentityId: AnalysisIdentityId;
  readonly runOrdinal: number;
  readonly state: AnalysisJobState;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

export interface AnalysisAttempt {
  readonly id: AnalysisAttemptId;
  readonly workspaceId: WorkspaceId;
  readonly analysisJobId: AnalysisJobId;
  readonly attemptOrdinal: number;
  readonly state: AnalysisAttemptState;
  readonly startedAt: UtcInstant;
  readonly finishedAt?: UtcInstant;
}

const terminalJobStates: ReadonlySet<AnalysisJobState> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

const terminalAttemptStates: ReadonlySet<AnalysisAttemptState> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "leaseExpired",
]);

export function isTerminalAnalysisJobState(state: AnalysisJobState): boolean {
  return terminalJobStates.has(state);
}

export function isTerminalAnalysisAttemptState(
  state: AnalysisAttemptState,
): boolean {
  return terminalAttemptStates.has(state);
}

export function transitionAnalysisJob(
  job: AnalysisJob,
  state: AnalysisJobState,
  at: UtcInstant,
): AnalysisJob {
  const isAllowed =
    (job.state === "queued" &&
      (state === "running" || state === "cancelled")) ||
    (job.state === "running" &&
      (state === "completed" || state === "failed" || state === "cancelled"));

  if (!isAllowed) {
    throw new StateTransitionError("analysis job", job.state, state);
  }

  return Object.freeze({ ...job, state, updatedAt: at });
}

export function finishAnalysisAttempt(
  attempt: AnalysisAttempt,
  state: Exclude<AnalysisAttemptState, "running">,
  at: UtcInstant,
): AnalysisAttempt {
  if (attempt.state !== "running") {
    throw new StateTransitionError("analysis attempt", attempt.state, state);
  }

  return Object.freeze({ ...attempt, state, finishedAt: at });
}

export function recoverAnalysisJob(
  job: AnalysisJob,
  terminalAttempt: AnalysisAttempt,
  at: UtcInstant,
): AnalysisJob {
  if (job.state !== "running") {
    throw new StateTransitionError("analysis job", job.state, "queued");
  }
  if (terminalAttempt.analysisJobId !== job.id) {
    throw new DomainValidationError(
      "Analysis attempt belongs to a different job.",
    );
  }
  if (!isTerminalAnalysisAttemptState(terminalAttempt.state)) {
    throw new DomainValidationError(
      "Running analysis jobs require a terminal attempt before recovery.",
    );
  }

  return Object.freeze({ ...job, state: "queued", updatedAt: at });
}
