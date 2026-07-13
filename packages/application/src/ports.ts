import type {
  AnalysisIdentityId,
  AnalysisJob,
  AnalysisJobId,
  AnalysisProfileVersionId,
  CaseSnapshotId,
  CorrelationId,
  Envelope,
  PrincipalId,
  RequestId,
  Sha256Digest,
  UtcInstant,
  WorkspaceId,
} from "@caseweaver/domain";
import type {
  AuditRecord,
  Permission,
  WorkspaceRole,
} from "@caseweaver/security";

export interface ApplicationTransaction {
  readonly transactionBoundary: unique symbol;
}

export interface UnitOfWork {
  transaction<Result>(
    operation: (transaction: ApplicationTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface Clock {
  now(): UtcInstant;
}

export type IdentifierKind =
  | "workspace"
  | "principal"
  | "auditEvent"
  | "analysisIdentity"
  | "analysisJob"
  | "outboxEnvelope";

export interface IdGenerator {
  next(kind: IdentifierKind): string;
}

export interface ExecutionContext {
  readonly requestId: RequestId;
  readonly workspaceId: WorkspaceId;
  readonly principalId: PrincipalId;
  readonly correlationId: CorrelationId;
  readonly signal: AbortSignal;
}

export interface AuthorizationGuard {
  require(context: ExecutionContext, permission: Permission): Promise<void>;
}

export interface TrustedBootstrapAdministrator {
  readonly principalId: PrincipalId;
}

/**
 * This port is supplied only by trusted installation composition. Request data
 * never provides the principal that becomes the first administrator.
 */
export interface BootstrapAuthorization {
  resolveInitialAdministrator(): Promise<TrustedBootstrapAdministrator>;
}

export interface BootstrapInstallation {
  readonly workspaceId: WorkspaceId;
  readonly principalId: PrincipalId;
}

export interface BootstrapWorkspaceStore {
  lockInstallation(
    transaction: ApplicationTransaction,
  ): Promise<BootstrapInstallation | undefined>;
  createWorkspace(
    transaction: ApplicationTransaction,
    workspaceId: WorkspaceId,
    occurredAt: UtcInstant,
  ): Promise<void>;
  createPrincipal(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly principalId: PrincipalId;
      readonly occurredAt: UtcInstant;
    },
  ): Promise<void>;
  assignWorkspaceRole(
    transaction: ApplicationTransaction,
    assignment: {
      readonly workspaceId: WorkspaceId;
      readonly principalId: PrincipalId;
      readonly role: WorkspaceRole;
      readonly occurredAt: UtcInstant;
    },
  ): Promise<void>;
  completeInstallation(
    transaction: ApplicationTransaction,
    installation: BootstrapInstallation,
    occurredAt: UtcInstant,
  ): Promise<void>;
}

export interface AuditStore {
  append(
    transaction: ApplicationTransaction,
    record: AuditRecord,
  ): Promise<void>;
}

export interface StoredIdempotencyRecord {
  readonly requestDigest: Sha256Digest;
  readonly resourceId: AnalysisJobId;
}

export interface AnalysisIdentityRecord {
  readonly id: AnalysisIdentityId;
  readonly workspaceId: WorkspaceId;
  readonly identityHash: Sha256Digest;
  readonly analysisProfileVersionId: AnalysisProfileVersionId;
  readonly caseSnapshotId: CaseSnapshotId;
}

export interface AnalysisRequestStore {
  lockIdempotencyKey(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly operation: "analysis.request";
      readonly keyDigest: Sha256Digest;
    },
  ): Promise<void>;
  findIdempotency(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly operation: "analysis.request";
      readonly keyDigest: Sha256Digest;
    },
  ): Promise<StoredIdempotencyRecord | undefined>;
  recordIdempotency(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly operation: "analysis.request";
      readonly keyDigest: Sha256Digest;
      readonly requestDigest: Sha256Digest;
      readonly resourceId: AnalysisJobId;
      readonly occurredAt: UtcInstant;
    },
  ): Promise<void>;
  findOrCreateIdentity(
    transaction: ApplicationTransaction,
    input: {
      readonly id: AnalysisIdentityId;
      readonly workspaceId: WorkspaceId;
      readonly identityHash: Sha256Digest;
      readonly analysisProfileVersionId: AnalysisProfileVersionId;
      readonly caseSnapshotId: CaseSnapshotId;
      readonly occurredAt: UtcInstant;
    },
  ): Promise<AnalysisIdentityRecord>;
  findJobByRunOrdinal(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly analysisIdentityId: AnalysisIdentityId;
      readonly runOrdinal: number;
    },
  ): Promise<AnalysisJob | undefined>;
  createJob(
    transaction: ApplicationTransaction,
    job: AnalysisJob,
  ): Promise<void>;
  lockIdentityForRerun(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly analysisIdentityId: AnalysisIdentityId;
    },
  ): Promise<{
    readonly identity: AnalysisIdentityRecord;
    readonly nextRunOrdinal: number;
  }>;
  findJob(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly analysisJobId: AnalysisJobId;
    },
  ): Promise<AnalysisJob | undefined>;
  updateJobState(
    transaction: ApplicationTransaction,
    job: AnalysisJob,
  ): Promise<void>;
}

export interface ClaimedOutboxEnvelope {
  readonly envelope: Envelope;
  readonly claimToken: string;
}

export interface OutboxStore {
  append(
    transaction: ApplicationTransaction,
    envelope: Envelope,
  ): Promise<void>;
  claim(
    transaction: ApplicationTransaction,
    input: {
      readonly limit: number;
      readonly leaseMs: number;
      readonly now: UtcInstant;
    },
  ): Promise<readonly ClaimedOutboxEnvelope[]>;
  acknowledge(
    transaction: ApplicationTransaction,
    claim: ClaimedOutboxEnvelope,
    deliveredAt: UtcInstant,
  ): Promise<void>;
}

export interface DurableMessageQueue {
  publish(envelope: Envelope): Promise<void>;
}

export interface ResourceLease {
  readonly fencingToken: bigint;
  readonly expiresAt: UtcInstant;
}

export interface ResourceLeaseStore {
  acquire(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly resourceType: string;
      readonly resourceKey: string;
      readonly leaseMs: number;
    },
  ): Promise<ResourceLease | undefined>;
  complete(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly resourceType: string;
      readonly resourceKey: string;
      readonly fencingToken: bigint;
    },
  ): Promise<boolean>;
}

export type AuditRecordInput = Omit<AuditRecord, "id">;
