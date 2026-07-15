import { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";

import {
  AdministrationConflictError,
  AdministrationDeniedError,
  AdministrationNotFoundError,
  FinalAdministratorError,
} from "@caseweaver/administration";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import { PostgresWorkspaceRoleAssignmentStore } from "./workspace-role-assignment-store.js";

const databaseUrl = process.env.DATABASE_URL;
if (
  databaseUrl === undefined ||
  !new URL(databaseUrl).pathname.includes("test")
) {
  throw new Error(
    "PostgreSQL role-assignment tests require a disposable test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const digest = (character: string) => character.repeat(64);

function command(input: {
  readonly targetPrincipalId: string;
  readonly roles: readonly (
    | "administrator"
    | "operator"
    | "analyst"
    | "viewer"
  )[];
  readonly expectedRevision: number;
  readonly key: string;
  readonly request?: string;
}) {
  return {
    targetPrincipalId: input.targetPrincipalId,
    roles: input.roles,
    expectedRevision: input.expectedRevision,
    mutation: {
      operation: "workspace.roleAssignment.replace",
      keyDigest: digest(input.key),
      requestDigest: digest(input.request ?? input.key),
    },
  };
}

function context(
  overrides: Partial<{
    readonly workspaceId: string;
    readonly actorPrincipalId: string;
  }> = {},
) {
  return {
    workspaceId: "workspace-role-a",
    actorPrincipalId: "principal-role-admin",
    occurredAt: "2026-07-15T00:00:00.000Z",
    origin: "admin_ui" as const,
    requestId: "request-role-a",
    correlationId: "correlation-role-a",
    uiActionId: "ui-role-a",
    idempotencyKeyDigest: digest("i"),
    ...overrides,
  };
}

function createStore() {
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  return {
    client,
    store: new PostgresWorkspaceRoleAssignmentStore(client),
  };
}

beforeEach(async () => {
  await pool.query(`
    TRUNCATE TABLE
      audit_events,
      workspace_role_assignment_mutations,
      workspace_role_assignment_revisions,
      workspace_role_assignment_states,
      workspace_role_assignments,
      principals,
      workspaces
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`
    INSERT INTO workspaces (id) VALUES ('workspace-role-a'), ('workspace-role-b');
    INSERT INTO principals (id, workspace_id) VALUES
      ('principal-role-admin', 'workspace-role-a'),
      ('principal-role-target', 'workspace-role-a'),
      ('principal-role-other', 'workspace-role-a'),
      ('principal-role-viewer', 'workspace-role-a'),
      ('principal-role-b', 'workspace-role-b');
    INSERT INTO workspace_role_assignments (workspace_id, principal_id, role) VALUES
      ('workspace-role-a', 'principal-role-admin', 'administrator'),
      ('workspace-role-a', 'principal-role-viewer', 'viewer');
  `);
});

describe("PostgresWorkspaceRoleAssignmentStore", () => {
  it("atomically records a workspace-scoped role assignment, immutable history, idempotency result, and authoritative audit", async () => {
    const { client, store } = createStore();
    try {
      await expect(
        store.replaceRolesAndRecord({
          command: command({
            targetPrincipalId: "principal-role-target",
            roles: ["operator", "viewer"],
            expectedRevision: 0,
            key: "a",
          }),
          context: context(),
        }),
      ).resolves.toEqual({
        assignment: {
          workspaceId: "workspace-role-a",
          principalId: "principal-role-target",
          roles: ["operator", "viewer"],
          revision: 1,
        },
        previousRoles: [],
        idempotency: "created",
      });

      await expect(
        store.replaceRolesAndRecord({
          command: command({
            targetPrincipalId: "principal-role-target",
            roles: ["operator", "viewer"],
            expectedRevision: 0,
            key: "a",
          }),
          context: context(),
        }),
      ).resolves.toMatchObject({ idempotency: "replayed" });

      await expect(
        pool.query(`
          SELECT action, target_id, permission, outcome, before_hash, after_hash,
                 ui_action_id, request_id, correlation_id
          FROM audit_events
        `),
      ).resolves.toMatchObject({
        rows: [
          {
            action: "admin.roleAssignment.replace",
            target_id: "principal-role-target",
            permission: "identity.manage",
            outcome: "succeeded",
            before_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
            after_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
            ui_action_id: "ui-role-a",
            request_id: "request-role-a",
            correlation_id: "correlation-role-a",
          },
        ],
      });
      await expect(
        pool.query(
          "SELECT revision, previous_roles, current_roles FROM workspace_role_assignment_revisions",
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            revision: 1,
            previous_roles: [],
            current_roles: ["operator", "viewer"],
          },
        ],
        fields: expect.any(Array),
      });
      await expect(
        pool.query(
          "UPDATE workspace_role_assignment_revisions SET revision = 2 WHERE revision = 1",
        ),
      ).rejects.toThrow("Workspace role assignment revisions are immutable");
      await expect(
        pool.query(
          "UPDATE workspace_role_assignment_mutations SET revision = 2 WHERE operation = 'workspace.roleAssignment.replace'",
        ),
      ).rejects.toThrow("Workspace role assignment mutations are immutable");
    } finally {
      await client.$disconnect();
    }
  });

  it("rejects a stale concurrent workspace revision and conflicting idempotency reuse", async () => {
    const first = createStore();
    const second = createStore();
    try {
      const outcomes = await Promise.allSettled([
        first.store.replaceRolesAndRecord({
          command: command({
            targetPrincipalId: "principal-role-target",
            roles: ["viewer"],
            expectedRevision: 0,
            key: "b",
          }),
          context: context(),
        }),
        second.store.replaceRolesAndRecord({
          command: command({
            targetPrincipalId: "principal-role-other",
            roles: ["analyst"],
            expectedRevision: 0,
            key: "c",
          }),
          context: context(),
        }),
      ]);
      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome.status === "rejected")[0],
      ).toMatchObject({
        reason: expect.any(AdministrationConflictError),
      });
      await expect(
        first.store.replaceRolesAndRecord({
          command: command({
            targetPrincipalId: "principal-role-target",
            roles: ["operator"],
            expectedRevision: 1,
            key: "z",
          }),
          context: context(),
        }),
      ).resolves.toMatchObject({ idempotency: "created" });
      await expect(
        first.store.replaceRolesAndRecord({
          command: command({
            targetPrincipalId: "principal-role-target",
            roles: ["viewer"],
            expectedRevision: 2,
            key: "z",
            request: "d",
          }),
          context: context(),
        }),
      ).rejects.toMatchObject({ code: "administration.idempotencyConflict" });
    } finally {
      await first.client.$disconnect();
      await second.client.$disconnect();
    }
  });

  it("does not permit a final administrator to be removed or demoted, including direct database writes", async () => {
    const { client, store } = createStore();
    try {
      await expect(
        store.replaceRolesAndRecord({
          command: command({
            targetPrincipalId: "principal-role-admin",
            roles: ["viewer"],
            expectedRevision: 0,
            key: "e",
          }),
          context: context(),
        }),
      ).rejects.toBeInstanceOf(FinalAdministratorError);
      await expect(
        pool.query(`
          DELETE FROM workspace_role_assignments
          WHERE workspace_id = 'workspace-role-a'
            AND principal_id = 'principal-role-admin'
            AND role = 'administrator'
        `),
      ).rejects.toThrow("A workspace must retain at least one administrator");
      await expect(
        pool.query(`
          UPDATE workspace_role_assignments
          SET role = 'viewer'
          WHERE workspace_id = 'workspace-role-a'
            AND principal_id = 'principal-role-admin'
            AND role = 'administrator'
        `),
      ).rejects.toThrow("A workspace must retain at least one administrator");
      await expect(
        store.read({
          workspaceId: "workspace-role-a",
          principalId: "principal-role-admin",
        }),
      ).resolves.toMatchObject({ roles: ["administrator"], revision: 0 });
    } finally {
      await client.$disconnect();
    }
  });

  it("uses persisted authorization and workspace predicates instead of caller claims", async () => {
    const { client, store } = createStore();
    try {
      await expect(
        store.replaceRolesAndRecord({
          command: command({
            targetPrincipalId: "principal-role-target",
            roles: ["viewer"],
            expectedRevision: 0,
            key: "f",
          }),
          context: context({ actorPrincipalId: "principal-role-viewer" }),
        }),
      ).rejects.toBeInstanceOf(AdministrationDeniedError);
      await expect(
        store.replaceRolesAndRecord({
          command: command({
            targetPrincipalId: "principal-role-b",
            roles: ["viewer"],
            expectedRevision: 0,
            key: "g",
          }),
          context: context(),
        }),
      ).rejects.toBeInstanceOf(AdministrationNotFoundError);
      await expect(
        pool.query("SELECT count(*)::int AS count FROM audit_events"),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await client.$disconnect();
    }
  });

  it("rolls back membership, history, replay state, and revision when audit persistence fails", async () => {
    const { client, store } = createStore();
    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_role_assignment_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'admin.roleAssignment.replace' THEN
          RAISE EXCEPTION 'role assignment audit append rejected';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_role_assignment_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION reject_role_assignment_audit();
    `);
    try {
      await expect(
        store.replaceRolesAndRecord({
          command: command({
            targetPrincipalId: "principal-role-target",
            roles: ["viewer"],
            expectedRevision: 0,
            key: "h",
          }),
          context: context(),
        }),
      ).rejects.toThrow("role assignment audit append rejected");
      await expect(
        store.read({
          workspaceId: "workspace-role-a",
          principalId: "principal-role-target",
        }),
      ).resolves.toMatchObject({ roles: [], revision: 0 });
      await expect(
        pool.query(`
          SELECT
            (SELECT count(*)::int FROM workspace_role_assignment_revisions) AS revisions,
            (SELECT count(*)::int FROM workspace_role_assignment_mutations) AS mutations,
            (SELECT count(*)::int FROM workspace_role_assignment_states) AS states
        `),
      ).resolves.toMatchObject({
        rows: [{ revisions: 0, mutations: 0, states: 0 }],
      });
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS reject_role_assignment_audit ON audit_events; DROP FUNCTION IF EXISTS reject_role_assignment_audit()",
      );
      await client.$disconnect();
    }
  });
});
