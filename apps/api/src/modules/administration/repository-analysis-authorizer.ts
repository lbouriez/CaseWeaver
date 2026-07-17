import { createHash, randomUUID } from "node:crypto";

import type { AuditStore, UnitOfWork } from "@caseweaver/application";
import {
  auditEventId,
  principalId,
  sha256Digest,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";

import type { RepositoryAnalysisApiAuthorizer } from "./repository-analysis-api.js";

/**
 * Audit/authorization boundary for repository-analysis facade requests.
 * Successful configuration mutations receive their authoritative audit in the
 * same transaction as the immutable version from the administration use case;
 * reads and denied attempts are durably audited here and fail closed.
 */
export class RepositoryAnalysisAdministrationAuthorizer
  implements RepositoryAnalysisApiAuthorizer
{
  public constructor(
    private readonly dependencies: Readonly<{
      readonly unitOfWork: UnitOfWork;
      readonly auditStore: AuditStore;
      readonly eventId?: () => string;
      readonly now?: () => Date;
    }>,
  ) {}

  public async require(
    input: Parameters<RepositoryAnalysisApiAuthorizer["require"]>[0],
  ): Promise<void> {
    const authorized = input.context.permissions.includes(input.permission);
    if (input.mutation && authorized) return;
    await this.dependencies.unitOfWork.transaction(async (transaction) =>
      this.dependencies.auditStore.append(transaction, {
        id: auditEventId((this.dependencies.eventId ?? randomUUID)()),
        workspaceId: workspaceId(input.context.workspaceId),
        actorPrincipalId: principalId(input.context.principalId),
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        permission: input.permission,
        outcome: authorized ? "succeeded" : "denied",
        ...(authorized ? {} : { reasonCode: "authorization.denied" }),
        origin: "admin_ui",
        occurredAt: utcInstant((this.dependencies.now ?? (() => new Date()))()),
        requestId: input.context.requestId,
        correlationId: input.context.correlationId,
        ...(input.context.uiActionId === undefined
          ? {}
          : { uiActionId: input.context.uiActionId }),
        ...(input.context.idempotencyKey === undefined
          ? {}
          : {
              idempotencyKeyDigest: sha256Digest(
                createHash("sha256")
                  .update(input.context.idempotencyKey, "utf8")
                  .digest("hex"),
              ),
            }),
      }),
    );
    if (!authorized) throw new Error("authorization.denied");
  }
}
