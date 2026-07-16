import type {
  AnalysisIdentityId,
  AnalysisJob,
  AnalysisJobId,
  AnalysisProfileVersionId,
  AnalysisResultId,
  AnalysisTriggerId,
  AnalysisTriggerRequestId,
  AnalysisTriggerVersionId,
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
  | "analysisTriggerRequest"
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

/** Opaque target identifiers are validated at the transport/domain boundary. */
export interface AnalysisTriggerTarget {
  readonly connectorInstanceId: string;
  readonly resourceType: string;
  readonly externalId: string;
}

export type AnalysisTriggerSource = "manual" | "schedule" | "webhook";

/**
 * Unpersisted normalized case content. The persistence adapter assigns the
 * snapshot identifier and deduplicates it under the exact workspace target.
 * This port is server-private and must never be implemented at an HTTP/API
 * boundary or populated with connector settings/credential locators.
 */
export interface CapturedCaseSnapshot {
  readonly revision: string;
  readonly capturedAt: UtcInstant;
  readonly title: string;
  readonly summary: string;
  readonly contentHash: Sha256Digest;
  readonly messages: readonly Readonly<{
    readonly id: string;
    readonly content: string;
    readonly contentHash: Sha256Digest;
  }>[];
  /**
   * Case-source attachment references observed with this immutable capture.
   * They are opaque connector references only: PostgreSQL resolves them to
   * already completed, verified derivatives while the snapshot transaction is
   * open. A later attachment upload or derivative must never alter an existing
   * snapshot's evidence set.
   */
  readonly attachmentReferences?: readonly Readonly<{
    readonly connectorRegistrationId: string;
    readonly resourceType: string;
    readonly externalId: string;
  }>[];
}

/** Immutable request material returned only from the durable trigger store. */
export interface AnalysisTriggerRequest {
  readonly id: AnalysisTriggerRequestId;
  readonly workspaceId: WorkspaceId;
  /** Principal authorized when the durable request was first accepted. */
  readonly actorPrincipalId: PrincipalId;
  readonly triggerId: AnalysisTriggerId;
  readonly triggerVersionId: AnalysisTriggerVersionId;
  readonly analysisProfileVersionId: AnalysisProfileVersionId;
  readonly connectorRegistrationId: string;
  readonly connectorConfigurationVersionId: string;
  readonly source: AnalysisTriggerSource;
  readonly occurrenceKey?: string;
  readonly target: AnalysisTriggerTarget;
  readonly idempotencyKeyDigest: Sha256Digest;
  readonly requestDigest: Sha256Digest;
}

export interface ClaimedAnalysisTriggerRequest {
  readonly request: AnalysisTriggerRequest;
  /** Database-issued monotonic token required for capture writes. */
  readonly fencingToken: bigint;
}

/**
 * A captured request is converted to the existing PBI-011 command while the
 * trigger-request row remains locked. The command carries only hashes and
 * immutable IDs; profile settings and snapshot content stay server-private.
 */
export interface PreparedAnalysisTriggerSubmission {
  readonly request: AnalysisTriggerRequest;
  readonly command: import("./use-cases.js").RequestAnalysisCommand;
}

/**
 * Creates server-owned durable trigger requests, and coordinates an expiring,
 * fenced capture claim. It never exposes connector settings, secret locators,
 * clients, or raw webhook input.
 */
export interface AnalysisTriggerRequestStore {
  createOrFind(
    transaction: ApplicationTransaction,
    input: {
      readonly id: AnalysisTriggerRequestId;
      readonly workspaceId: WorkspaceId;
      readonly actorPrincipalId: PrincipalId;
      readonly triggerId: AnalysisTriggerId;
      /**
       * Automated ingress may retain the exact immutable trigger revision that
       * accepted an event. Omitting it is permitted only for an authorized
       * interactive request that resolves the current active revision inside
       * this transaction.
       */
      readonly expectedTriggerVersionId?: AnalysisTriggerVersionId;
      readonly source: AnalysisTriggerSource;
      readonly occurrenceKey?: string;
      readonly target: AnalysisTriggerTarget;
      readonly idempotencyKeyDigest: Sha256Digest;
      readonly requestDigest: Sha256Digest;
      readonly occurredAt: UtcInstant;
    },
  ): Promise<
    | Readonly<{
        readonly kind: "created";
        readonly request: AnalysisTriggerRequest;
      }>
    | Readonly<{
        readonly kind: "replayed";
        readonly request: AnalysisTriggerRequest;
      }>
  >;
  claimCapture(
    transaction: ApplicationTransaction,
    input: {
      readonly command: import("@caseweaver/domain").EnvelopeFor<"analysis.trigger.v2">;
      readonly leaseMs: number;
    },
  ): Promise<
    | Readonly<{
        readonly kind: "claimed";
        readonly claim: ClaimedAnalysisTriggerRequest;
      }>
    | Readonly<{
        readonly kind: "captured";
        readonly caseSnapshotId: CaseSnapshotId;
        /** Exact immutable request that previously captured this snapshot. */
        readonly request: AnalysisTriggerRequest;
      }>
    | Readonly<{ readonly kind: "alreadyCapturing" }>
    | Readonly<{ readonly kind: "unavailable" }>
    | Readonly<{ readonly kind: "notFound" }>
  >;
  persistCapture(
    transaction: ApplicationTransaction,
    input: {
      readonly claim: ClaimedAnalysisTriggerRequest;
      readonly snapshot: CapturedCaseSnapshot;
    },
  ): Promise<CaseSnapshotId>;
  failCapture(
    transaction: ApplicationTransaction,
    input: {
      readonly claim: ClaimedAnalysisTriggerRequest;
      readonly error: { readonly code: string; readonly retryable: boolean };
      readonly occurredAt: UtcInstant;
    },
  ): Promise<void>;
  /**
   * Locks and revalidates a captured v2 request, then derives the exact
   * PBI-011 request command from the retained snapshot and profile version.
   */
  prepareAnalysisSubmission(
    transaction: ApplicationTransaction,
    input: {
      readonly command: import("@caseweaver/domain").EnvelopeFor<"analysis.trigger.v2">;
    },
  ): Promise<
    | Readonly<{
        readonly kind: "ready";
        readonly submission: PreparedAnalysisTriggerSubmission;
      }>
    | Readonly<{
        readonly kind: "submitted";
        readonly analysisJobId: AnalysisJobId;
      }>
    | Readonly<{ readonly kind: "notCaptured" | "notFound" | "unavailable" }>
  >;
  /**
   * Commits the immutable trigger-request to analysis-job relationship in the
   * same transaction that creates/replays PBI-011 analysis work.
   */
  bindAnalysisJob(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly triggerRequestId: AnalysisTriggerRequestId;
      readonly analysisJobId: AnalysisJobId;
      readonly occurredAt: UtcInstant;
    },
  ): Promise<void>;
}

