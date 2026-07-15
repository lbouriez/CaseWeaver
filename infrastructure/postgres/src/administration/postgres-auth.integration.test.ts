import { Pool } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { createPostgresPersistence } from "../index.js";
import {
  PostgresAuthSessionAuditMutationStore,
  PostgresOidcIdentityMappingStore,
} from "./auth.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.DATABASE_URL;
if (
  databaseUrl === undefined ||
  !new URL(databaseUrl).pathname.includes("test")
) {
  throw new Error(
    "PostgreSQL authentication tests require a disposable test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });

const audit = (input: {
  readonly action:
    | "auth.login.succeeded"
    | "auth.logout.succeeded"
    | "auth.workspace.switch.succeeded";
  readonly targetType: "auth-session" | "workspace";
  readonly targetId: string;
}) => ({
  failClosed: true as const,
  event: {
    workspaceId: "workspace-a",
    actorPrincipalId: "principal-a",
    action: input.action,
    outcome: "succeeded" as const,
    targetType: input.targetType,
    targetId: input.targetId,
    occurredAt: "2026-01-01T00:00:00.000Z",
  },
});

const session = (id: string) => ({
  id,
  workspaceId: "workspace-a",
  principalId: "principal-a",
  sessionDigest: `${id}-digest`,
  csrfDigest: `${id}-csrf-digest`,
  csrf: { keyId: "key-a", ciphertext: `${id}-sealed-csrf` },
  expiresAt: "2027-01-01T00:00:00.000Z",
});

beforeAll(async () => {
  await pool.query(`
    TRUNCATE TABLE audit_events, administration_sessions,
      administration_login_transactions, oidc_identity_mappings, principals,
      workspaces RESTART IDENTITY CASCADE
  `);
  await pool.query(
    "INSERT INTO workspaces (id) VALUES ('workspace-a'); INSERT INTO principals (id, workspace_id) VALUES ('principal-a', 'workspace-a')",
  );
});

describe("PostgreSQL authentication persistence", () => {
  it("returns secret-reference metadata without selecting the external reference value", async () => {
    await pool.query(`
      INSERT INTO credential_registrations (id, workspace_id, secret_reference, lifecycle)
      VALUES ('credential-a', 'workspace-a', 'vault://operator/secret-a', 'active')
    `);
    const persistence = createPostgresPersistence({ databaseUrl });
    await expect(
      persistence.administrationResourceReadStore.list({
        workspaceId: "workspace-a",
        resource: "secret-references",
        limit: 20,
      }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: "credential-a",
          status: "active",
          summary:
            "Reference metadata only; secret material is never returned.",
        }),
      ],
      page: { hasNextPage: false },
    });
    await persistence.close();
  });

  it("persists a redacted append-only authentication audit event", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    await persistence.authAuditRecorder.record({
      failClosed: true,
      event: {
        workspaceId: "workspace-a",
        actorPrincipalId: "principal-a",
        action: "auth.login.succeeded",
        outcome: "succeeded",
        targetType: "auth-session",
        targetId: "current",
        occurredAt: "2026-01-01T00:00:00.000Z",
        requestId: "request-a",
        correlationId: "correlation-a",
        clientAddress: "192.0.2.1",
        userAgent: "CaseWeaver Admin",
      },
    });
    await expect(
      pool.query(`SELECT action, actor_principal_id, target_id, client_address, user_agent
        FROM audit_events WHERE action = 'auth.login.succeeded'`),
    ).resolves.toMatchObject({
      rows: [
        {
          action: "auth.login.succeeded",
          actor_principal_id: "principal-a",
          target_id: "current",
          client_address: "192.0.2.1",
          user_agent: "CaseWeaver Admin",
        },
      ],
    });
    await persistence.close();
  });

  it("consumes a one-use OIDC state and persists only sealed callback material", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    const store = persistence.authSessionStore;
    await store.createLoginTransaction({
      id: "login-1",
      stateDigest: "state-digest",
      nonce: { keyId: "key-a", ciphertext: "sealed-nonce" },
      verifier: { keyId: "key-a", ciphertext: "sealed-verifier" },
      returnPath: "/",
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    const first = await store.consumeLoginTransaction(
      "state-digest",
      "2026-01-01T00:00:00.000Z",
    );
    const replay = await store.consumeLoginTransaction(
      "state-digest",
      "2026-01-01T00:00:00.000Z",
    );

    expect(first?.verifier.ciphertext).toBe("sealed-verifier");
    expect(replay).toBeUndefined();
    const stored = await pool.query<{
      verifier_ciphertext: string;
      encryption_key_id: string;
    }>(
      "SELECT verifier_ciphertext, encryption_key_id FROM administration_login_transactions WHERE id = 'login-1'",
    );
    expect(stored.rows[0]).toEqual({
      verifier_ciphertext: "sealed-verifier",
      encryption_key_id: "key-a",
    });
    await persistence.close();
  });

  it("finds only non-revoked, unexpired opaque sessions", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    const store = persistence.authSessionStore;
    await store.createSession({
      id: "session-1",
      workspaceId: "workspace-a",
      principalId: "principal-a",
      sessionDigest: "session-digest",
      csrfDigest: "csrf-digest",
      csrf: { keyId: "key-a", ciphertext: "sealed-csrf" },
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    expect(
      await store.findActiveSession(
        "session-digest",
        "2026-01-01T00:00:00.000Z",
      ),
    ).toMatchObject({ principalId: "principal-a", workspaceId: "workspace-a" });
    await store.revokeSession("session-digest", "2026-01-01T00:00:00.000Z");
    expect(
      await store.findActiveSession(
        "session-digest",
        "2026-01-01T00:00:01.000Z",
      ),
    ).toBeUndefined();
    await persistence.close();
  });

  it("rotates an active session atomically and invalidates the predecessor", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    const store = persistence.authSessionStore;
    await store.createSession({
      id: "session-rotate-old",
      workspaceId: "workspace-a",
      principalId: "principal-a",
      sessionDigest: "session-rotate-old-digest",
      csrfDigest: "csrf-old",
      csrf: { keyId: "key-a", ciphertext: "sealed-csrf-old" },
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    expect(
      await store.rotateSession({
        previousSessionDigest: "session-rotate-old-digest",
        replacement: {
          id: "session-rotate-new",
          workspaceId: "workspace-a",
          principalId: "principal-a",
          sessionDigest: "session-rotate-new-digest",
          csrfDigest: "csrf-new",
          csrf: { keyId: "key-a", ciphertext: "sealed-csrf-new" },
          expiresAt: "2027-01-01T00:00:00.000Z",
        },
        now: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      await store.findActiveSession(
        "session-rotate-old-digest",
        "2026-01-01T00:00:01.000Z",
      ),
    ).toBeUndefined();
    expect(
      await store.findActiveSession(
        "session-rotate-new-digest",
        "2026-01-01T00:00:01.000Z",
      ),
    ).toMatchObject({ csrfDigest: "csrf-new" });
    await persistence.close();
  });

  it("commits a successful session mutation and its append-only audit event together", async () => {
    const client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    const store = new PostgresAuthSessionAuditMutationStore(client);
    try {
      await store.createSessionAndRecord({
        session: session("atomic-create"),
        audit: audit({
          action: "auth.login.succeeded",
          targetType: "auth-session",
          targetId: "atomic-create",
        }),
      });
      await expect(
        pool.query(
          "SELECT id FROM administration_sessions WHERE id = 'atomic-create'",
        ),
      ).resolves.toMatchObject({ rows: [{ id: "atomic-create" }] });
      await expect(
        pool.query(
          "SELECT action, target_id FROM audit_events WHERE target_id = 'atomic-create'",
        ),
      ).resolves.toMatchObject({
        rows: [{ action: "auth.login.succeeded", target_id: "atomic-create" }],
      });
    } finally {
      await client.$disconnect();
    }
  });

  it("rolls back create, revoke, and rotation when the authoritative audit append fails", async () => {
    const client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    const store = new PostgresAuthSessionAuditMutationStore(client);
    const persistence = createPostgresPersistence({ databaseUrl });
    const plainSessions = persistence.authSessionStore;
    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_pbi016_auth_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action IN (
          'auth.login.succeeded', 'auth.logout.succeeded',
          'auth.workspace.switch.succeeded'
        ) THEN
          RAISE EXCEPTION 'pbi016 audit append rejected';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_pbi016_auth_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION reject_pbi016_auth_audit();
    `);
    try {
      await expect(
        store.createSessionAndRecord({
          session: session("rollback-create"),
          audit: audit({
            action: "auth.login.succeeded",
            targetType: "auth-session",
            targetId: "rollback-create",
          }),
        }),
      ).rejects.toThrow("pbi016 audit append rejected");

      await plainSessions.createSession(session("rollback-revoke"));
      await expect(
        store.revokeSessionAndRecord({
          sessionDigest: "rollback-revoke-digest",
          now: "2026-01-01T00:00:00.000Z",
          audit: audit({
            action: "auth.logout.succeeded",
            targetType: "auth-session",
            targetId: "rollback-revoke",
          }),
        }),
      ).rejects.toThrow("pbi016 audit append rejected");

      await plainSessions.createSession(session("rollback-rotate-old"));
      await expect(
        store.rotateSessionAndRecord({
          previousSessionDigest: "rollback-rotate-old-digest",
          replacement: session("rollback-rotate-new"),
          now: "2026-01-01T00:00:00.000Z",
          audit: audit({
            action: "auth.workspace.switch.succeeded",
            targetType: "workspace",
            targetId: "workspace-a",
          }),
        }),
      ).rejects.toThrow("pbi016 audit append rejected");

      await expect(
        pool.query(`SELECT id, revoked_at FROM administration_sessions
          WHERE id IN ('rollback-create', 'rollback-revoke',
            'rollback-rotate-old', 'rollback-rotate-new') ORDER BY id`),
      ).resolves.toMatchObject({
        rows: [
          { id: "rollback-revoke", revoked_at: null },
          { id: "rollback-rotate-old", revoked_at: null },
        ],
      });
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS reject_pbi016_auth_audit ON audit_events; DROP FUNCTION IF EXISTS reject_pbi016_auth_audit()",
      );
      await persistence.close();
      await client.$disconnect();
    }
  });

  it("resolves only workspace mappings for the validated issuer and subject", async () => {
    await pool.query(`
      INSERT INTO workspaces (id) VALUES ('workspace-b'), ('workspace-c');
      INSERT INTO principals (id, workspace_id) VALUES
        ('principal-b', 'workspace-b'), ('principal-c', 'workspace-c');
      INSERT INTO oidc_identity_mappings (
        id, workspace_id, principal_id, issuer, subject, display_name
      ) VALUES
        ('mapping-a', 'workspace-a', 'principal-a', 'https://issuer.example', 'subject-1', 'Operator'),
        ('mapping-b', 'workspace-b', 'principal-b', 'https://issuer.example', 'subject-1', 'Operator'),
        ('mapping-c', 'workspace-c', 'principal-c', 'https://issuer.example', 'subject-2', 'Other');
    `);
    const client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    const store = new PostgresOidcIdentityMappingStore(client);
    await expect(
      store.findByExternalIdentity({
        issuer: "https://issuer.example",
        subject: "subject-1",
      }),
    ).resolves.toMatchObject([
      { workspaceId: "workspace-a", principalId: "principal-a" },
      { workspaceId: "workspace-b", principalId: "principal-b" },
    ]);
    await expect(
      store.findByWorkspacePrincipal({
        workspaceId: "workspace-c",
        principalId: "principal-c",
      }),
    ).resolves.toMatchObject({ subject: "subject-2" });
    await client.$disconnect();
  });
});
