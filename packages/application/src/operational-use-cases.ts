import {
  analysisJobId,
  auditEventId,
  causationId,
  createEnvelope,
  type EnvelopeFor,
  IdempotencyConflictError,
  outboxEnvelopeId,
  type Sha256Digest,
  caseSnapshotId as toCaseSnapshotId,
} from "@caseweaver/domain";

import type {
  AuditStore,
  AuthorizationGuard,
  Clock,
  CostAttributionQuery,
  ExecutionContext,
  IdGenerator,
  OperationsStore,
  OutboxStore,
  ResourceLeaseStore,
  RetentionObjectReference,
  UnitOfWork,
} from "./ports.js";

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("The operation was aborted.");
  }
}

async function requirePermission(
  authorization: AuthorizationGuard,
  context: ExecutionContext,
  permission: Parameters<AuthorizationGuard["require"]>[1],
): Promise<void> {
  throwIfAborted(context.signal);
  await authorization.require(context, permission);
}

function assertDigestMatches(
  existing: { readonly requestDigest: Sha256Digest },
  requestDigest: Sha256Digest,
): void {
  if (existing.requestDigest !== requestDigest) {
    throw new IdempotencyConflictError("operational.action");
  }
}

export interface OperationalMutation {
  readonly idempotencyKeyDigest: Sha256Digest;
  readonly requestDigest: Sha256Digest;
}

export class InspectDeadLetters {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: OperationsStore,
    private readonly authorization: AuthorizationGuard,
  ) {}

  public async execute(limit: number, context: ExecutionContext) {
    await requirePermission(this.authorization, context, "operations.inspect");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError(
        "Dead-letter inspection limit must be between 1 and 100.",
      );
    }
    return this.unitOfWork.transaction((transaction) =>
      this.store.inspectDeadLetters(transaction, {
        workspaceId: context.workspaceId,
        limit,
      }),
    );
  }
}

export class RetryDeadLetter {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: OperationsStore,
    private readonly outbox: OutboxStore,
    private readonly audit: AuditStore,
    private readonly authorization: AuthorizationGuard,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(
    failedJobId: ReturnType<typeof analysisJobId>,
    mutation: OperationalMutation,
    context: ExecutionContext,
  ): Promise<{ readonly analysisJobId?: string; readonly replayed: boolean }> {
    await requirePermission(this.authorization, context, "operations.retry");
    return this.unitOfWork.transaction(async (transaction) => {
      const idempotency = {
        workspaceId: context.workspaceId,
        action: "operations.retry" as const,
        keyDigest: mutation.idempotencyKeyDigest,
      };
      await this.store.lockAction(transaction, idempotency);
      const prior = await this.store.findAction(transaction, idempotency);
      if (prior !== undefined) {
        assertDigestMatches(prior, mutation.requestDigest);
        return { analysisJobId: prior.resourceId, replayed: true };
      }
      const occurredAt = this.clock.now();
      const replacement = await this.store.retryDeadLetter(transaction, {
        workspaceId: context.workspaceId,
        failedJobId,
        replacementJobId: analysisJobId(this.ids.next("analysisJob")),
        occurredAt,
      });
      if (replacement !== undefined) {
        await this.outbox.append(
          transaction,
          createEnvelope({
            id: outboxEnvelopeId(this.ids.next("outboxEnvelope")),
            kind: "command",
            type: "analysis.execute.v1",
            schemaVersion: 1,
            workspaceId: context.workspaceId,
            occurredAt,
            correlationId: context.correlationId,
            causationId: causationId(context.requestId),
            ...(context.traceContext === undefined
              ? {}
              : { traceContext: context.traceContext }),
            payload: {
              analysisJobId: replacement.id,
              analysisIdentityId: replacement.analysisIdentityId,
            },
          }),
        );
      }
      await this.store.recordAction(transaction, {
        ...idempotency,
        requestDigest: mutation.requestDigest,
        resourceId: replacement?.id ?? failedJobId,
        occurredAt,
      });
      await this.audit.append(transaction, {
        id: auditEventId(this.ids.next("auditEvent")),
        workspaceId: context.workspaceId,
        actorPrincipalId: context.principalId,
        action: "operations.deadLetter.retry",
        targetId: failedJobId,
        afterHash: mutation.requestDigest,
        occurredAt,
      });
      return { analysisJobId: replacement?.id, replayed: false };
    });
  }
}

