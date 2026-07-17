import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { PostgresRepositoryDraftTestStore } from "./repository-draft-test-store.js";

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const candidateDigest = digest("candidate");
const identity = {
  workspaceId: "workspace-a",
  principalId: "administrator-a",
  sessionId: "session-a",
  repositoryId: "repository-a",
  candidateVersionId: "repository-v1",
  candidateDigest,
};
const acceptedAt = new Date("2026-07-16T12:00:00.000Z");

class ScriptedDatabase {
  public readonly queries: string[] = [];

  public readonly credentialRegistration = {
    findMany: async () => [
      {
        id: "secret-registration-a",
      },
    ],
    findFirst: async () => ({ secretReference: "env:REPOSITORY_CHECKOUT_TOKEN" }),
  };

  public constructor(private readonly results: unknown[]) {}

  public readonly $transaction = async <T>(
    operation: (database: this) => Promise<T>,
  ): Promise<T> => operation(this);

  public readonly $queryRaw = async <T>(
    strings: TemplateStringsArray,
  ): Promise<T> => {
    this.queries.push(strings.raw.join("?"));
    return (this.results.shift() ?? []) as T;
  };

  public readonly $executeRaw = async (
    strings: TemplateStringsArray,
  ): Promise<number> => {
    this.queries.push(strings.raw.join("?"));
    return 1;
  };
}

function store(results: unknown[]): {
  readonly database: ScriptedDatabase;
  readonly store: PostgresRepositoryDraftTestStore;
} {
  const database = new ScriptedDatabase(results);
  return {
    database,
    store: new PostgresRepositoryDraftTestStore(database as never, {
      nextId: () => "generated-id",
    }),
  };
}

function claim(input: Partial<Record<string, unknown>> = {}) {
  return {
    id: "claim-a",
    workspace_id: identity.workspaceId,
    principal_id: identity.principalId,
    session_id: identity.sessionId,
    repository_id: identity.repositoryId,
    candidate_version_id: identity.candidateVersionId,
    candidate_digest: identity.candidateDigest,
    key_digest: digest("idempotency"),
    attempt_ordinal: 1,
    accepted_at: acceptedAt,
    lease_expires_at: new Date("2026-07-16T12:00:45.000Z"),
    ...input,
  };
}

describe("PostgresRepositoryDraftTestStore", () => {
  it("calculates a private candidate digest without returning settings or secret locators", async () => {
    const { store: persistence } = store([
      [
        {
          workspace_id: identity.workspaceId,
          configuration_id: identity.repositoryId,
          configuration_version_id: identity.candidateVersionId,
          settings: {
            remoteUrl: "https://git.example.invalid/private/repository.git",
          },
          secret_references: ["secret-registration-a"],
          mode: "remoteHttps",
          allowed_ref_kinds: ["branch", "tag"],
        },
      ],
    ]);

    const candidate = await persistence.resolveCandidate({
      workspaceId: identity.workspaceId,
      repositoryId: identity.repositoryId,
      candidateVersionId: identity.candidateVersionId,
    });

    expect(candidate).toEqual({
      workspaceId: identity.workspaceId,
      repositoryId: identity.repositoryId,
      candidateVersionId: identity.candidateVersionId,
      candidateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(candidate)).not.toContain("git.example.invalid");
    expect(JSON.stringify(candidate)).not.toContain("vault://");
  });

  it("returns a nonterminal accepted state for a database-live duplicate without fabricating an unknown outcome", async () => {
    const { store: persistence, database } = store([
      [],
      [claim()],
      [],
      [{ is_live: true }],
    ]);

    await expect(
      persistence.consumeAndClaim({
        identity,
        confirmationId: "confirmation-a",
        idempotencyKeyDigest: digest("idempotency"),
      }),
    ).resolves.toEqual({
      kind: "inProgress",
      result: {
        id: "claim-a",
        outcome: "accepted",
        status: "inProgress",
        acceptedAt: acceptedAt.toISOString(),
      },
    });
    expect(database.queries.join("\n")).toContain("statement_timestamp()");
  });

  it("recovers checkout material only through the server-private execution resolver", async () => {
    const row = {
      workspace_id: identity.workspaceId,
      configuration_id: identity.repositoryId,
      configuration_version_id: identity.candidateVersionId,
      settings: {
        repository: {
          mode: "remoteHttps",
          remoteUrl: "https://git.example.invalid/private/repository.git",
          checkoutRef: { kind: "commit", sha: "a".repeat(40) },
        },
        repositoryAnalysisProjection: {
          repositoryId: identity.repositoryId,
          mode: "remoteHttps",
          allowedRefKinds: ["commit"],
          configuredCheckoutRef: { kind: "commit", sha: "a".repeat(40) },
        },
      },
      secret_references: ["secret-registration-a"],
      mode: "remoteHttps",
      allowed_ref_kinds: ["commit"],
    };
    const { store: persistence } = store([[row], [row], [row]]);
    const candidate = await persistence.resolveCandidate({
      workspaceId: identity.workspaceId,
      repositoryId: identity.repositoryId,
      candidateVersionId: identity.candidateVersionId,
    });
    if (candidate === undefined) throw new Error("candidate unavailable");

    await expect(
      persistence.resolveExecutionCandidate({ ...candidate }),
    ).resolves.toEqual({
      ...candidate,
      location: {
        mode: "remoteHttps",
        remoteUrl: "https://git.example.invalid/private/repository.git",
        checkoutSecretReference: "env:REPOSITORY_CHECKOUT_TOKEN",
      },
      checkoutRef: { kind: "commit", sha: "a".repeat(40) },
    });
  });

  it("may reclaim only an expired database claim as a new durable claim", async () => {
    const { store: persistence, database } = store([
      [],
      [claim()],
      [],
      [{ is_live: false }],
      [{ id: "generated-id" }],
    ]);

    await expect(
      persistence.consumeAndClaim({
        identity,
        confirmationId: "confirmation-a",
        idempotencyKeyDigest: digest("idempotency"),
      }),
    ).resolves.toEqual({ kind: "claimed", claimId: "generated-id" });
    expect(database.queries.join("\n")).toContain("reclaimed_from_claim_id");
  });

  it("replays only a durable terminal result and rejects activation without a completed result", async () => {
    const { store: persistence } = store([
      [],
      [claim()],
      [
        {
          id: "result-a",
          outcome: "completed",
          completed_at: acceptedAt,
        },
      ],
      [],
    ]);

    await expect(
      persistence.consumeAndClaim({
        identity,
        confirmationId: "confirmation-a",
        idempotencyKeyDigest: digest("idempotency"),
      }),
    ).resolves.toEqual({
      kind: "terminal",
      result: {
        id: "result-a",
        outcome: "completed",
        completedAt: acceptedAt.toISOString(),
      },
    });
    await expect(
      persistence.requireSuccessfulCandidate({
        workspaceId: identity.workspaceId,
        repositoryId: identity.repositoryId,
        candidateDigest: identity.candidateDigest,
      }),
    ).rejects.toThrow("no successful completed test");
  });
});
