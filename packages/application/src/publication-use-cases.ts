import { createHash } from "node:crypto";

import {
  type AnalysisJob,
  analysisIdentityId,
  analysisJobId,
  auditEventId,
  causationId,
  createEnvelope,
  type EnvelopeFor,
  IdempotencyConflictError,
  outboxEnvelopeId,
  type PublicationIntent,
  publicationIntentId,
  type Sha256Digest,
} from "@caseweaver/domain";

import type {
  AnalysisRequestStore,
  AuditStore,
  AuthorizationGuard,
  Clock,
  ExecutionContext,
  IdGenerator,
  OutboxStore,
  PublicationIntentStore,
  PublicationTarget,
  StoredPublicationProfile,
  UnitOfWork,
} from "./ports.js";
import type {
  RequestAnalysisCommand,
  RequestAnalysisResult,
} from "./use-cases.js";

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("The operation was aborted.");
  }
}

function initialPublicationState(
  profile: StoredPublicationProfile,
): PublicationIntent["state"] {
  switch (profile.policy.mode) {
    case "previewOnly":
      return "skipped";
    case "approvalRequired":
      return "awaitingApproval";
    case "autoPublishInternal":
      return "pending";
  }
}

function stableOutboxEnvelopeId(value: string) {
  const bytes = createHash("sha256").update(value, "utf8").digest();
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.subarray(0, 16).toString("hex");
  return outboxEnvelopeId(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
  );
}

function publicationEnvelope(
  intent: PublicationIntent,
  context: ExecutionContext,
  occurredAt: ReturnType<Clock["now"]>,
) {
  return createEnvelope({
    id: stableOutboxEnvelopeId(`publication-command:${intent.id}`),
    kind: "command",
    type: "publication.execute.v1",
    schemaVersion: 1,
    workspaceId: context.workspaceId,
    occurredAt,
    correlationId: context.correlationId,
    causationId: causationId(context.requestId),
    ...(context.traceContext === undefined
      ? {}
      : { traceContext: context.traceContext }),
    payload: { publicationIntentId: intent.id },
  });
}

export interface RequestAnalysisWithPublicationCommand
  extends RequestAnalysisCommand {
  readonly publication: {
    readonly profileId: string;
    readonly profileVersion: string;
    readonly target: PublicationTarget;
    readonly intentHash: Sha256Digest;
    /**
     * A preview is non-durable, so it cannot suppress a later approved write.
     */
    readonly dryRun: boolean;
  };
}

export interface RequestAnalysisWithPublicationResult
  extends RequestAnalysisResult {
  readonly publicationIntentId?: ReturnType<typeof publicationIntentId>;
  readonly preview: boolean;
}

/**
 * The publication intent is committed before a new analysis command is
 * committed to the outbox. Replayed analysis requests can create a distinct
 * profile/target intent, but they never create another analysis job.
 */