export class CancelOperationalJob {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: OperationsStore,
    private readonly audit: AuditStore,
    private readonly authorization: AuthorizationGuard,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(
    jobId: ReturnType<typeof analysisJobId>,
    mutation: OperationalMutation,
    context: ExecutionContext,
  ): Promise<{ readonly cancelled: boolean; readonly replayed: boolean }> {
    await requirePermission(this.authorization, context, "analysis.cancel");
    return this.unitOfWork.transaction(async (transaction) => {
      const idempotency = {
        workspaceId: context.workspaceId,
        action: "operations.cancel" as const,
        keyDigest: mutation.idempotencyKeyDigest,
      };
      await this.store.lockAction(transaction, idempotency);
      const prior = await this.store.findAction(transaction, idempotency);
      if (prior !== undefined) {
        assertDigestMatches(prior, mutation.requestDigest);
        return { cancelled: prior.resourceId === jobId, replayed: true };
      }
      const occurredAt = this.clock.now();
      const cancelled = await this.store.cancelJob(transaction, {
        workspaceId: context.workspaceId,
        analysisJobId: jobId,
        occurredAt,
      });
      await this.store.recordAction(transaction, {
        ...idempotency,
        requestDigest: mutation.requestDigest,
        resourceId: cancelled?.id ?? "",
        occurredAt,
      });
      if (cancelled !== undefined) {
        await this.audit.append(transaction, {
          id: auditEventId(this.ids.next("auditEvent")),
          workspaceId: context.workspaceId,
          actorPrincipalId: context.principalId,
          action: "operations.job.cancelled",
          targetId: jobId,
          afterHash: mutation.requestDigest,
          occurredAt,
        });
      }
      return { cancelled: cancelled !== undefined, replayed: false };
    });
  }
}

export class RecoverExpiredJob {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: OperationsStore,
    private readonly leases: ResourceLeaseStore,
    private readonly outbox: OutboxStore,
    private readonly audit: AuditStore,
    private readonly authorization: AuthorizationGuard,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(
    jobId: ReturnType<typeof analysisJobId>,
    mutation: OperationalMutation,
    context: ExecutionContext,
  ): Promise<{ readonly recovered: boolean; readonly replayed: boolean }> {
    await requirePermission(this.authorization, context, "operations.recover");
    return this.unitOfWork.transaction(async (transaction) => {
      const idempotency = {
        workspaceId: context.workspaceId,
        action: "operations.recover" as const,
        keyDigest: mutation.idempotencyKeyDigest,
      };
      await this.store.lockAction(transaction, idempotency);
      const prior = await this.store.findAction(transaction, idempotency);
      if (prior !== undefined) {
        assertDigestMatches(prior, mutation.requestDigest);
        return { recovered: prior.resourceId === jobId, replayed: true };
      }
      const occurredAt = this.clock.now();
      const lease = await this.leases.acquire(transaction, {
        workspaceId: context.workspaceId,
        resourceType: "analysis-recovery",
        resourceKey: jobId,
        leaseMs: 60_000,
      });
      const recovered =
        lease === undefined
          ? undefined
          : await this.store.recoverExpiredJob(transaction, {
              workspaceId: context.workspaceId,
              analysisJobId: jobId,
              fencingToken: lease.fencingToken,
              occurredAt,
            });
      if (recovered !== undefined) {
        await this.outbox.append(
          transaction,
          createEnvelope({
            id: outboxEnvelopeId(this.ids.next("outboxEnvelope")),
            kind: "command",
            type: "analysis.execute.v1",
            schemaVersion: 1,
            workspaceId: context.workspaceId,
            occurredAt,
            correlationId: context.correlationId,
            causationId: causationId(context.requestId),
            ...(context.traceContext === undefined
              ? {}
              : { traceContext: context.traceContext }),
            payload: {
              analysisJobId: recovered.id,
              analysisIdentityId: recovered.analysisIdentityId,
            },
          }),
        );
      }
      await this.store.recordAction(transaction, {
        ...idempotency,
        requestDigest: mutation.requestDigest,
        resourceId: recovered?.id ?? "",
        occurredAt,
      });
      if (recovered !== undefined) {
        await this.audit.append(transaction, {
          id: auditEventId(this.ids.next("auditEvent")),
          workspaceId: context.workspaceId,
          actorPrincipalId: context.principalId,
          action: "operations.job.recovered",
          targetId: jobId,
          afterHash: mutation.requestDigest,
          occurredAt,
        });
      }
      return { recovered: recovered !== undefined, replayed: false };
    });
  }
}

