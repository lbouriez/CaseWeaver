import { createHash } from "node:crypto";

import type { WorkspaceRole } from "@caseweaver/security";
import { isWorkspaceRole } from "@caseweaver/security";

import type { MutationIdentity } from "./configuration.js";
import {
  AdministrationValidationError,
  FinalAdministratorError,
  IdempotencyConflictError,
} from "./errors.js";

/** A server-owned audit code; an HTTP request cannot select this value. */
export const workspaceRoleAssignmentAuditAction =
  "admin.roleAssignment.replace" as const;

export const workspaceRoleAssignmentPermission = "identity.manage" as const;

/**
 * A principal's effective membership in one workspace. The `revision` belongs
 * to the complete workspace membership set so every administrator-changing
 * operation has one optimistic-concurrency boundary.
 */
export interface WorkspaceRoleAssignmentSnapshot {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly roles: readonly WorkspaceRole[];
  readonly revision: number;
}

/**
 * Only the target and requested role set originate from an administration
 * request. The active workspace and actor belong to the authenticated server
 * session and are supplied separately as trusted context.
 */
export interface ReplaceWorkspacePrincipalRolesCommand {
  readonly targetPrincipalId: string;
  readonly roles: readonly WorkspaceRole[];
  /** The current workspace membership-set revision. The initial revision is zero. */
  readonly expectedRevision: number;
  /** Required durable replay identity for the role mutation. */
  readonly mutation: MutationIdentity;
}

/**
 * Transport adapters construct this exclusively from validated session/request
 * state. Browser input must never supply the workspace, actor, permission,
 * action code, target type, or audit outcome.
 */
export interface TrustedWorkspaceRoleAssignmentContext {
  readonly workspaceId: string;
  readonly actorPrincipalId: string;
  readonly occurredAt: string;
  readonly origin: "admin_ui" | "api" | "cli";
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly traceId?: string;
  readonly uiActionId?: string;
  readonly idempotencyKeyDigest?: string;
  readonly clientAddress?: string;
  readonly userAgent?: string;
}

export interface WorkspaceRoleAssignmentMutationResult {
  readonly assignment: WorkspaceRoleAssignmentSnapshot;
  readonly previousRoles: readonly WorkspaceRole[];
  readonly idempotency: "created" | "replayed";
}

/**
 * The implementation performs authorization from persisted membership and
 * commits the membership state, replay record, immutable history, and the
 * server-owned success audit event in one durability boundary.
 */
export interface WorkspaceRoleAssignmentStore {
  read(
    input: Readonly<{
      readonly workspaceId: string;
      readonly principalId: string;
    }>,
  ): Promise<WorkspaceRoleAssignmentSnapshot | undefined>;
  replaceRolesAndRecord(
    input: Readonly<{
      readonly command: ReplaceWorkspacePrincipalRolesCommand;
      readonly context: TrustedWorkspaceRoleAssignmentContext;
    }>,
  ): Promise<WorkspaceRoleAssignmentMutationResult>;
}

/**
 * Provider-neutral administration use case. The adapter remains responsible
 * for durable locking and persisted authorization because only it can prove
 * that the active actor has the workspace membership it claims.
 */
export class ReplaceWorkspacePrincipalRoles {
  public constructor(private readonly store: WorkspaceRoleAssignmentStore) {}

  public async execute(
    command: ReplaceWorkspacePrincipalRolesCommand,
    context: TrustedWorkspaceRoleAssignmentContext,
  ): Promise<WorkspaceRoleAssignmentMutationResult> {
    validateCommand(command);
    validateTrustedContext(context);
    return this.store.replaceRolesAndRecord({
      command: Object.freeze({
        ...command,
        roles: normalizeWorkspaceRoles(command.roles),
      }),
      context: Object.freeze({ ...context }),
    });
  }
}

/**
 * Applies the final-administrator invariant against state read while holding
 * the workspace membership lock. It is exported for other persistence adapters
 * and never derives an actor or workspace from browser input.
 */
export function requireAdministratorRetained(
  input: Readonly<{
    readonly currentRoles: readonly WorkspaceRole[];
    readonly requestedRoles: readonly WorkspaceRole[];
    readonly administratorCount: number;
  }>,
): void {
  if (
    input.currentRoles.includes("administrator") &&
    !input.requestedRoles.includes("administrator") &&
    input.administratorCount <= 1
  ) {
    throw new FinalAdministratorError();
  }
}

/** Stable redacted identity used by immutable history and audit records. */
export function workspaceRoleAssignmentHash(
  input: Readonly<{
    readonly principalId: string;
    readonly roles: readonly WorkspaceRole[];
  }>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        principalId: input.principalId,
        roles: normalizeWorkspaceRoles(input.roles),
      }),
      "utf8",
    )
    .digest("hex");
}

export function normalizeWorkspaceRoles(
  roles: readonly WorkspaceRole[],
): readonly WorkspaceRole[] {
  const normalized = [...new Set(roles)].sort();
  if (normalized.length !== roles.length) {
    throw new AdministrationValidationError();
  }
  if (!normalized.every(isWorkspaceRole)) {
    throw new AdministrationValidationError();
  }
  return Object.freeze(normalized);
}

function validateCommand(command: ReplaceWorkspacePrincipalRolesCommand): void {
  if (!isStableIdentifier(command.targetPrincipalId)) {
    throw new AdministrationValidationError();
  }
  if (
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 0
  ) {
    throw new AdministrationValidationError();
  }
  normalizeWorkspaceRoles(command.roles);
  if (
    !isStableIdentifier(command.mutation.operation) ||
    !isDigest(command.mutation.keyDigest) ||
    !isDigest(command.mutation.requestDigest)
  ) {
    throw new AdministrationValidationError();
  }
}

function validateTrustedContext(
  context: TrustedWorkspaceRoleAssignmentContext,
): void {
  if (
    !isStableIdentifier(context.workspaceId) ||
    !isStableIdentifier(context.actorPrincipalId) ||
    !(["admin_ui", "api", "cli"] as const).includes(context.origin) ||
    Number.isNaN(new Date(context.occurredAt).getTime())
  ) {
    throw new AdministrationValidationError();
  }
}

function isStableIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
}

function isDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/iu.test(value);
}

export function requireDistinctMutation(
  expectedDigest: string,
  actualDigest: string,
): void {
  if (expectedDigest !== actualDigest) throw new IdempotencyConflictError();
}