/**
 * Trusted composition resolves a CaseSource privately from the immutable pins
 * in the claim and supplies only normalized case content for durable capture.
 */
export interface TriggeredCaseSnapshotCapture {
  capture(
    input: Readonly<{
      readonly request: AnalysisTriggerRequest;
      readonly signal: AbortSignal;
    }>,
  ): Promise<CapturedCaseSnapshot>;
}

/**
 * The source command store deliberately owns only source lifecycle, immutable
 * configuration resolution, and command idempotency.  It does not expose
 * connector configuration or credentials to the application layer.
 */
export type KnowledgeSourceCommandKind = "synchronize" | "fullRescan";

export interface StoredKnowledgeSourceCommand {
  readonly requestDigest: Sha256Digest;
  readonly outboxEnvelopeId: import("@caseweaver/domain").OutboxEnvelopeId;
  readonly sourceConfigurationVersionId: string;
  readonly connectorConfigurationVersionId: string;
  readonly kind: KnowledgeSourceCommandKind;
}

export interface KnowledgeSourceCommandStore {
  lockIdempotencyKey(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly operation: "knowledgeSource.synchronize";
      readonly keyDigest: Sha256Digest;
    },
  ): Promise<void>;
  findIdempotency(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly operation: "knowledgeSource.synchronize";
      readonly keyDigest: Sha256Digest;
    },
  ): Promise<StoredKnowledgeSourceCommand | undefined>;
  recordIdempotency(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly operation: "knowledgeSource.synchronize";
      readonly keyDigest: Sha256Digest;
      readonly requestDigest: Sha256Digest;
      readonly outboxEnvelopeId: import("@caseweaver/domain").OutboxEnvelopeId;
      readonly sourceConfigurationVersionId: string;
      readonly connectorConfigurationVersionId: string;
      readonly kind: KnowledgeSourceCommandKind;
      readonly occurredAt: UtcInstant;
    },
  ): Promise<void>;
  findSource(
    transaction: ApplicationTransaction,
    input: { readonly workspaceId: WorkspaceId; readonly sourceId: string },
  ): Promise<
    | Readonly<{
        readonly id: string;
        readonly lifecycle: "enabled" | "disabled";
        readonly sourceConfigurationVersionId: string;
        readonly connectorConfigurationVersionId: string;
      }>
    | undefined
  >;
  /**
   * Atomically reserves a manual full-rescan slot.  Scheduled rescans never
   * use this reservation and are governed by their schedule occurrence key.
   */
  reserveManualFullRescan(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: WorkspaceId;
      readonly sourceId: string;
      readonly occurredAt: UtcInstant;
      readonly cooldownMs: number;
    },
  ): Promise<boolean>;
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
  /** Immutable connector-instance configuration selected by this profile version. */
  readonly destinationConnectorConfigurationVersionId: string;
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

/**
 * Immutable, deployment-neutral identity for a retained object.
 *
 * A storage key is meaningful only together with the workspace and the
 * backend that created it. Callers must never infer a backend from current
 * runtime configuration when processing historical work.
 */
export interface RetentionObjectReference {
  readonly workspaceId: WorkspaceId;
  readonly storageBackendId: string;
  readonly key: string;
}

export interface RetentionWorkItem {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  /**
   * Canonical deletion target. It is optional temporarily so adapters can
   * read historical work during the backend-aware attachment migration.
   */
  readonly objectReference?: RetentionObjectReference;
  /**
   * Historical persistence shape retained only for adapter compatibility.
   * Application code must not send it to object storage or choose a backend
   * for it. Migrations must either populate `objectReference` or block it.
   */
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
