import { createHash, randomUUID } from "node:crypto";

import type { AuditStore, UnitOfWork } from "@caseweaver/application";
import {
  auditEventId,
  principalId,
  secretReference,
  type Sha256Digest,
  sha256Digest,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import type { PostgresTransactionLookup } from "@caseweaver/postgres";

import type {
  SecretReferenceLifecycle,
  SessionBoundAdminRequestContext,
} from "./operation-dispatcher.js";

/**
 * Control-plane lifecycle for externally managed secrets. The database stores
 * an opaque reference only, so rotating or revoking it cannot disclose or
 * mutate secret material. The lifecycle mutation and its server-owned audit
 * event are committed in one transaction.
 */
export class PostgresSecretReferenceLifecycle
  implements SecretReferenceLifecycle
{
  public constructor(
    private readonly dependencies: Readonly<{
      readonly unitOfWork: UnitOfWork & PostgresTransactionLookup;
      readonly auditStore: AuditStore;
      readonly eventId?: () => string;
      readonly now?: () => Date;
    }>,
  ) {}

  public async execute(
    input: Readonly<{
      readonly action: "secret.rotate" | "secret.revoke";
      readonly secretReferenceId: string;
      readonly context: SessionBoundAdminRequestContext;
      readonly idempotencyKeyDigest: Sha256Digest;
    }>,
  ): Promise<
    Readonly<{ readonly changed: boolean; readonly lifecycle: string }>
  > {
    const lifecycle =
      input.action === "secret.rotate" ? "rotation_required" : "revoked";
    return this.dependencies.unitOfWork.transaction(async (transaction) => {
      const changed = await this.dependencies.unitOfWork
        .get(transaction)
        .credentialRegistration.updateMany({
          where: {
            id: input.secretReferenceId,
            workspaceId: input.context.workspaceId,
            lifecycle: { not: lifecycle },
          },
          data: { lifecycle },
        });
      await this.dependencies.auditStore.append(transaction, {
        id: auditEventId((this.dependencies.eventId ?? randomUUID)()),
        workspaceId: workspaceId(input.context.workspaceId),
        actorPrincipalId: principalId(input.context.principalId),
        action:
          input.action === "secret.rotate"
            ? "admin.secretReference.rotationRequested"
            : "admin.secretReference.revoked",
        targetId: input.secretReferenceId,
        targetType: "secret_reference",
        permission: "credential.manage",
        outcome: changed.count === 1 ? "succeeded" : "attempted",
        origin: "admin_ui",
        occurredAt: utcInstant(this.dependencies.now?.() ?? new Date()),
        requestId: input.context.requestId,
        correlationId: input.context.correlationId,
        idempotencyKeyDigest: input.idempotencyKeyDigest,
        ...(input.context.uiActionId === undefined
          ? {}
          : { uiActionId: input.context.uiActionId }),
      });
      return Object.freeze({ changed: changed.count === 1, lifecycle });
    });
  }

  /**
   * Registers only an opaque external-secret locator. The locator is used for
   * server-side resolution later, but it is deliberately not returned or
   * copied into audit metadata. Creation, idempotency, and auditing share one
   * transaction so an un-audited reference cannot be created.
   */
  public async register(
    input: Readonly<{
      readonly workspaceId: string;
      readonly reference: string;
      readonly context: SessionBoundAdminRequestContext;
      readonly idempotencyKeyDigest: Sha256Digest;
    }>,
  ): Promise<Readonly<{ readonly id: string; readonly lifecycle: string }>> {
    const reference = secretReference(input.reference);
    const requestDigest = sha256Digest(
      createHash("sha256").update(reference, "utf8").digest("hex"),
    );
    const operation = "admin.secretReference.register";
    return this.dependencies.unitOfWork.transaction(async (transaction) => {
      const database = this.dependencies.unitOfWork.get(transaction);
      await database.$queryRaw`
        SELECT 1 AS locked
        FROM pg_advisory_xact_lock(
          hashtextextended(${`${input.workspaceId}:${operation}:${input.idempotencyKeyDigest}`}, 0)
        )
      `;
      const existingMutation = await database.idempotencyRecord.findUnique({
        where: {
          workspaceId_operation_keyDigest: {
            workspaceId: input.workspaceId,
            operation,
            keyDigest: input.idempotencyKeyDigest,
          },
        },
        select: { requestDigest: true, resourceId: true },
      });
      if (existingMutation !== null) {
        if (existingMutation.requestDigest !== requestDigest) {
          throw new Error("idempotency.conflict");
        }
        return Object.freeze({
          id: existingMutation.resourceId,
          lifecycle: "active",
        });
      }

      const alreadyRegistered =
        await database.credentialRegistration.findUnique({
          where: {
            workspaceId_secretReference: {
              workspaceId: input.workspaceId,
              secretReference: reference,
            },
          },
          select: { id: true, lifecycle: true },
        });
      const registration =
        alreadyRegistered ??
        (await database.credentialRegistration.create({
          data: {
            id: randomUUID(),
            workspaceId: input.workspaceId,
            secretReference: reference,
            lifecycle: "active",
          },
          select: { id: true, lifecycle: true },
        }));
      await database.idempotencyRecord.create({
        data: {
          workspaceId: input.workspaceId,
          operation,
          keyDigest: input.idempotencyKeyDigest,
          requestDigest,
          resourceId: registration.id,
        },
      });
      await this.dependencies.auditStore.append(transaction, {
        id: auditEventId((this.dependencies.eventId ?? randomUUID)()),
        workspaceId: workspaceId(input.workspaceId),
        actorPrincipalId: principalId(input.context.principalId),
        action: "admin.secretReference.registered",
        targetId: registration.id,
        targetType: "secret_reference",
        permission: "credential.manage",
        outcome: alreadyRegistered === null ? "succeeded" : "attempted",
        origin: "admin_ui",
        occurredAt: utcInstant(this.dependencies.now?.() ?? new Date()),
        requestId: input.context.requestId,
        correlationId: input.context.correlationId,
        idempotencyKeyDigest: input.idempotencyKeyDigest,
        ...(input.context.uiActionId === undefined
          ? {}
          : { uiActionId: input.context.uiActionId }),
      });
      return Object.freeze({
        id: registration.id,
        lifecycle: registration.lifecycle,
      });
    });
  }
}
