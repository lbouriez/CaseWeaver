import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresConnectorDraftTestStore } from "./connector-draft-test-store.js";

const databaseUrl = process.env.DATABASE_URL;
if (
  databaseUrl === undefined ||
  !new URL(databaseUrl).pathname.toLowerCase().includes("test")
) {
  throw new Error(
    "Connector draft-test integration tests require a disposable test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const workspaceId = "connector-test-workspace";
const principalId = "connector-test-principal";
const timestamp = "2026-07-16T12:00:00.000Z";
const digest = (character: string) => character.repeat(64);

function createStore() {
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  let sequence = 0;
  return {
    client,
    store: new PostgresConnectorDraftTestStore(
      client,
      () => `connector-test-id-${++sequence}`,
    ),
  };
}

function identity(overrides: Partial<{ readonly sessionId: string }> = {}) {
  return {
    workspaceId,
    principalId,
    sessionId: overrides.sessionId ?? "connector-test-session",
    descriptorType: "git-markdown",
    descriptorVersion: "1",
    operation: "connector.test",
    candidateDigest: digest("a"),
  };
}

function audit(
  action:
    | "admin.connectorDraftTest.preview"
    | "admin.connectorDraftTest.executed",
  outcome: "succeeded" | "failed",
) {
  return {
    workspaceId,
    actorPrincipalId: principalId,
    action,
    targetId: "git-markdown@1",
    targetType: "connector-descriptor" as const,
    permission: "connector.manage" as const,
    outcome,
    requestId: "connector-test-request",
    correlationId: "connector-test-correlation",
    idempotencyKeyDigest: digest("b"),
    occurredAt: timestamp,
  };
}

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE workspaces RESTART IDENTITY CASCADE");
  await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [workspaceId]);
  await pool.query(
    "INSERT INTO principals (id, workspace_id) VALUES ($1, $2)",
    [principalId, workspaceId],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("PostgresConnectorDraftTestStore", () => {
  it("persists only the candidate digest, atomically audits preview/result, and enforces session confirmation plus idempotent replay", async () => {
    const { client, store } = createStore();
    try {
      const issued = await store.issueAndRecord({
        identity: identity(),
        audit: audit("admin.connectorDraftTest.preview", "succeeded"),
        now: timestamp,
      });
      await expect(
        store.consumeAndClaim({
          identity: identity({ sessionId: "other-session" }),
          confirmationId: issued.confirmationId,
          idempotencyKeyDigest: digest("b"),
          now: timestamp,
        }),
      ).resolves.toEqual({ kind: "outcome_unknown" });
      const acquired = await store.consumeAndClaim({
        identity: identity(),
        confirmationId: issued.confirmationId,
        idempotencyKeyDigest: digest("b"),
        now: timestamp,
      });
      expect(acquired).toEqual({
        kind: "acquired",
        claimId: "connector-test-id-3",
      });
      if (acquired.kind !== "acquired") throw new Error("Expected test claim.");

      const result = await store.completeAndRecord({
        claimId: acquired.claimId,
        identity: identity(),
        result: {
          outcome: "succeeded",
          completedAt: "2026-07-16T12:00:02.000Z",
        },
        audit: audit("admin.connectorDraftTest.executed", "succeeded"),
      });
      expect(result).toEqual({
        id: "connector-test-id-3",
        outcome: "succeeded",
        completedAt: "2026-07-16T12:00:02.000Z",
      });
      await expect(
        store.consumeAndClaim({
          identity: identity(),
          confirmationId: issued.confirmationId,
          idempotencyKeyDigest: digest("b"),
          now: timestamp,
        }),
      ).resolves.toEqual({ kind: "replayed", result });

      const [safeRows, audits] = await Promise.all([
        pool.query(`
          SELECT descriptor_type, descriptor_version, test_operation,
                 candidate_digest, confirmation, impact
          FROM administration_connector_draft_test_confirmations
        `),
        pool.query(`
          SELECT action, target_id, permission, outcome
          FROM audit_events
          ORDER BY occurred_at ASC
        `),
      ]);
      expect(safeRows.rows).toEqual([
        expect.objectContaining({
          descriptor_type: "git-markdown",
          descriptor_version: "1",
          test_operation: "connector.test",
          candidate_digest: digest("a"),
        }),
      ]);
      expect(
        `${JSON.stringify(safeRows.rows)}${JSON.stringify(audits.rows)}`,
      ).not.toMatch(
        /repository|settings|secret|token|locator|private\.example/iu,
      );
      expect(audits.rows).toEqual([
        expect.objectContaining({
          action: "admin.connectorDraftTest.preview",
          target_id: "git-markdown@1",
          permission: "connector.manage",
          outcome: "succeeded",
        }),
        expect.objectContaining({
          action: "admin.connectorDraftTest.executed",
          target_id: "git-markdown@1",
          permission: "connector.manage",
          outcome: "succeeded",
        }),
      ]);
      await expect(
        pool.query(
          "UPDATE administration_connector_draft_test_results SET outcome = 'failed' WHERE claim_id = $1",
          [acquired.claimId],
        ),
      ).rejects.toThrow("Connector draft-test results are immutable");
    } finally {
      await client.$disconnect();
    }
  });
});