export class QueryCostAttribution {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: OperationsStore,
    private readonly authorization: AuthorizationGuard,
  ) {}

  public async execute(query: CostAttributionQuery, context: ExecutionContext) {
    await requirePermission(this.authorization, context, "cost.read");
    if (
      !Number.isInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 1_000
    ) {
      throw new RangeError("Cost query limit must be between 1 and 1000.");
    }
    return this.unitOfWork.transaction((transaction) =>
      this.store.queryCostAttribution(transaction, {
        ...query,
        workspaceId: context.workspaceId,
      }),
    );
  }
}

export class PurgeCaseSnapshot {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: OperationsStore,
    private readonly outbox: OutboxStore,
    private readonly audit: AuditStore,
    private readonly authorization: AuthorizationGuard,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(
    caseSnapshotId: string,
    reason: string,
    mutation: OperationalMutation,
    context: ExecutionContext,
  ): Promise<{ readonly purged: boolean; readonly replayed: boolean }> {
    await requirePermission(this.authorization, context, "privacy.delete");
    if (reason.length < 1 || reason.length > 4_000) {
      throw new RangeError("Privacy purge reason is invalid.");
    }
    return this.unitOfWork.transaction(async (transaction) => {
      const idempotency = {
        workspaceId: context.workspaceId,
        action: "privacy.purge" as const,
        keyDigest: mutation.idempotencyKeyDigest,
      };
      await this.store.lockAction(transaction, idempotency);
      const prior = await this.store.findAction(transaction, idempotency);
      if (prior !== undefined) {
        assertDigestMatches(prior, mutation.requestDigest);
        return { purged: prior.resourceId === caseSnapshotId, replayed: true };
      }
      const occurredAt = this.clock.now();
      const result = await this.store.purgeCaseSnapshot(transaction, {
        workspaceId: context.workspaceId,
        caseSnapshotId: toCaseSnapshotId(caseSnapshotId),
        actorPrincipalId: context.principalId,
        reason,
        occurredAt,
      });
      for (const workItem of result.kind === "notFound"
        ? []
        : result.workItems) {
        await this.outbox.append(
          transaction,
          createEnvelope({
            id: outboxEnvelopeId(this.ids.next("outboxEnvelope")),
            kind: "command",
            type: "retention.purge.v1",
            schemaVersion: 1,
            workspaceId: context.workspaceId,
            occurredAt,
            correlationId: context.correlationId,
            causationId: causationId(context.requestId),
            ...(context.traceContext === undefined
              ? {}
              : { traceContext: context.traceContext }),
            payload: { workItemId: workItem.id },
          }),
        );
      }
      await this.store.recordAction(transaction, {
        ...idempotency,
        requestDigest: mutation.requestDigest,
        resourceId: result.kind === "notFound" ? "" : caseSnapshotId,
        occurredAt,
      });
      if (result.kind === "purged") {
        await this.audit.append(transaction, {
          id: auditEventId(this.ids.next("auditEvent")),
          workspaceId: context.workspaceId,
          actorPrincipalId: context.principalId,
          action: "privacy.caseSnapshot.purged",
          targetId: caseSnapshotId,
          afterHash: mutation.requestDigest,
          occurredAt,
        });
      }
      return { purged: result.kind !== "notFound", replayed: false };
    });
  }
}

