import { StateTransitionError } from "./errors.js";
import type {
  AnalysisJobId,
  PublicationIntentId,
  UtcInstant,
  WorkspaceId,
} from "./ids.js";

export type PublicationIntentState =
  | "pending"
  | "awaitingApproval"
  | "publishing"
  | "published"
  | "outcomeUnknown"
  | "failed"
  | "skipped";

export interface PublicationIntent {
  readonly id: PublicationIntentId;
  readonly workspaceId: WorkspaceId;
  readonly analysisJobId: AnalysisJobId;
  readonly state: PublicationIntentState;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

const publicationTransitions: Readonly<
  Record<PublicationIntentState, readonly PublicationIntentState[]>
> = {
  pending: ["awaitingApproval", "publishing", "skipped"],
  awaitingApproval: ["pending", "publishing", "skipped"],
  publishing: ["published", "outcomeUnknown", "failed"],
  published: [],
  outcomeUnknown: ["published", "publishing", "failed"],
  failed: ["publishing", "skipped"],
  skipped: [],
};

export function transitionPublicationIntent(
  intent: PublicationIntent,
  state: PublicationIntentState,
  at: UtcInstant,
): PublicationIntent {
  if (!publicationTransitions[intent.state].includes(state)) {
    throw new StateTransitionError("publication intent", intent.state, state);
  }

  return Object.freeze({ ...intent, state, updatedAt: at });
}
