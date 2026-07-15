import { randomUUID } from "node:crypto";

import type {
  ReplaceWorkspacePrincipalRolesCommand,
  TrustedWorkspaceRoleAssignmentContext,
  WorkspaceRoleAssignmentMutationResult,
  WorkspaceRoleAssignmentSnapshot,
  WorkspaceRoleAssignmentStore,
} from "@caseweaver/administration";
import {
  AdministrationConflictError,
  AdministrationDeniedError,
  AdministrationNotFoundError,
  requireAdministratorRetained,
  requireDistinctMutation,
  workspaceRoleAssignmentAuditAction,
  workspaceRoleAssignmentHash,
  workspaceRoleAssignmentPermission,
} from "@caseweaver/administration";
import type { WorkspaceRole } from "@caseweaver/security";
import { isWorkspaceRole } from "@caseweaver/security";
import type { Prisma, PrismaClient } from "@prisma/client";

type Database = PrismaClient | Prisma.TransactionClient;

interface LockedWorkspaceRoleAssignmentState {
  readonly revision: number;
}

/**
 * PostgreSQL implementation of workspace membership administration. It checks
 * the actor's persisted administrator membership itself, so a caller cannot
 * turn browser-submitted actor/role claims into authority. The write, durable
 * idempotency result, immutable history, and server-owned audit append share
 * exactly one transaction.
 */
export class PostgresWorkspaceRoleAssignmentStore
  implements WorkspaceRoleAssignmentStore
{
  public constructor(private readonly client: PrismaClient) {}

  public async read(
    input: Readonly<{
      readonly workspaceId: string;
      readonly principalId: string;
    }>,
  ): Promise<WorkspaceRoleAssignmentSnapshot | undefined> {
    const principal = await this.client.principal.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: input.principalId,
        },
      },
      select: { id: true },
    });
    if (principal === null) return undefined;
    const [roles, state] = await Promise.all([
      this.client.workspaceRoleAssignment.findMany({
        where: input,
        orderBy: { role: "asc" },
        select: { role: true },
      }),
      this.client.workspaceRoleAssignmentState.findUnique({
        where: { workspaceId: input.workspaceId },
        select: { revision: true },
      }),
    ]);
    return Object.freeze({
      workspaceId: input.workspaceId,
      principalId: input.principalId,
      roles: deserializeRoles(roles.map((assignment) => assignment.role)),
      revision: state?.revision ?? 0,
    });
  }

  public async replaceRolesAndRecord(
    input: Readonly<{
      readonly command: ReplaceWorkspacePrincipalRolesCommand;
      readonly context: TrustedWorkspaceRoleAssignmentContext;
    }>,
  ): Promise<WorkspaceRoleAssignmentMutationResult> {
    return this.client.$transaction(async (database) => {
      await requireWorkspaceRoleAssignmentState(
        database,
        input.context.workspaceId,
      );
      const state = await lockWorkspaceRoleAssignmentState(
        database,
        input.context.workspaceId,
      );
      await requirePersistedAdministrator(database, input.context);
      const existing =
        await database.workspaceRoleAssignmentMutation.findUnique({
          where: {
            workspaceId_operation_keyDigest: {
              workspaceId: input.context.workspaceId,
              operation: input.command.mutation.operation,
              keyDigest: input.command.mutation.keyDigest,
            },
          },
        });
      if (existing !== null) {
        requireDistinctMutation(
          input.command.mutation.requestDigest,
          existing.requestDigest,
        );
        return mutationResult({
          workspaceId: input.context.workspaceId,
          principalId: existing.targetPrincipalId,
          currentRoles: deserializeRoles(existing.currentRoles),
          previousRoles: deserializeRoles(existing.previousRoles),
          revision: existing.revision,
          idempotency: "replayed",
        });
      }
      if (state.revision !== input.command.expectedRevision) {
        throw new AdministrationConflictError();
      }

      const target = await database.principal.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.context.workspaceId,
            id: input.command.targetPrincipalId,
          },
        },
        select: { id: true },
      });
      if (target === null) throw new AdministrationNotFoundError();

      const currentRows = await database.workspaceRoleAssignment.findMany({
        where: {
          workspaceId: input.context.workspaceId,
          principalId: input.command.targetPrincipalId,
        },
        orderBy: { role: "asc" },
        select: { role: true },
      });
      const previousRoles = deserializeRoles(
        currentRows.map((assignment) => assignment.role),
      );
      const currentRoles = deserializeRoles(input.command.roles);
      const administratorCount = await database.workspaceRoleAssignment.count({
        where: {
          workspaceId: input.context.workspaceId,
          role: "administrator",
        },
      });
      requireAdministratorRetained({
        currentRoles: previousRoles,
        requestedRoles: currentRoles,
        administratorCount,
      });

      const rolesToRemove = previousRoles.filter(
        (role) => !currentRoles.includes(role),
      );
      const rolesToAdd = currentRoles.filter(
        (role) => !previousRoles.includes(role),
      );
      if (rolesToRemove.length > 0) {
        await database.workspaceRoleAssignment.deleteMany({
          where: {
            workspaceId: input.context.workspaceId,
            principalId: input.command.targetPrincipalId,
            role: { in: rolesToRemove },
          },
        });
      }
      if (rolesToAdd.length > 0) {
        await database.workspaceRoleAssignment.createMany({
          data: rolesToAdd.map((role) => ({
            workspaceId: input.context.workspaceId,
            principalId: input.command.targetPrincipalId,
            role,
            createdAt: asDate(input.context.occurredAt),
          })),
        });
      }

      const revision = state.revision + 1;
      await database.workspaceRoleAssignmentState.update({
        where: { workspaceId: input.context.workspaceId },
        data: { revision, updatedAt: asDate(input.context.occurredAt) },
      });
      await database.workspaceRoleAssignmentRevision.create({
        data: {
          id: randomUUID(),
          workspaceId: input.context.workspaceId,
          revision,
          targetPrincipalId: input.command.targetPrincipalId,
          actorPrincipalId: input.context.actorPrincipalId,
          previousRoles: previousRoles as Prisma.InputJsonValue,
          currentRoles: currentRoles as Prisma.InputJsonValue,
          occurredAt: asDate(input.context.occurredAt),
        },
      });
      await database.workspaceRoleAssignmentMutation.create({
        data: {
          workspaceId: input.context.workspaceId,
          operation: input.command.mutation.operation,
          keyDigest: input.command.mutation.keyDigest,
          requestDigest: input.command.mutation.requestDigest,
          targetPrincipalId: input.command.targetPrincipalId,
          revision,
          previousRoles: previousRoles as Prisma.InputJsonValue,
          currentRoles: currentRoles as Prisma.InputJsonValue,
          createdAt: asDate(input.context.occurredAt),
        },
      });
      await appendRoleAssignmentAudit(database, {
        context: input.context,
        targetPrincipalId: input.command.targetPrincipalId,
        previousRoles,
        currentRoles,
      });
      return mutationResult({
        workspaceId: input.context.workspaceId,
        principalId: input.command.targetPrincipalId,
        currentRoles,
        previousRoles,
        revision,
        idempotency: "created",
      });
    });
  }
}