export class QueueExpiredRetention {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: OperationsStore,
    private readonly outbox: OutboxStore,
    private readonly audit: AuditStore,
    private readonly authorization: AuthorizationGuard,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(
    mutation: OperationalMutation,
    context: ExecutionContext,
    limit = 100,
  ): Promise<{ readonly queued: number; readonly replayed: boolean }> {
    await requirePermission(this.authorization, context, "retention.run");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Retention limit must be between 1 and 1000.");
    }
    return this.unitOfWork.transaction(async (transaction) => {
      const idempotency = {
        workspaceId: context.workspaceId,
        action: "retention.reap" as const,
        keyDigest: mutation.idempotencyKeyDigest,
      };
      await this.store.lockAction(transaction, idempotency);
      const prior = await this.store.findAction(transaction, idempotency);
      if (prior !== undefined) {
        assertDigestMatches(prior, mutation.requestDigest);
        return { queued: 0, replayed: true };
      }
      const occurredAt = this.clock.now();
      await this.outbox.append(
        transaction,
        createEnvelope({
          id: outboxEnvelopeId(this.ids.next("outboxEnvelope")),
          kind: "command",
          type: "retention.reap.v1",
          schemaVersion: 1,
          workspaceId: context.workspaceId,
          occurredAt,
          correlationId: context.correlationId,
          causationId: causationId(context.requestId),
          ...(context.traceContext === undefined
            ? {}
            : { traceContext: context.traceContext }),
          payload: { reason: "operator", limit },
        }),
      );
      await this.store.recordAction(transaction, {
        ...idempotency,
        requestDigest: mutation.requestDigest,
        resourceId: `retention:${occurredAt}`,
        occurredAt,
      });
      await this.audit.append(transaction, {
        id: auditEventId(this.ids.next("auditEvent")),
        workspaceId: context.workspaceId,
        actorPrincipalId: context.principalId,
        action: "retention.reap.queued",
        afterHash: mutation.requestDigest,
        occurredAt,
      });
      return { queued: 1, replayed: false };
    });
  }
}

/**
 * The reaper is the producer of purge commands for expired retention work. It
 * finds durable expired work, then atomically writes one command and one audit
 * record for its batch. Object deletion happens only later, after a fenced
 * claim.
 */
export class ReapExpiredRetentionWork {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: OperationsStore,
    private readonly outbox: OutboxStore,
    private readonly audit: AuditStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly maximumBatch = 100,
  ) {
    if (
      !Number.isInteger(maximumBatch) ||
      maximumBatch < 1 ||
      maximumBatch > 1_000
    ) {
      throw new RangeError("Retention batch limit must be between 1 and 1000.");
    }
  }

  public async execute(
    command: EnvelopeFor<"retention.reap.v1">,
    signal: AbortSignal,
  ): Promise<{ readonly queued: number }> {
    throwIfAborted(signal);
    const limit = command.payload.limit ?? this.maximumBatch;
    return this.unitOfWork.transaction(async (transaction) => {
      const occurredAt = this.clock.now();
      const workItems = await this.store.queueExpiredRetention(transaction, {
        workspaceId: command.workspaceId,
        limit,
        occurredAt,
      });
      for (const workItem of workItems) {
        await this.outbox.append(
          transaction,
          createEnvelope({
            id: outboxEnvelopeId(this.ids.next("outboxEnvelope")),
            kind: "command",
            type: "retention.purge.v1",
            schemaVersion: 1,
            workspaceId: command.workspaceId,
            occurredAt,
            correlationId: command.correlationId,
            causationId: causationId(command.id),
            ...(command.traceContext === undefined
              ? {}
              : { traceContext: command.traceContext }),
            payload: { workItemId: workItem.id },
          }),
        );
      }
      await this.audit.append(transaction, {
        id: auditEventId(this.ids.next("auditEvent")),
        workspaceId: command.workspaceId,
        action: "retention.reap.processed",
        targetId: "retention",
        targetType: "retentionWork",
        outcome: "succeeded",
        origin: "worker",
        reasonCode: command.payload.reason,
        occurredAt,
      });
      return { queued: workItems.length };
    });
  }
}

