import { describe, expect, it, vi } from "vitest";

import {
  PreviewRepositoryDraftTest,
  type RepositoryDraftTestCandidateResolver,
  type RepositoryDraftTestRunner,
  type RepositoryDraftTestStore,
  RunRepositoryDraftTest,
  repositoryDraftCandidateDigest,
  repositoryDraftTestActivationGuard,
} from "./repository-draft-test.js";

const digest = (character: string): string => character.repeat(64);
const now = "2026-07-16T12:00:00.000Z";
const later = "2026-07-16T12:05:00.000Z";

const candidate = Object.freeze({
  workspaceId: "workspace-a",
  repositoryId: "support-service",
  candidateVersionId: "support-service-v2",
  candidateDigest: digest("a"),
});

const previewCommand = Object.freeze({
  workspaceId: candidate.workspaceId,
  principalId: "administrator-a",
  sessionId: "session-a",
  repositoryId: candidate.repositoryId,
  candidateVersionId: candidate.candidateVersionId,
});

function resolver(): RepositoryDraftTestCandidateResolver {
  return { resolveCandidate: vi.fn(async () => candidate) };
}

function store(): RepositoryDraftTestStore {
  return {
    issueAndRecord: vi.fn(async () => ({
      confirmationId: "confirmation-a",
      confirmation: "Run the bounded repository connection test?",
      impact: "The server will resolve the configured repository reference.",
      expiresAt: later,
    })),
    consumeAndClaim: vi.fn(async () => ({
      kind: "claimed" as const,
      claimId: "claim-a",
    })),
    completeAndRecord: vi.fn(async (input) => ({
      id: "repository-test-a",
      ...input.result,
    })),
    requireSuccessfulCandidate: vi.fn(async () => undefined),
  };
}

const clock = { now: () => now };

