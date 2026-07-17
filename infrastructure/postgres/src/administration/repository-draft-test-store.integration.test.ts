import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresRepositoryDraftTestStore } from "./repository-draft-test-store.js";

const databaseUrl = process.env.DATABASE_URL;
if (
  databaseUrl === undefined ||
  !new URL(databaseUrl).pathname.toLowerCase().includes("test")
) {
  throw new Error(
    "Repository draft-test integration tests require a disposable test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const workspaceId = "repository-draft-test-workspace";
const principalId = "repository-draft-test-principal";
const repositoryId = "repository-draft-test-repository";
const candidateVersionId = "repository-draft-test-version";
const digest = (character: string) => character.repeat(64);

function identity(overrides: Partial<{ readonly sessionId: string }> = {}) {
  return {
    workspaceId,
    principalId,
    sessionId: overrides.sessionId ?? "repository-draft-test-session",
    repositoryId,
    candidateVersionId,
    candidateDigest: digest("a"),
  };
}

function audit(
  action:
    | "admin.codeRepository.draftTest.preview"
    | "admin.codeRepository.draftTest",
  outcome: "succeeded" | "failed",
) {
  return {
    workspaceId,
    actorPrincipalId: principalId,
    action,
    targetId: repositoryId,
    targetType: "code-repository" as const,
    permission: "configuration.manage" as const,
    outcome,
    occurredAt: new Date().toISOString(),
    idempotencyKeyDigest: digest("b"),
  };
}

function createStore() {
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  let sequence = 0;
  return {
    client,
    store: new PostgresRepositoryDraftTestStore(client, {
      nextId: () => `repository-draft-test-id-${++sequence}`,
    }),
  };
}

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE workspaces RESTART IDENTITY CASCADE");
  await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [workspaceId]);
  await pool.query(
    "INSERT INTO principals (id, workspace_id) VALUES ($1, $2)",
    [principalId, workspaceId],
  );
  await pool.query(
    `INSERT INTO credential_registrations (
       id, workspace_id, secret_reference, lifecycle
     ) VALUES ($1, $2, $3, 'active')`,
    [
      "repository-draft-test-secret-registration",
      workspaceId,
      "vault://checkout/private-repository",
    ],
  );
  await pool.query(
    `INSERT INTO administration_configurations (
       id, workspace_id, resource_type, lifecycle, current_version_id
     ) VALUES ($1, $2, 'code-repositories', 'draft', NULL)`,
    [repositoryId, workspaceId],
  );
  await pool.query(
    `INSERT INTO administration_configuration_versions (
       id, workspace_id, configuration_id, version, settings, secret_references
     ) VALUES ($1, $2, $3, 1, $4::jsonb, $5::jsonb)`,
    [
      candidateVersionId,
      workspaceId,
      repositoryId,
      JSON.stringify({
        repository: {
          mode: "remoteHttps",
          remoteUrl: "https://git.example.invalid/private/repository.git",
          checkoutRef: { kind: "branch", name: "main" },
        },
        repositoryAnalysisProjection: {
          repositoryId,
          mode: "remoteHttps",
          allowedRefKinds: ["branch"],
          configuredCheckoutRef: { kind: "branch", name: "main" },
        },
      }),
      JSON.stringify(["repository-draft-test-secret-registration"]),
    ],
  );
  await pool.query(
    `UPDATE administration_configurations
     SET current_version_id = $1
     WHERE workspace_id = $2 AND id = $3`,
    [candidateVersionId, workspaceId, repositoryId],
  );
  await pool.query(
    `INSERT INTO code_repository_versions (
       id, workspace_id, configuration_version_id, mode, allowed_ref_kinds,
       checkout_credential_required
     ) VALUES ($1, $2, $3, 'remoteHttps', '["branch"]'::jsonb, true)`,
    [candidateVersionId, workspaceId, candidateVersionId],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("PostgresRepositoryDraftTestStore", () => {
  it("uses database-time live claims and persists only redacted candidate-test state with atomic audit records", async () => {
    const { client, store } = createStore();
    try {
      const candidate = await store.resolveCandidate({
        workspaceId,
        repositoryId,
        candidateVersionId,
      });
      expect(candidate).toEqual({
        workspaceId,
        repositoryId,
        candidateVersionId,
        candidateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      if (candidate === undefined) throw new Error("Expected draft candidate.");
      await expect(
        store.resolveExecutionCandidate({ ...candidate }),
      ).resolves.toEqual({
        ...candidate,
        location: {
          mode: "remoteHttps",
          remoteUrl: "https://git.example.invalid/private/repository.git",
          checkoutSecretReference: "vault://checkout/private-repository",
        },
        checkoutRef: { kind: "branch", name: "main" },
      });

      const candidateIdentity = {
        ...identity(),
        candidateDigest: candidate.candidateDigest,
      };
      const issuedAfter = Date.now();
      const issued = await store.issueAndRecord({
        identity: candidateIdentity,
        audit: audit("admin.codeRepository.draftTest.preview", "succeeded"),
        now: "2020-01-01T00:00:00.000Z",
      });
      expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(issuedAfter);
      await expect(
        store.consumeAndClaim({
          identity: { ...candidateIdentity, sessionId: "other-session" },
          confirmationId: issued.confirmationId,
          idempotencyKeyDigest: digest("b"),
        }),
      ).resolves.toEqual({ kind: "conflict" });

      const claimed = await store.consumeAndClaim({
        identity: candidateIdentity,
        confirmationId: issued.confirmationId,
        idempotencyKeyDigest: digest("b"),
      });
      expect(claimed).toEqual({
        kind: "claimed",
        claimId: "repository-draft-test-id-3",
      });
      if (claimed.kind !== "claimed") throw new Error("Expected test claim.");

      await expect(
        store.consumeAndClaim({
          identity: candidateIdentity,
          confirmationId: issued.confirmationId,
          idempotencyKeyDigest: digest("b"),
        }),
      ).resolves.toMatchObject({
        kind: "inProgress",
        result: { id: claimed.claimId, status: "inProgress" },
      });

      const result = await store.completeAndRecord({
        claimId: claimed.claimId,
        identity: candidateIdentity,
        result: { outcome: "completed", completedAt: new Date().toISOString() },
        audit: audit("admin.codeRepository.draftTest", "succeeded"),
      });
      await expect(
        store.requireSuccessfulCandidate({
          workspaceId,
          repositoryId,
          candidateDigest: candidate.candidateDigest,
        }),
      ).resolves.toBeUndefined();
      await expect(
        store.consumeAndClaim({
          identity: candidateIdentity,
          confirmationId: issued.confirmationId,
          idempotencyKeyDigest: digest("b"),
        }),
      ).resolves.toEqual({ kind: "terminal", result });

      const [confirmations, claims, results, audits] = await Promise.all([
        pool.query(`
          SELECT candidate_digest, confirmation, impact
          FROM administration_repository_draft_test_confirmations
        `),
        pool.query(`
          SELECT candidate_digest, key_digest, accepted_at, lease_expires_at
          FROM administration_repository_draft_test_claims
        `),
        pool.query(`
          SELECT outcome FROM administration_repository_draft_test_results
        `),
        pool.query(`
          SELECT action, target_id, target_type, permission, outcome
          FROM audit_events
          ORDER BY action ASC
        `),
      ]);
      expect(claims.rows[0]?.lease_expires_at).toBeInstanceOf(Date);
      expect(claims.rows[0]?.accepted_at).toBeInstanceOf(Date);
      const claim = claims.rows[0];
      if (
        !(claim?.lease_expires_at instanceof Date) ||
        !(claim.accepted_at instanceof Date)
      ) {
        throw new Error("Expected database-time claim timestamps.");
      }
      expect(claim.lease_expires_at.getTime()).toBeGreaterThan(
        claim.accepted_at.getTime(),
      );
      expect(results.rows).toEqual([{ outcome: "completed" }]);
      expect(audits.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "admin.codeRepository.draftTest.preview",
            target_id: repositoryId,
            target_type: "code-repository",
            permission: "configuration.manage",
            outcome: "succeeded",
          }),
          expect.objectContaining({
            action: "admin.codeRepository.draftTest",
            target_id: repositoryId,
            target_type: "code-repository",
            permission: "configuration.manage",
            outcome: "succeeded",
          }),
        ]),
      );
      expect(
        JSON.stringify({
          candidate,
          confirmations: confirmations.rows,
          claims: claims.rows,
          results: results.rows,
          audits: audits.rows,
        }),
      ).not.toMatch(/private-repository|git\.example|vault:\/\//iu);
      await expect(
        pool.query(
          `UPDATE administration_repository_draft_test_results
           SET outcome = 'failed' WHERE claim_id = $1`,
          [claimed.claimId],
        ),
      ).rejects.toThrow("immutable");
    } finally {
      await client.$disconnect();
    }
  });
});