export class RetentionObjectReferenceUnavailableError extends Error {
  public readonly code = "retention.objectReferenceUnavailable";
  public readonly retryable = false;

  public constructor() {
    super("Retention object reference is unavailable.");
    this.name = "RetentionObjectReferenceUnavailableError";
  }
}

function isNonEmptyBoundedString(
  value: unknown,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !value.includes("\0") &&
    !value.includes("\r") &&
    !value.includes("\n")
  );
}

/**
 * Reject malformed or incomplete identities without including storage data in
 * errors. Backend adapters additionally enforce backend and workspace scope.
 */
export function assertRetentionObjectReference(
  value: unknown,
): RetentionObjectReference {
  if (
    typeof value !== "object" ||
    value === null ||
    !isNonEmptyBoundedString(
      (value as { readonly workspaceId?: unknown }).workspaceId,
      200,
    ) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(
      (value as { readonly storageBackendId?: unknown })
        .storageBackendId as string,
    ) ||
    !isNonEmptyBoundedString((value as { readonly key?: unknown }).key, 2_048)
  ) {
    throw new RetentionObjectReferenceUnavailableError();
  }
  return Object.freeze({
    workspaceId: (value as RetentionObjectReference).workspaceId,
    storageBackendId: (value as RetentionObjectReference).storageBackendId,
    key: (value as RetentionObjectReference).key,
  });
}

export interface RetentionObjectStore {
  delete(
    objectReference: RetentionObjectReference,
    signal: AbortSignal,
  ): Promise<void>;
}

export class PurgeRetentionWorkItem {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: OperationsStore,
    private readonly objects: RetentionObjectStore,
    private readonly audit: AuditStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(
    workspaceId: ExecutionContext["workspaceId"],
    workItemId: string,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const claimed = await this.unitOfWork.transaction((transaction) =>
      this.store.claimRetentionWork(transaction, { workspaceId, workItemId }),
    );
    if (claimed === undefined) return;
    try {
      const objectReference = claimed.objectReference;
      if (objectReference === undefined && claimed.storageKey !== undefined) {
        throw new RetentionObjectReferenceUnavailableError();
      }
      if (objectReference !== undefined) {
        const validated = assertRetentionObjectReference(objectReference);
        if (
          validated.workspaceId !== workspaceId ||
          claimed.workspaceId !== workspaceId
        ) {
          throw new RetentionObjectReferenceUnavailableError();
        }
        await this.objects.delete(validated, signal);
      }
      await this.unitOfWork.transaction(async (transaction) => {
        const completed = await this.store.completeRetentionWork(transaction, {
          workspaceId,
          workItemId,
          fencingToken: claimed.fencingToken,
          occurredAt: this.clock.now(),
        });
        if (completed) {
          await this.audit.append(transaction, {
            id: auditEventId(this.ids.next("auditEvent")),
            workspaceId,
            action: "retention.work.completed",
            targetId: `retention:${workItemId}`,
            targetType: "retentionWork",
            outcome: "succeeded",
            origin: "worker",
            occurredAt: this.clock.now(),
          });
        }
      });
    } catch (error) {
      await this.unitOfWork.transaction((transaction) =>
        this.store.releaseRetentionWork(transaction, {
          workspaceId,
          workItemId,
          fencingToken: claimed.fencingToken,
          occurredAt: this.clock.now(),
        }),
      );
      throw error;
    }
  }
}
