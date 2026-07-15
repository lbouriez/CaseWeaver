import type { AuditStore, UnitOfWork } from "@caseweaver/application";
import {
  auditEventId,
  principalId,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import type { PostgresTransactionLookup } from "@caseweaver/postgres";

/**
 * One deployment-owned first-administrator bootstrap. It is intentionally not
 * an HTTP endpoint: accepting an arbitrary external subject from a browser
 * would permit an account-takeover race on a fresh installation. Once the
 * mapping exists, normal OIDC session and role-assignment policy applies.
 */
export async function ensureBootstrapAdministrator(
  input: Readonly<{
    readonly unitOfWork: UnitOfWork & PostgresTransactionLookup;
    readonly auditStore: AuditStore;
    readonly workspaceId: string;
    readonly principalId: string;
    readonly issuer: string;
    readonly subject: string;
    readonly displayName: string;
    readonly now?: () => Date;
    readonly id?: () => string;
  }>,
): Promise<void> {
  await input.unitOfWork.transaction(async (transaction) => {
    const database = input.unitOfWork.get(transaction);
    const existing = await database.oidcIdentityMapping.findUnique({
      where: {
        workspaceId_issuer_subject: {
          workspaceId: input.workspaceId,
          issuer: input.issuer,
          subject: input.subject,
        },
      },
      select: { principalId: true },
    });
    if (existing !== null && existing.principalId !== input.principalId) {
      throw new Error("Bootstrap OIDC subject is already mapped.");
    }
    await database.workspace.upsert({
      where: { id: input.workspaceId },
      create: { id: input.workspaceId },
      update: {},
    });
    await database.principal.upsert({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: input.principalId,
        },
      },
      create: { id: input.principalId, workspaceId: input.workspaceId },
      update: {},
    });
    await database.workspaceRoleAssignment.upsert({
      where: {
        workspaceId_principalId_role: {
          workspaceId: input.workspaceId,
          principalId: input.principalId,
          role: "administrator",
        },
      },
      create: {
        workspaceId: input.workspaceId,
        principalId: input.principalId,
        role: "administrator",
      },
      update: {},
    });
    if (existing === null) {
      await database.oidcIdentityMapping.create({
        data: {
          id: (input.id ?? randomUUID)(),
          workspaceId: input.workspaceId,
          principalId: input.principalId,
          issuer: input.issuer,
          subject: input.subject,
          displayName: input.displayName,
        },
      });
      await input.auditStore.append(transaction, {
        id: auditEventId((input.id ?? randomUUID)()),
        workspaceId: workspaceId(input.workspaceId),
        actorPrincipalId: principalId(input.principalId),
        action: "admin.bootstrap.identity.created",
        targetType: "oidc_identity_mapping",
        targetId: input.principalId,
        permission: "identity.manage",
        outcome: "succeeded",
        origin: "api",
        occurredAt: utcInstant(input.now?.() ?? new Date()),
      });
    }
  });
}
import { randomUUID } from "node:crypto";
