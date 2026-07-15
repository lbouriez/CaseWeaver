import { describe, expect, it, vi } from "vitest";

import {
  AdministrationValidationError,
  FinalAdministratorError,
  ReplaceWorkspacePrincipalRoles,
  requireAdministratorRetained,
  type WorkspaceRoleAssignmentStore,
} from "./index.js";

const digest = "a".repeat(64);

function command(
  overrides: Partial<
    Parameters<ReplaceWorkspacePrincipalRoles["execute"]>[0]
  > = {},
) {
  return {
    targetPrincipalId: "principal-target",
    roles: ["viewer"] as const,
    expectedRevision: 0,
    mutation: {
      operation: "workspace.roleAssignment.replace",
      keyDigest: digest,
      requestDigest: digest,
    },
    ...overrides,
  };
}

const context = {
  workspaceId: "workspace-a",
  actorPrincipalId: "principal-admin",
  occurredAt: "2026-07-15T00:00:00.000Z",
  origin: "admin_ui" as const,
};

function store(): WorkspaceRoleAssignmentStore {
  return {
    read: vi.fn(async () => undefined),
    replaceRolesAndRecord: vi.fn(async (input) => ({
      assignment: {
        workspaceId: input.context.workspaceId,
        principalId: input.command.targetPrincipalId,
        roles: input.command.roles,
        revision: 1,
      },
      previousRoles: [],
      idempotency: "created" as const,
    })),
  };
}

describe("ReplaceWorkspacePrincipalRoles", () => {
  it("accepts only a server-derived workspace/actor context and normalizes roles", async () => {
    const persistence = store();
    const useCase = new ReplaceWorkspacePrincipalRoles(persistence);

    await expect(
      useCase.execute(command({ roles: ["operator", "viewer"] }), context),
    ).resolves.toMatchObject({
      assignment: { roles: ["operator", "viewer"], revision: 1 },
    });
    expect(persistence.replaceRolesAndRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ roles: ["operator", "viewer"] }),
        context,
      }),
    );
  });

  it("rejects duplicate/unknown role names, invalid revisions, and malformed replay digests", async () => {
    const useCase = new ReplaceWorkspacePrincipalRoles(store());

    await expect(
      useCase.execute(command({ roles: ["viewer", "viewer"] }), context),
    ).rejects.toBeInstanceOf(AdministrationValidationError);
    await expect(
      useCase.execute(command({ roles: ["unknown"] as never }), context),
    ).rejects.toBeInstanceOf(AdministrationValidationError);
    await expect(
      useCase.execute(command({ expectedRevision: -1 }), context),
    ).rejects.toBeInstanceOf(AdministrationValidationError);
    await expect(
      useCase.execute(
        command({
          mutation: {
            operation: "bad operation",
            keyDigest: "x",
            requestDigest: "x",
          },
        }),
        context,
      ),
    ).rejects.toBeInstanceOf(AdministrationValidationError);
    await expect(
      useCase.execute(command(), { ...context, origin: "worker" as never }),
    ).rejects.toBeInstanceOf(AdministrationValidationError);
  });

  it("rejects removal or demotion of the final administrator", () => {
    expect(() =>
      requireAdministratorRetained({
        currentRoles: ["administrator"],
        requestedRoles: ["viewer"],
        administratorCount: 1,
      }),
    ).toThrow(FinalAdministratorError);
    expect(() =>
      requireAdministratorRetained({
        currentRoles: ["administrator"],
        requestedRoles: [],
        administratorCount: 2,
      }),
    ).not.toThrow();
  });
});
