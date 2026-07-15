import { describe, expect, it, vi } from "vitest";

import { PostgresSecretReferenceLifecycle } from "./secret-reference-lifecycle.js";

describe("PostgresSecretReferenceLifecycle", () => {
  it("changes only opaque metadata and appends its audit record in the same transaction", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const append = vi.fn(async () => undefined);
    const transaction = {};
    const lifecycle = new PostgresSecretReferenceLifecycle({
      unitOfWork: {
        transaction: async (operation) => operation(transaction as never),
        get: () => ({ credentialRegistration: { updateMany } }),
      } as never,
      auditStore: { append } as never,
      eventId: () => "audit-1",
      now: () => new Date("2026-07-15T12:00:00.000Z"),
    });

    await expect(
      lifecycle.execute({
        action: "secret.revoke",
        secretReferenceId: "credential-1",
        idempotencyKeyDigest: "a".repeat(64) as never,
        context: {
          workspaceId: "workspace-1",
          principalId: "principal-1",
          sessionId: "session-1",
          requestId: "request-1",
          correlationId: "correlation-1",
          permissions: ["credential.manage"],
          requestMode: "user",
        },
      }),
    ).resolves.toEqual({ changed: true, lifecycle: "revoked" });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "credential-1",
        workspaceId: "workspace-1",
        lifecycle: { not: "revoked" },
      },
      data: { lifecycle: "revoked" },
    });
    expect(append).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        action: "admin.secretReference.revoked",
        outcome: "succeeded",
        permission: "credential.manage",
        targetId: "credential-1",
      }),
    );
  });

  it("registers an opaque external locator atomically without putting it in audit data", async () => {
    const create = vi.fn(async () => ({
      id: "credential-1",
      lifecycle: "active",
    }));
    const append = vi.fn(async () => undefined);
    const transaction = {};
    const lifecycle = new PostgresSecretReferenceLifecycle({
      unitOfWork: {
        transaction: async (operation) => operation(transaction as never),
        get: () => ({
          $queryRaw: vi.fn(async () => []),
          idempotencyRecord: {
            findUnique: vi.fn(async () => null),
            create: vi.fn(async () => undefined),
          },
          credentialRegistration: {
            findUnique: vi.fn(async () => null),
            create,
          },
        }),
      } as never,
      auditStore: { append } as never,
      eventId: () => "audit-1",
    });

    await expect(
      lifecycle.register({
        workspaceId: "workspace-1",
        reference: "vault:operator/connector-token",
        idempotencyKeyDigest: "a".repeat(64) as never,
        context: {
          workspaceId: "workspace-1",
          principalId: "principal-1",
          sessionId: "session-1",
          requestId: "request-1",
          correlationId: "correlation-1",
          permissions: ["credential.manage"],
          requestMode: "user",
        },
      }),
    ).resolves.toEqual({ id: "credential-1", lifecycle: "active" });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "workspace-1",
          secretReference: "vault:operator/connector-token",
          lifecycle: "active",
        }),
      }),
    );
    expect(append).toHaveBeenCalledWith(
      transaction,
      expect.not.objectContaining({
        secretReference: expect.anything(),
        reference: expect.anything(),
      }),
    );
  });
});
