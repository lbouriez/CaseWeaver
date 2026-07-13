import {
  type AnalysisJob,
  type AnalysisProfileVersionId,
  analysisIdentityId,
  analysisJobId,
  auditEventId,
  type CaseSnapshotId,
  causationId,
  createEnvelope,
  IdempotencyConflictError,
  outboxEnvelopeId,
  type Sha256Digest,
  transitionAnalysisJob,
  workspaceId,
} from "@caseweaver/domain";
import type { Permission } from "@caseweaver/security";

import type {
  AnalysisRequestStore,
  AuditStore,
  AuthorizationGuard,
  BootstrapAuthorization,
  BootstrapWorkspaceStore,
  Clock,
  DurableMessageQueue,
  ExecutionContext,
  IdGenerator,
  OutboxStore,
  UnitOfWork,
} from "./ports.js";

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("The operation was aborted.");
  }
}

function requirePermission(
  authorization: AuthorizationGuard,
  context: ExecutionContext,
  permission: Permission,
): Promise<void> {
  throwIfAborted(context.signal);
  return authorization.require(context, permission);
}

export interface BootstrapWorkspaceResult {
  readonly workspaceId: ReturnType<typeof workspaceId>;
  readonly principalId: ExecutionContext["principalId"];
  readonly created: boolean;
}

export class BootstrapWorkspace {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: BootstrapWorkspaceStore,
    private readonly authorization: BootstrapAuthorization,
    private readonly audit: AuditStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(): Promise<BootstrapWorkspaceResult> {
    return this.unitOfWork.transaction(async (transaction) => {
      const installed = await this.store.lockInstallation(transaction);
      if (installed !== undefined) {
        return { ...installed, created: false };
      }

      const administrator =
        await this.authorization.resolveInitialAdministrator();
      const occurredAt = this.clock.now();
      const newWorkspaceId = workspaceId(this.ids.next("workspace"));
      await this.store.createWorkspace(transaction, newWorkspaceId, occurredAt);
      await this.store.createPrincipal(transaction, {
        workspaceId: newWorkspaceId,
        principalId: administrator.principalId,
        occurredAt,
      });
      await this.store.assignWorkspaceRole(transaction, {
        workspaceId: newWorkspaceId,
        principalId: administrator.principalId,
        role: "administrator",
        occurredAt,
      });
      await this.audit.append(transaction, {
        id: auditEventId(this.ids.next("auditEvent")),
        workspaceId: newWorkspaceId,
        actorPrincipalId: administrator.principalId,
        action: "workspace.bootstrap",
        occurredAt,
      });
      await this.store.completeInstallation(
        transaction,
        { workspaceId: newWorkspaceId, principalId: administrator.principalId },
        occurredAt,
      );

      return {
        workspaceId: newWorkspaceId,
        principalId: administrator.principalId,
        created: true,
      };
    });
  }
}

export interface RequestAnalysisCommand {
  readonly idempotencyKeyDigest: Sha256Digest;
  readonly requestDigest: Sha256Digest;
  readonly identityHash: Sha256Digest;
  readonly analysisProfileVersionId: AnalysisProfileVersionId;
  readonly caseSnapshotId: CaseSnapshotId;
}

export interface RequestAnalysisResult {
  readonly analysisJobId: ReturnType<typeof analysisJobId>;
  readonly analysisIdentityId: ReturnType<typeof analysisIdentityId>;
  readonly replayed: boolean;
}

export class RequestAnalysis {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: AnalysisRequestStore,
    private readonly outbox: OutboxStore,
    private readonly audit: AuditStore,
    private readonly authorization: AuthorizationGuard,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(
    command: RequestAnalysisCommand,
    context: ExecutionContext,
  ): Promise<RequestAnalysisResult> {
    await requirePermission(this.authorization, context, "analysis.request");
    throwIfAborted(context.signal);

    return this.unitOfWork.transaction(async (transaction) => {
      const idempotency = {
        workspaceId: context.workspaceId,
        operation: "analysis.request" as const,
        keyDigest: command.idempotencyKeyDigest,
      };
      await this.store.lockIdempotencyKey(transaction, idempotency);
      const prior = await this.store.findIdempotency(transaction, idempotency);
      if (prior !== undefined) {
        if (prior.requestDigest !== command.requestDigest) {
          throw new IdempotencyConflictError("analysis.request");
        }
        const job = await this.store.findJob(transaction, {
          workspaceId: context.workspaceId,
          analysisJobId: prior.resourceId,
        });
        if (job === undefined) {
          throw new Error("Stored idempotency resource is missing.");
        }
        return {
          analysisJobId: job.id,
          analysisIdentityId: job.analysisIdentityId,
          replayed: true,
        };
      }

      const occurredAt = this.clock.now();
      const identity = await this.store.findOrCreateIdentity(transaction, {
        id: analysisIdentityId(this.ids.next("analysisIdentity")),
        workspaceId: context.workspaceId,
        identityHash: command.identityHash,
        analysisProfileVersionId: command.analysisProfileVersionId,
        caseSnapshotId: command.caseSnapshotId,
        occurredAt,
      });
      let job = await this.store.findJobByRunOrdinal(transaction, {
        workspaceId: context.workspaceId,
        analysisIdentityId: identity.id,
        runOrdinal: 0,
      });
      if (job === undefined) {
        job = {
          id: analysisJobId(this.ids.next("analysisJob")),
          workspaceId: context.workspaceId,
          analysisIdentityId: identity.id,
          runOrdinal: 0,
          state: "queued",
          createdAt: occurredAt,
          updatedAt: occurredAt,
        };
        await this.store.createJob(transaction, job);
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
            payload: {
              analysisJobId: job.id,
              analysisIdentityId: identity.id,
            },
          }),
        );
        await this.audit.append(transaction, {
          id: auditEventId(this.ids.next("auditEvent")),
          workspaceId: context.workspaceId,
          actorPrincipalId: context.principalId,
          action: "analysis.requested",
          targetId: job.id,
          afterHash: command.requestDigest,
          occurredAt,
        });
      }
      await this.store.recordIdempotency(transaction, {
        ...idempotency,
        requestDigest: command.requestDigest,
        resourceId: job.id,
        occurredAt,
      });