export class RequestAnalysisWithPublication {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly analyses: AnalysisRequestStore,
    private readonly publications: PublicationIntentStore,
    private readonly outbox: OutboxStore,
    private readonly audit: AuditStore,
    private readonly authorization: AuthorizationGuard,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(
    command: RequestAnalysisWithPublicationCommand,
    context: ExecutionContext,
  ): Promise<RequestAnalysisWithPublicationResult> {
    throwIfAborted(context.signal);
    await this.authorization.require(context, "analysis.request");
    await this.authorization.require(context, "publication.publish");
    throwIfAborted(context.signal);

    return this.unitOfWork.transaction(async (transaction) => {
      const idempotency = {
        workspaceId: context.workspaceId,
        operation: "analysis.request" as const,
        keyDigest: command.idempotencyKeyDigest,
      };
      await this.analyses.lockIdempotencyKey(transaction, idempotency);
      const previous = await this.analyses.findIdempotency(
        transaction,
        idempotency,
      );

      let job: AnalysisJob;
      let replayed = false;
      let createdJob = false;
      if (previous !== undefined) {
        if (previous.requestDigest !== command.requestDigest) {
          throw new IdempotencyConflictError("analysis.request");
        }
        const found = await this.analyses.findJob(transaction, {
          workspaceId: context.workspaceId,
          analysisJobId: previous.resourceId,
        });
        if (found === undefined) {
          throw new Error("Stored idempotency resource is missing.");
        }
        job = found;
        replayed = true;
      } else {
        const occurredAt = this.clock.now();
        const identity = await this.analyses.findOrCreateIdentity(transaction, {
          id: analysisIdentityId(this.ids.next("analysisIdentity")),
          workspaceId: context.workspaceId,
          identityHash: command.identityHash,
          analysisProfileVersionId: command.analysisProfileVersionId,
          caseSnapshotId: command.caseSnapshotId,
          occurredAt,
        });
        const existing = await this.analyses.findJobByRunOrdinal(transaction, {
          workspaceId: context.workspaceId,
          analysisIdentityId: identity.id,
          runOrdinal: 0,
        });
        if (existing !== undefined) {
          job = existing;
        } else {
          job = {
            id: analysisJobId(this.ids.next("analysisJob")),
            workspaceId: context.workspaceId,
            analysisIdentityId: identity.id,
            runOrdinal: 0,
            state: "queued",
            createdAt: occurredAt,
            updatedAt: occurredAt,
          };
          await this.analyses.createJob(transaction, job);
          createdJob = true;
        }
        await this.analyses.recordIdempotency(transaction, {
          ...idempotency,
          requestDigest: command.requestDigest,
          resourceId: job.id,
          occurredAt,
        });
      }

      const occurredAt = this.clock.now();
      let intent: PublicationIntent | undefined;
      if (!command.publication.dryRun) {
        const profile = await this.publications.findProfile(transaction, {
          workspaceId: context.workspaceId,
          profileId: command.publication.profileId,
          profileVersion: command.publication.profileVersion,
        });
        if (profile === undefined) {
          throw new Error("Publication profile was not found.");
        }
        intent = await this.publications.createOrFindIntent(transaction, {
          id: publicationIntentId(this.ids.next("publicationIntent")),
          workspaceId: context.workspaceId,
          analysisJobId: job.id,
          profile,
          target: command.publication.target,
          intentHash: command.publication.intentHash,
          state: initialPublicationState(profile),
          occurredAt,
        });
      }

      if (createdJob) {
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
              analysisJobId: job.id,
              analysisIdentityId: job.analysisIdentityId,
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
      if (
        intent !== undefined &&
        job.state === "completed" &&
        intent.state === "pending"
      ) {
        await this.publications.enqueuePublication(
          transaction,
          publicationEnvelope(intent, context, occurredAt),
        );
      }
      return {
        analysisJobId: job.id,
        analysisIdentityId: job.analysisIdentityId,
        replayed,
        ...(intent === undefined ? {} : { publicationIntentId: intent.id }),
        preview: command.publication.dryRun,
      };
    });
  }
}

export class ApprovePublication {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly publications: PublicationIntentStore,
    private readonly audit: AuditStore,
    private readonly authorization: AuthorizationGuard,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(
    intentId: ReturnType<typeof publicationIntentId>,
    context: ExecutionContext,
  ): Promise<{ readonly approved: boolean; readonly replayed: boolean }> {
    throwIfAborted(context.signal);
    await this.authorization.require(context, "publication.approve");
    return this.unitOfWork.transaction(async (transaction) => {
      const occurredAt = this.clock.now();
      const approval = await this.publications.approveIntent(transaction, {
        workspaceId: context.workspaceId,
        publicationIntentId: intentId,
        actorPrincipalId: context.principalId,
        occurredAt,
      });
      if (approval.outcome === "notApprovable") {
        return { approved: false, replayed: false };
      }
      if (approval.outcome === "alreadyApproved") {
        return { approved: true, replayed: true };
      }
      if (approval.intent.analysisJobId === undefined) {
        throw new Error(
          "An approvable publication intent must reference an analysis job.",
        );
      }

      const readyIntentIds = await this.publications.findReadyIntentIds(
        transaction,
        {
          workspaceId: context.workspaceId,
          analysisJobId: approval.intent.analysisJobId,
        },
      );
      if (readyIntentIds.includes(approval.intent.id)) {
        await this.publications.enqueuePublication(
          transaction,
          publicationEnvelope(approval.intent, context, occurredAt),
        );
      }
      await this.audit.append(transaction, {
        id: auditEventId(this.ids.next("auditEvent")),
        workspaceId: context.workspaceId,
        actorPrincipalId: context.principalId,
        action: "publication.approved",
        targetId: approval.intent.id,
        occurredAt,
      });
      return { approved: true, replayed: false };
    });
  }
}

export class SchedulePublicationForCompletedAnalysis {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly publications: PublicationIntentStore,
    private readonly clock: Clock,
  ) {}

  public async execute(
    event: EnvelopeFor<"analysis.completed.v1">,
  ): Promise<{ readonly scheduled: number }> {
    return this.unitOfWork.transaction(async (transaction) => {
      await this.publications.bindAnalysisResult(transaction, {
        workspaceId: event.workspaceId,
        analysisJobId: event.payload.analysisJobId,
        analysisResultId: event.payload.analysisResultId,
      });
      const intentIds = await this.publications.findReadyIntentIds(
        transaction,
        {
          workspaceId: event.workspaceId,
          analysisJobId: event.payload.analysisJobId,
        },
      );
      const occurredAt = this.clock.now();
      let scheduled = 0;
      for (const intentId of intentIds) {
        const intent = await this.publications.findIntent(transaction, {
          workspaceId: event.workspaceId,
          publicationIntentId: intentId,
        });
        if (intent === undefined || intent.state !== "pending") continue;
        await this.publications.enqueuePublication(
          transaction,
          createEnvelope({
            id: stableOutboxEnvelopeId(`publication-command:${intent.id}`),
            kind: "command",
            type: "publication.execute.v1",
            schemaVersion: 1,
            workspaceId: event.workspaceId,
            occurredAt,
            correlationId: event.correlationId,
            causationId: causationId(event.id),
            ...(event.traceContext === undefined
              ? {}
              : { traceContext: event.traceContext }),
            payload: { publicationIntentId: intent.id },
          }),
        );
        scheduled += 1;
      }
      return { scheduled };
    });
  }
}
