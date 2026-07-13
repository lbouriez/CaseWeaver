import { describe, expect, it } from "vitest";

import {
  type AnalysisAttempt,
  type AnalysisJob,
  analysisAttemptId,
  analysisIdentityId,
  analysisJobId,
  finishAnalysisAttempt,
  type PublicationIntent,
  publicationIntentId,
  recoverAnalysisJob,
  transitionAnalysisJob,
  transitionPublicationIntent,
  utcInstant,
  workspaceId,
} from "./index.js";

const now = utcInstant("2026-01-01T00:00:00.000Z");
const later = utcInstant("2026-01-01T00:01:00.000Z");

function job(state: AnalysisJob["state"]): AnalysisJob {
  return {
    id: analysisJobId("job-1"),
    workspaceId: workspaceId("workspace-1"),
    analysisIdentityId: analysisIdentityId("identity-1"),
    runOrdinal: 0,
    state,
    createdAt: now,
    updatedAt: now,
  };
}

function attempt(state: AnalysisAttempt["state"]): AnalysisAttempt {
  return {
    id: analysisAttemptId("attempt-1"),
    workspaceId: workspaceId("workspace-1"),
    analysisJobId: analysisJobId("job-1"),
    attemptOrdinal: 0,
    state,
    startedAt: now,
  };
}

function intent(state: PublicationIntent["state"]): PublicationIntent {
  return {
    id: publicationIntentId("publication-1"),
    workspaceId: workspaceId("workspace-1"),
    state,
    createdAt: now,
    updatedAt: now,
  };
}

describe("analysis state transitions", () => {
  it("permits only durable lifecycle transitions", () => {
    expect(transitionAnalysisJob(job("queued"), "running", later).state).toBe(
      "running",
    );
    expect(() =>
      transitionAnalysisJob(job("queued"), "completed", later),
    ).toThrow("Cannot transition analysis job");
    expect(() =>
      transitionAnalysisJob(job("completed"), "running", later),
    ).toThrow("Cannot transition analysis job");
  });

  it("requires a terminal attempt before recovering a running job", () => {
    expect(() =>
      recoverAnalysisJob(job("running"), attempt("running"), later),
    ).toThrow("terminal attempt");

    const expired = finishAnalysisAttempt(
      attempt("running"),
      "leaseExpired",
      later,
    );
    expect(recoverAnalysisJob(job("running"), expired, later).state).toBe(
      "queued",
    );
  });
});

describe("publication state transitions", () => {
  it("does not skip approval or permit terminal changes", () => {
    expect(
      transitionPublicationIntent(intent("pending"), "awaitingApproval", later)
        .state,
    ).toBe("awaitingApproval");
    expect(() =>
      transitionPublicationIntent(
        intent("awaitingApproval"),
        "published",
        later,
      ),
    ).toThrow("Cannot transition publication intent");
    expect(() =>
      transitionPublicationIntent(intent("published"), "publishing", later),
    ).toThrow("Cannot transition publication intent");
  });
});