      return {
        analysisJobId: job.id,
        analysisIdentityId: identity.id,
        replayed: false,
      };
    });
  }
}

export interface ForceRerunAnalysisCommand {
  readonly analysisIdentityId: ReturnType<typeof analysisIdentityId>;
}

export class ForceRerunAnalysis {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: AnalysisRequestStore,
    private readonly outbox: OutboxStore,
    private readonly audit: AuditStore,
    private readonly authorization: AuthorizationGuard,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(
    command: ForceRerunAnalysisCommand,
    context: ExecutionContext,
  ): Promise<AnalysisJob> {
    await requirePermission(this.authorization, context, "analysis.forceRerun");
    throwIfAborted(context.signal);

    return this.unitOfWork.transaction(async (transaction) => {
      const { identity, nextRunOrdinal } =
        await this.store.lockIdentityForRerun(transaction, {
          workspaceId: context.workspaceId,
          analysisIdentityId: command.analysisIdentityId,
        });
      const occurredAt = this.clock.now();
      const job: AnalysisJob = {
        id: analysisJobId(this.ids.next("analysisJob")),
        workspaceId: context.workspaceId,
        analysisIdentityId: identity.id,
        runOrdinal: nextRunOrdinal,
        state: "queued",
        createdAt: occurredAt,
        updatedAt: occurredAt,
      };
      await this.store.createJob(transaction, job);
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
          payload: {
            analysisJobId: job.id,
            analysisIdentityId: identity.id,
          },
        }),
      );
      await this.audit.append(transaction, {
        id: auditEventId(this.ids.next("auditEvent")),
        workspaceId: context.workspaceId,
        actorPrincipalId: context.principalId,
        action: "analysis.forceRerun",
        targetId: job.id,
        occurredAt,
      });
      return job;
    });
  }
}

export interface CancelAnalysisJobCommand {
  readonly analysisJobId: ReturnType<typeof analysisJobId>;
}

export class CancelAnalysisJob {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: AnalysisRequestStore,
    private readonly audit: AuditStore,
    private readonly authorization: AuthorizationGuard,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(
    command: CancelAnalysisJobCommand,
    context: ExecutionContext,
  ): Promise<{ readonly cancelled: boolean }> {
    await requirePermission(this.authorization, context, "analysis.cancel");
    throwIfAborted(context.signal);

    return this.unitOfWork.transaction(async (transaction) => {
      const job = await this.store.findJob(transaction, {
        workspaceId: context.workspaceId,
        analysisJobId: command.analysisJobId,
      });
      if (
        job === undefined ||
        (job.state !== "queued" && job.state !== "running")
      ) {
        return { cancelled: false };
      }

      const occurredAt = this.clock.now();
      const cancelled = transitionAnalysisJob(job, "cancelled", occurredAt);
      await this.store.updateJobState(transaction, cancelled);
      await this.audit.append(transaction, {
        id: auditEventId(this.ids.next("auditEvent")),
        workspaceId: context.workspaceId,
        actorPrincipalId: context.principalId,
        action: "analysis.job.cancelled",
        targetId: cancelled.id,
        occurredAt,
      });
      return { cancelled: true };
    });
  }
}

export class OutboxRelay {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly outbox: OutboxStore,
    private readonly queue: DurableMessageQueue,
    private readonly clock: Clock,
    private readonly leaseMs = 30_000,
  ) {}

  public async runOnce(limit = 25): Promise<{ readonly delivered: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Outbox relay limit must be between 1 and 100.");
    }
    const claimed = await this.unitOfWork.transaction((transaction) =>
      this.outbox.claim(transaction, {
        limit,
        leaseMs: this.leaseMs,
        now: this.clock.now(),
      }),
    );

    let delivered = 0;
    for (const claim of claimed) {
      await this.queue.publish(claim.envelope);
      await this.unitOfWork.transaction((transaction) =>
        this.outbox.acknowledge(transaction, claim, this.clock.now()),
      );
      delivered += 1;
    }
    return { delivered };
  }
}