describe("repository draft test administration", () => {
  it("creates a stable private candidate digest and changes it for any candidate material", () => {
    const baseline = {
      settings: {
        remoteUrl: "https://git.example.invalid/private/support-service.git",
        ref: { kind: "branch", name: "main" },
      },
      secretReferenceIds: ["checkout-b", "checkout-a", "checkout-a"],
      projection: {
        repositoryId: "support-service",
        mode: "remoteHttps",
        allowedRefKinds: ["branch", "tag"],
      },
    } as const;
    const baselineDigest = repositoryDraftCandidateDigest(baseline);

    expect(
      repositoryDraftCandidateDigest({
        ...baseline,
        secretReferenceIds: ["checkout-a", "checkout-b"],
      }),
    ).toBe(baselineDigest);
    expect(
      repositoryDraftCandidateDigest({
        ...baseline,
        settings: {
          ...baseline.settings,
          ref: { kind: "branch", name: "next" },
        },
      }),
    ).not.toBe(baselineDigest);
    expect(
      repositoryDraftCandidateDigest({
        ...baseline,
        secretReferenceIds: ["checkout-c"],
      }),
    ).not.toBe(baselineDigest);
    expect(
      repositoryDraftCandidateDigest({
        ...baseline,
        projection: { ...baseline.projection, mode: "deploymentMounted" },
      }),
    ).not.toBe(baselineDigest);
  });

  it("rejects nested non-plain candidate material rather than hashing it as an empty object", () => {
    const emptyObjectDigest = repositoryDraftCandidateDigest({
      settings: { connection: {} },
      secretReferenceIds: [],
      projection: {},
    });

    expect(() =>
      repositoryDraftCandidateDigest({
        settings: { connection: new Date("2026-07-16T12:00:00.000Z") },
        secretReferenceIds: [],
        projection: {},
      }),
    ).toThrow("administration.invalid");
    expect(() =>
      repositoryDraftCandidateDigest({
        settings: { connection: {} },
        secretReferenceIds: [],
        projection: { metadata: new Map() },
      }),
    ).toThrow("administration.invalid");
    expect(emptyObjectDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("issues only a safe preview from a server-selected candidate", async () => {
    const durable = store();
    const preview = await new PreviewRepositoryDraftTest(
      resolver(),
      durable,
      clock,
    ).execute(previewCommand);

    expect(preview).toEqual({
      confirmationId: "confirmation-a",
      confirmation: "Run the bounded repository connection test?",
      impact: "The server will resolve the configured repository reference.",
      expiresAt: later,
    });
    expect(durable.issueAndRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          sessionId: "session-a",
          candidateVersionId: "support-service-v2",
          candidateDigest: digest("a"),
        }),
        audit: expect.objectContaining({
          action: "admin.codeRepository.draftTest.preview",
          targetId: "support-service",
          permission: "configuration.manage",
        }),
      }),
    );
    expect(JSON.stringify(preview)).not.toContain("git.example.invalid");
    expect(JSON.stringify(preview)).not.toContain("checkout-");
  });

  it("fails closed when the durable store rejects the session or candidate digest", async () => {
    const durable = store();
    vi.mocked(durable.consumeAndClaim).mockImplementation(async (input) => {
      expect(input.identity.sessionId).toBe("session-a");
      expect(input.identity.candidateDigest).toBe(digest("a"));
      return { kind: "conflict" };
    });
    const runner: RepositoryDraftTestRunner = { run: vi.fn() };

    await expect(
      new RunRepositoryDraftTest(resolver(), durable, runner, clock).execute({
        ...previewCommand,
        confirmationId: "confirmation-a",
        idempotencyKeyDigest: digest("b"),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "administration.idempotencyConflict" });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("runs a claimed candidate once and serves the durable terminal result without rerunning it", async () => {
    const durable = store();
    const runner: RepositoryDraftTestRunner = {
      run: vi.fn(async () => "completed" as const),
    };
    const command = {
      ...previewCommand,
      confirmationId: "confirmation-a",
      idempotencyKeyDigest: digest("c"),
      signal: new AbortController().signal,
    };
    const service = new RunRepositoryDraftTest(
      resolver(),
      durable,
      runner,
      clock,
    );

    await expect(service.execute(command)).resolves.toEqual({
      kind: "terminal",
      result: {
        id: "repository-test-a",
        outcome: "completed",
        completedAt: now,
      },
    });
    vi.mocked(durable.consumeAndClaim).mockResolvedValueOnce({
      kind: "terminal",
      result: {
        id: "repository-test-a",
        outcome: "completed",
        completedAt: now,
      },
    });
    await expect(service.execute(command)).resolves.toMatchObject({
      kind: "terminal",
      result: {
        id: "repository-test-a",
        outcome: "completed",
      },
    });
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("returns a safe in-progress acceptance for a live duplicate without running, finalizing, or activating it", async () => {
    const durable = store();
    vi.mocked(durable.consumeAndClaim).mockResolvedValueOnce({
      kind: "inProgress",
      result: {
        id: "repository-test-a",
        outcome: "accepted",
        status: "inProgress",
        acceptedAt: now,
      },
    });
    const runner: RepositoryDraftTestRunner = { run: vi.fn() };
    const service = new RunRepositoryDraftTest(
      resolver(),
      durable,
      runner,
      clock,
    );

    await expect(
      service.execute({
        ...previewCommand,
        confirmationId: "confirmation-a",
        idempotencyKeyDigest: digest("e"),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: "inProgress",
      result: {
        id: "repository-test-a",
        outcome: "accepted",
        status: "inProgress",
        acceptedAt: now,
      },
    });
    expect(runner.run).not.toHaveBeenCalled();
    expect(durable.completeAndRecord).not.toHaveBeenCalled();
    expect(durable.consumeAndClaim).toHaveBeenCalledWith(
      expect.not.objectContaining({ now }),
    );

    vi.mocked(durable.requireSuccessfulCandidate).mockRejectedValue(
      new Error("test remains in progress"),
    );
    await expect(
      repositoryDraftTestActivationGuard(durable).requireSuccessfulCandidate({
        workspaceId: candidate.workspaceId,
        repositoryId: candidate.repositoryId,
        candidateDigest: candidate.candidateDigest,
      }),
    ).rejects.toThrow("test remains in progress");
  });

  it("records an unknown outcome on runner failure and leaves failed, unknown, or expired candidates unusable", async () => {
    const durable = store();
    const runner: RepositoryDraftTestRunner = {
      run: vi.fn(async () => {
        throw new Error("redacted runner failure");
      }),
    };
    const execution = await new RunRepositoryDraftTest(
      resolver(),
      durable,
      runner,
      clock,
    ).execute({
      ...previewCommand,
      confirmationId: "confirmation-a",
      idempotencyKeyDigest: digest("d"),
      signal: new AbortController().signal,
    });
    expect(execution).toMatchObject({
      kind: "terminal",
      result: { outcome: "outcome_unknown" },
    });
    expect(durable.completeAndRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        result: { outcome: "outcome_unknown", completedAt: now },
        audit: expect.objectContaining({ outcome: "failed" }),
      }),
    );

    vi.mocked(durable.requireSuccessfulCandidate).mockRejectedValue(
      new Error("no completed candidate"),
    );
    const guard = repositoryDraftTestActivationGuard(durable);
    for (const candidateState of ["failed", "outcome_unknown", "expired"]) {
      await expect(
        guard.requireSuccessfulCandidate({
          workspaceId: "workspace-a",
          repositoryId: "support-service",
          candidateDigest: digest(candidateState[0] ?? "e"),
        }),
      ).rejects.toThrow("no completed candidate");
    }
  });

  it("rejects an expired preview response before it reaches a UI", async () => {
    const durable = store();
    vi.mocked(durable.issueAndRecord).mockResolvedValueOnce({
      confirmationId: "confirmation-a",
      confirmation: "Run the bounded repository connection test?",
      impact: "The server will resolve the configured repository reference.",
      expiresAt: now,
    });

    await expect(
      new PreviewRepositoryDraftTest(resolver(), durable, clock).execute(
        previewCommand,
      ),
    ).rejects.toMatchObject({ code: "administration.invalid" });
  });
});