async function requirePersistedAdministrator(
  database: Database,
  context: TrustedWorkspaceRoleAssignmentContext,
): Promise<void> {
  const actor = await database.workspaceRoleAssignment.findUnique({
    where: {
      workspaceId_principalId_role: {
        workspaceId: context.workspaceId,
        principalId: context.actorPrincipalId,
        role: "administrator",
      },
    },
    select: { role: true },
  });
  if (actor === null) throw new AdministrationDeniedError();
}

async function requireWorkspaceRoleAssignmentState(
  database: Database,
  workspaceId: string,
): Promise<void> {
  await database.$executeRaw`
    INSERT INTO workspace_role_assignment_states (workspace_id, revision)
    VALUES (${workspaceId}, 0)
    ON CONFLICT (workspace_id) DO NOTHING
  `;
}

async function lockWorkspaceRoleAssignmentState(
  database: Database,
  workspaceId: string,
): Promise<LockedWorkspaceRoleAssignmentState> {
  const rows = await database.$queryRaw<
    readonly LockedWorkspaceRoleAssignmentState[]
  >`
    SELECT revision
    FROM workspace_role_assignment_states
    WHERE workspace_id = ${workspaceId}
    FOR UPDATE
  `;
  const state = rows[0];
  if (state === undefined) throw new AdministrationConflictError();
  return state;
}

async function appendRoleAssignmentAudit(
  database: Database,
  input: Readonly<{
    readonly context: TrustedWorkspaceRoleAssignmentContext;
    readonly targetPrincipalId: string;
    readonly previousRoles: readonly WorkspaceRole[];
    readonly currentRoles: readonly WorkspaceRole[];
  }>,
): Promise<void> {
  await database.auditEvent.create({
    data: {
      id: randomUUID(),
      workspaceId: input.context.workspaceId,
      actorPrincipalId: input.context.actorPrincipalId,
      action: workspaceRoleAssignmentAuditAction,
      targetId: input.targetPrincipalId,
      beforeHash: workspaceRoleAssignmentHash({
        principalId: input.targetPrincipalId,
        roles: input.previousRoles,
      }),
      afterHash: workspaceRoleAssignmentHash({
        principalId: input.targetPrincipalId,
        roles: input.currentRoles,
      }),
      occurredAt: asDate(input.context.occurredAt),
      origin: input.context.origin,
      targetType: "workspace-principal",
      outcome: "succeeded",
      permission: workspaceRoleAssignmentPermission,
      ...(input.context.uiActionId === undefined
        ? {}
        : { uiActionId: input.context.uiActionId }),
      ...(input.context.requestId === undefined
        ? {}
        : { requestId: input.context.requestId }),
      ...(input.context.correlationId === undefined
        ? {}
        : { correlationId: input.context.correlationId }),
      ...(input.context.traceId === undefined
        ? {}
        : { traceId: input.context.traceId }),
      ...(input.context.idempotencyKeyDigest === undefined
        ? {}
        : { idempotencyKeyDigest: input.context.idempotencyKeyDigest }),
      ...(input.context.clientAddress === undefined
        ? {}
        : { clientAddress: input.context.clientAddress }),
      ...(input.context.userAgent === undefined
        ? {}
        : { userAgent: input.context.userAgent }),
    },
  });
}

function mutationResult(
  input: Readonly<{
    readonly workspaceId: string;
    readonly principalId: string;
    readonly currentRoles: readonly WorkspaceRole[];
    readonly previousRoles: readonly WorkspaceRole[];
    readonly revision: number;
    readonly idempotency: "created" | "replayed";
  }>,
): WorkspaceRoleAssignmentMutationResult {
  return Object.freeze({
    assignment: Object.freeze({
      workspaceId: input.workspaceId,
      principalId: input.principalId,
      roles: Object.freeze([...input.currentRoles]),
      revision: input.revision,
    }),
    previousRoles: Object.freeze([...input.previousRoles]),
    idempotency: input.idempotency,
  });
}

function deserializeRoles(value: unknown): readonly WorkspaceRole[] {
  if (
    !Array.isArray(value) ||
    !value.every(isWorkspaceRole) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("Persisted workspace role assignment is invalid.");
  }
  return Object.freeze([...value].sort());
}

function asDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("A UTC timestamp is invalid.");
  }
  return date;
}
