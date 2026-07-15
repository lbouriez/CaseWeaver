import { describe, expect, it, vi } from "vitest";

import { ensureBootstrapAdministrator } from "./bootstrap-administrator.js";

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
