import type {
  AnalysisIdentityId,
  AnalysisJob,
  AnalysisJobId,
  AnalysisProfileVersionId,
  AnalysisResultId,
  CaseSnapshotId,
  CorrelationId,
  Envelope,
  PrincipalId,
  PublicationIntentId,
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
  | "publicationIntent"
  | "publicationAttempt"
  | "outboxEnvelope"
  | "retentionWorkItem";

export interface IdGenerator {
  next(kind: IdentifierKind): string;
}

export interface ExecutionContext {
  readonly requestId: RequestId;
  readonly workspaceId: WorkspaceId;
  readonly principalId: PrincipalId;
  readonly correlationId: CorrelationId;
  readonly traceContext?: import("@caseweaver/domain").TraceContext;
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

export interface PublicationTarget {
  readonly connectorInstanceId: string;
  readonly resourceType: string;
  readonly externalId: string;
}

export interface StoredPublicationProfile {
  readonly id: string;
  readonly version: string;
  readonly destinationConnectorInstanceId: string;
  readonly policy: {
    readonly mode: "previewOnly" | "approvalRequired" | "autoPublishInternal";
    readonly visibility: "internal";
  };
}

/**
 * Intent creation and ready-command handoff share a transaction with analysis
 * resolution. `enqueuePublication` is idempotent by the envelope ID.
 */
export interface PublicationIntentStore {
  findProfile(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly profileId: string;
      readonly profileVersion: string;
    },
  ): Promise<StoredPublicationProfile | undefined>;
  createOrFindIntent(
    transaction: ApplicationTransaction,
    input: {
      readonly id: PublicationIntentId;
      readonly workspaceId: WorkspaceId;
      readonly analysisJobId: AnalysisJobId;
      readonly profile: StoredPublicationProfile;
      readonly target: PublicationTarget;
      readonly intentHash: Sha256Digest;
      readonly state:
        | "pending"
        | "awaitingApproval"
        | "publishing"
        | "published"
        | "outcomeUnknown"
        | "failed"
        | "skipped";
      readonly occurredAt: UtcInstant;
    },
  ): Promise<import("@caseweaver/domain").PublicationIntent>;
  findIntent(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly publicationIntentId: PublicationIntentId;
    },
  ): Promise<import("@caseweaver/domain").PublicationIntent | undefined>;
  updateIntent(
    transaction: ApplicationTransaction,
    intent: import("@caseweaver/domain").PublicationIntent,
  ): Promise<void>;
  approveIntent(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly publicationIntentId: PublicationIntentId;
      readonly actorPrincipalId: PrincipalId;
      readonly occurredAt: UtcInstant;
    },
  ): Promise<
    | Readonly<{
        readonly outcome: "approved" | "alreadyApproved";
        readonly intent: import("@caseweaver/domain").PublicationIntent;
      }>
    | Readonly<{ readonly outcome: "notApprovable" }>
  >;
  bindAnalysisResult(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly analysisJobId: AnalysisJobId;
      readonly analysisResultId: AnalysisResultId;
    },
  ): Promise<void>;
  findReadyIntentIds(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly analysisJobId: AnalysisJobId;
    },
  ): Promise<readonly PublicationIntentId[]>;
  enqueuePublication(
    transaction: ApplicationTransaction,
    envelope: Envelope,
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

export type OperationalAction =
  | "operations.cancel"
  | "operations.retry"
  | "operations.recover"
  | "privacy.purge"
  | "retention.reap";

export interface StoredOperationalAction {
  readonly requestDigest: Sha256Digest;
  readonly resourceId: string;
}

export interface DeadLetterRecord {
  readonly jobId: AnalysisJobId;
  readonly analysisIdentityId: AnalysisIdentityId;
  readonly failedAt: UtcInstant;
  readonly failureCode: string;
  readonly retryable: boolean;
  readonly attemptOrdinal: number;
}

export interface CostAttributionRecord {
  readonly operationId: string;
  readonly parentOperationId?: string;
  readonly analysisJobId?: AnalysisJobId;
  readonly connectorInstanceId?: string;
  readonly sourceId?: string;
  readonly role: string;
  readonly configuredModel: string;
  readonly startedAt: UtcInstant;
  readonly finishedAt?: UtcInstant;
  readonly status: string;
  readonly calculatedAmount?: string;
  readonly currency?: string;
  readonly providerReportedAmount?: string;
  readonly calculationStatus: string;
}

export interface CostAttributionQuery {
  readonly analysisJobId?: AnalysisJobId;
  readonly connectorInstanceId?: string;
  readonly role?: string;
  readonly startedAfter?: UtcInstant;
  readonly startedBefore?: UtcInstant;
  readonly limit: number;
}

export interface RetentionWorkItem {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly storageKey?: string;
}

export interface ClaimedRetentionWorkItem extends RetentionWorkItem {
  readonly fencingToken: bigint;
}

/**
 * Operational records remain workspace-scoped. Mutation methods are invoked
 * inside the caller's transaction together with their audit and outbox writes.
 */
export interface OperationsStore {
  lockAction(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly action: OperationalAction;
      readonly keyDigest: Sha256Digest;
    },
  ): Promise<void>;
  findAction(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly action: OperationalAction;
      readonly keyDigest: Sha256Digest;
    },
  ): Promise<StoredOperationalAction | undefined>;
  recordAction(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly action: OperationalAction;
      readonly keyDigest: Sha256Digest;
      readonly requestDigest: Sha256Digest;
      readonly resourceId: string;
      readonly occurredAt: UtcInstant;
    },
  ): Promise<void>;
  inspectDeadLetters(
    transaction: ApplicationTransaction,
    input: { readonly workspaceId: WorkspaceId; readonly limit: number },
  ): Promise<readonly DeadLetterRecord[]>;
  retryDeadLetter(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly failedJobId: AnalysisJobId;
      readonly replacementJobId: AnalysisJobId;
      readonly occurredAt: UtcInstant;
    },
  ): Promise<AnalysisJob | undefined>;
  cancelJob(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly analysisJobId: AnalysisJobId;
      readonly occurredAt: UtcInstant;
    },
  ): Promise<AnalysisJob | undefined>;
  recoverExpiredJob(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly analysisJobId: AnalysisJobId;
      readonly fencingToken: bigint;
      readonly occurredAt: UtcInstant;
    },
  ): Promise<AnalysisJob | undefined>;
  queryCostAttribution(
    transaction: ApplicationTransaction,
    query: CostAttributionQuery & { readonly workspaceId: WorkspaceId },
  ): Promise<readonly CostAttributionRecord[]>;
  purgeCaseSnapshot(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly caseSnapshotId: CaseSnapshotId;
      readonly actorPrincipalId: PrincipalId;
      readonly reason: string;
      readonly occurredAt: UtcInstant;
    },
  ): Promise<
    | { readonly kind: "notFound" }
    | {
        readonly kind: "purged" | "alreadyPurged";
        readonly workItems: readonly RetentionWorkItem[];
      }
  >;
  queueExpiredRetention(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly limit: number;
      readonly occurredAt: UtcInstant;
    },
  ): Promise<readonly RetentionWorkItem[]>;
  claimRetentionWork(
    transaction: ApplicationTransaction,
    input: { readonly workspaceId: WorkspaceId; readonly workItemId: string },
  ): Promise<ClaimedRetentionWorkItem | undefined>;
  completeRetentionWork(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly workItemId: string;
      readonly fencingToken: bigint;
      readonly occurredAt: UtcInstant;
    },
  ): Promise<boolean>;
  releaseRetentionWork(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly workItemId: string;
      readonly fencingToken: bigint;
      readonly occurredAt: UtcInstant;
    },
  ): Promise<void>;
}

export type AuditRecordInput = Omit<AuditRecord, "id">;
