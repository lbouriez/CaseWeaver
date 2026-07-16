import { describe, expect, it, vi } from "vitest";

import {
  ensureBootstrapAdministrator,
  ensureBootstrapPasswordAdministrator,
} from "./bootstrap-administrator.js";

describe("ensureBootstrapAdministrator", () => {
  it("creates the deployment-owned first mapping, administrator role, and audit atomically", async () => {
    const findUnique = vi.fn(async () => null);
    const workspaceUpsert = vi.fn(async () => undefined);
    const principalUpsert = vi.fn(async () => undefined);
    const roleUpsert = vi.fn(async () => undefined);
    const mappingCreate = vi.fn(async () => undefined);
    const append = vi.fn(async () => undefined);
    const transaction = {};
    await ensureBootstrapAdministrator({
      unitOfWork: {
        transaction: async (operation) => operation(transaction as never),
        get: () => ({
          oidcIdentityMapping: { findUnique, create: mappingCreate },
          workspace: { upsert: workspaceUpsert },
          principal: { upsert: principalUpsert },
          workspaceRoleAssignment: { upsert: roleUpsert },
        }),
      } as never,
      auditStore: { append } as never,
      workspaceId: "workspace-1",
      principalId: "principal-1",
      issuer: "https://issuer.example",
      subject: "subject-1",
      displayName: "Initial Administrator",
      id: () => "bootstrap-id",
      now: () => new Date("2026-07-15T12:00:00.000Z"),
    });
    expect(mappingCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace-1",
        principalId: "principal-1",
        issuer: "https://issuer.example",
        subject: "subject-1",
      }),
    });
    expect(roleUpsert).toHaveBeenCalledWith({
      where: expect.any(Object),
      create: expect.objectContaining({ role: "administrator" }),
      update: {},
    });
    expect(append).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ action: "admin.bootstrap.identity.created" }),
    );
  });
});

describe("ensureBootstrapPasswordAdministrator", () => {
  it("creates a deployment-owned local administrator without an external identity mapping", async () => {
    const principalFindUnique = vi.fn(async () => null);
    const principalUpsert = vi.fn(async () => undefined);
    const roleUpsert = vi.fn(async () => undefined);
    const mappingCreate = vi.fn(async () => undefined);
    const append = vi.fn(async () => undefined);
    const transaction = {};

    await ensureBootstrapPasswordAdministrator({
      unitOfWork: {
        transaction: async (operation) => operation(transaction as never),
        get: () => ({
          principal: {
            findUnique: principalFindUnique,
            upsert: principalUpsert,
          },
          workspace: { upsert: vi.fn(async () => undefined) },
          workspaceRoleAssignment: { upsert: roleUpsert },
          oidcIdentityMapping: { create: mappingCreate },
        }),
      } as never,
      auditStore: { append } as never,
      workspaceId: "workspace-1",
      principalId: "local-password-administrator",
      id: () => "bootstrap-id",
      now: () => new Date("2026-07-15T12:00:00.000Z"),
    });

    expect(principalUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ id: "local-password-administrator" }),
      }),
    );
    expect(mappingCreate).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        action: "admin.bootstrap.password.administrator.created",
      }),
    );
  });
});
