import {
  type AuditEventId,
  AuthorizationError,
  type PrincipalId,
  type SecretReference,
  type Sha256Digest,
  type UtcInstant,
  type WorkspaceId,
} from "@caseweaver/domain";

export const workspaceRoles = [
  "administrator",
  "operator",
  "analyst",
  "viewer",
] as const;

export type WorkspaceRole = (typeof workspaceRoles)[number];

export const permissions = [
  "analysis.request",
  "analysis.forceRerun",
  "analysis.cancel",
  "analysis.read",
  "evidence.read",
  "connector.manage",
  "credential.manage",
  "publication.approve",
  "publication.publish",
  "configuration.manage",
  "audit.read",
  "operations.inspect",
  "operations.retry",
  "operations.recover",
  "cost.read",
  "privacy.delete",
  "retention.run",
] as const;

export type Permission = (typeof permissions)[number];

const rolePermissions: Readonly<Record<WorkspaceRole, readonly Permission[]>> =
  {
    administrator: permissions,
    operator: [
      "analysis.request",
      "analysis.forceRerun",
      "analysis.cancel",
      "analysis.read",
      "evidence.read",
      "connector.manage",
      "credential.manage",
      "publication.approve",
      "publication.publish",
      "audit.read",
      "operations.inspect",
      "operations.retry",
      "operations.recover",
      "cost.read",
      "retention.run",
    ],
    analyst: ["analysis.request", "analysis.read", "evidence.read"],
    viewer: ["analysis.read", "evidence.read"],
  };

export interface WorkspaceRoleAssignment {
  readonly workspaceId: WorkspaceId;
  readonly principalId: PrincipalId;
  readonly role: WorkspaceRole;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly permission: Permission;
}

export function isWorkspaceRole(value: string): value is WorkspaceRole {
  return (workspaceRoles as readonly string[]).includes(value);
}

export function can(
  assignments: readonly WorkspaceRoleAssignment[],
  workspaceId: WorkspaceId,
  principalId: PrincipalId,
  permission: Permission,
): AuthorizationDecision {
  const allowed = assignments.some(
    (assignment) =>
      assignment.workspaceId === workspaceId &&
      assignment.principalId === principalId &&
      rolePermissions[assignment.role].includes(permission),
  );

  return Object.freeze({ allowed, permission });
}

export function requirePermission(
  assignments: readonly WorkspaceRoleAssignment[],
  workspaceId: WorkspaceId,
  principalId: PrincipalId,
  permission: Permission,
): void {
  if (!can(assignments, workspaceId, principalId, permission).allowed) {
    throw new AuthorizationError(permission);
  }
}

export interface SecretReferenceAudit {
  readonly secretReference: SecretReference;
  readonly action: "registered" | "rotated" | "revoked";
  readonly workspaceId: WorkspaceId;
  readonly actorPrincipalId: PrincipalId;
  readonly occurredAt: UtcInstant;
}

export interface AuditRecord {
  readonly id: AuditEventId;
  readonly workspaceId: WorkspaceId;
  readonly actorPrincipalId?: PrincipalId;
  readonly action: string;
  readonly targetId?: string;
  readonly beforeHash?: Sha256Digest;
  readonly afterHash?: Sha256Digest;
  readonly occurredAt: UtcInstant;
}
