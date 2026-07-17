import {
  type AnalysisProfileVersionId,
  type AnalysisTriggerId,
  type AnalysisTriggerRequestId,
  type AnalysisTriggerVersionId,
  analysisTriggerRequestId,
  auditEventId,
  type CaseSnapshotId,
  causationId,
  createEnvelope,
  type EnvelopeFor,
  IdempotencyConflictError,
  outboxEnvelopeId,
  requestId,
  type Sha256Digest,
} from "@caseweaver/domain";

import type {
  AnalysisTriggerRequest,
  AnalysisTriggerRequestStore,
  AnalysisTriggerSource,
  AnalysisTriggerTarget,
  AuditStore,
  AuthorizationGuard,
  Clock,
  ExecutionContext,
  IdGenerator,
  OutboxStore,
  TriggeredCaseSnapshotCapture,
  UnitOfWork,
} from "./ports.js";
import {
  type AnalysisRequestTransactionDependencies,
  type RequestAnalysisResult,
  requestAnalysisInTransaction,
} from "./use-cases.js";

export class AnalysisTriggerInvocationError extends Error {
  public constructor(
    public readonly code:
      | "analysis.trigger.legacyUnavailable"
      | "analysis.trigger.configurationUnavailable"
      | "analysis.trigger.captureUnavailable",
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AnalysisTriggerInvocationError";
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("The operation was aborted.");
  }
}

function captureError(error: unknown): {
  readonly code: string;
  readonly retryable: boolean;
} {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "retryable" in error &&
    typeof error.code === "string" &&
    typeof error.retryable === "boolean"
  ) {
    return { code: error.code, retryable: error.retryable };
  }
  return { code: "analysis.trigger.captureFailed", retryable: true };
}

export interface RequestAnalysisTriggerCommand {
  readonly triggerId: AnalysisTriggerId;
  /** Trusted automated ingress pins an immutable version before enqueueing work. */
  readonly expectedTriggerVersionId?: AnalysisTriggerVersionId;
  readonly source: AnalysisTriggerSource;
  readonly occurrenceKey?: string;
  readonly target: AnalysisTriggerTarget;
  readonly idempotencyKeyDigest: Sha256Digest;
  readonly requestDigest: Sha256Digest;
}

export interface RequestAnalysisTriggerResult {
  readonly requestId: AnalysisTriggerRequestId;
  readonly replayed: boolean;
}

/**
 * Optional outer preparation seam for a trigger that has a retained
 * repository-analysis recipe. It runs only after the case snapshot is durable
 * and before the existing PBI-011 request transaction derives its immutable
 * identity. The implementation is responsible for its own fenced durable
 * state; this application package never receives checkout material, connector
 * settings, attachment bytes, or provider clients.
 */
export interface AnalysisTriggerSubmissionPreparation {
  prepare(
    command: EnvelopeFor<"analysis.trigger.v2">,
    signal: AbortSignal,
  ): Promise<void>;
}

/**
 * Creates the durable, immutable trigger request and its v2 command in one
 * transaction. The caller supplies only a trigger id and opaque case target;
 * the store owns active-version, profile, and connector-configuration lookup.
 */
export class RequestAnalysisTrigger {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: AnalysisTriggerRequestStore,
    private readonly outbox: OutboxStore,
    private readonly audit: AuditStore,
    private readonly authorization: AuthorizationGuard,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(
    command: RequestAnalysisTriggerCommand,
    context: ExecutionContext,
  ): Promise<RequestAnalysisTriggerResult> {
    throwIfAborted(context.signal);
    await this.authorization.require(context, "analysis.request");
    throwIfAborted(context.signal);

    return this.unitOfWork.transaction(async (transaction) => {
      const occurredAt = this.clock.now();
      const created = await this.store.createOrFind(transaction, {
        id: analysisTriggerRequestId(this.ids.next("analysisTriggerRequest")),
        workspaceId: context.workspaceId,
        actorPrincipalId: context.principalId,
        triggerId: command.triggerId,
        ...(command.expectedTriggerVersionId === undefined
          ? {}
          : { expectedTriggerVersionId: command.expectedTriggerVersionId }),
        source: command.source,
        ...(command.occurrenceKey === undefined
          ? {}
          : { occurrenceKey: command.occurrenceKey }),
        target: command.target,
        idempotencyKeyDigest: command.idempotencyKeyDigest,
        requestDigest: command.requestDigest,
        occurredAt,
      });
      if (created.kind === "replayed") {
        if (created.request.requestDigest !== command.requestDigest) {
          throw new IdempotencyConflictError("analysis.trigger");
        }
        return { requestId: created.request.id, replayed: true };
      }

      const envelope = createEnvelope({
        id: outboxEnvelopeId(this.ids.next("outboxEnvelope")),
        kind: "command",
        type: "analysis.trigger.v2",
        schemaVersion: 1,
        workspaceId: context.workspaceId,
        occurredAt,
        correlationId: context.correlationId,
        causationId: causationId(context.requestId),
        ...(context.traceContext === undefined
          ? {}
          : { traceContext: context.traceContext }),
        payload: {
          triggerRequestId: created.request.id,
          triggerId: created.request.triggerId,
          triggerVersionId: created.request.triggerVersionId,
          connectorRegistrationId: created.request.connectorRegistrationId,
          connectorConfigurationVersionId:
            created.request.connectorConfigurationVersionId,
          source: created.request.source,
          ...(created.request.occurrenceKey === undefined
            ? {}
            : { occurrenceKey: created.request.occurrenceKey }),
          target: created.request.target,
        },
      });
      await this.outbox.append(transaction, envelope);
      await this.audit.append(transaction, {
        id: auditEventId(this.ids.next("auditEvent")),
        workspaceId: context.workspaceId,
        actorPrincipalId: context.principalId,
        action: "analysis.trigger.requested",
        targetId: created.request.id,
        afterHash: created.request.requestDigest,
        occurredAt,
      });
      return { requestId: created.request.id, replayed: false };
    });
  }
}

/**
 * The feature-owned capture step is intentionally not a worker registration.
 * Later trusted composition supplies the server-private CaseSource-backed
 * capturer; this use case owns the lease/fence protocol and immutable snapshot
 * persistence only.
 */
export class CaptureAnalysisTriggerCase {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: AnalysisTriggerRequestStore,
    private readonly capture: TriggeredCaseSnapshotCapture,
    private readonly clock: Clock,
    private readonly leaseMs = 60_000,
  ) {
    if (!Number.isInteger(leaseMs) || leaseMs < 1) {
      throw new RangeError("Analysis trigger capture lease must be positive.");
    }
  }

  public async execute(
    command:
      | EnvelopeFor<"analysis.trigger.v1">
      | EnvelopeFor<"analysis.trigger.v2">,
    signal: AbortSignal,
  ): Promise<
    | CapturedAnalysisTriggerCaseResult
    | Readonly<{ readonly kind: "alreadyCapturing" }>
    | Readonly<{ readonly kind: "notFound" }>
  > {
    throwIfAborted(signal);
    if (command.type === "analysis.trigger.v1") {
      throw new AnalysisTriggerInvocationError(
        "analysis.trigger.legacyUnavailable",
        "Legacy analysis trigger commands have no immutable configuration.",
        false,
      );
    }
    const claimed = await this.unitOfWork.transaction((transaction) =>
      this.store.claimCapture(transaction, {
        command,
        leaseMs: this.leaseMs,
      }),
    );
    switch (claimed.kind) {
      case "captured":
        return capturedResult(
          "alreadyCaptured",
          claimed.caseSnapshotId,
          claimed.request,
        );
      case "alreadyCapturing":
        return { kind: "alreadyCapturing" };
      case "notFound":
        return { kind: "notFound" };
      case "unavailable":
        throw new AnalysisTriggerInvocationError(
          "analysis.trigger.configurationUnavailable",
          "Analysis trigger configuration is unavailable.",
          false,
        );
      case "claimed":
        break;
    }

    try {
      throwIfAborted(signal);
      const snapshot = await this.capture.capture({
        request: claimed.claim.request,
        signal,
      });
      throwIfAborted(signal);
      const caseSnapshotId = await this.unitOfWork.transaction((transaction) =>
        this.store.persistCapture(transaction, {
          claim: claimed.claim,
          snapshot,
        }),
      );
      return capturedResult("captured", caseSnapshotId, claimed.claim.request);
    } catch (error) {
      await this.unitOfWork.transaction((transaction) =>
        this.store.failCapture(transaction, {
          claim: claimed.claim,
          error: captureError(error),
          occurredAt: this.clock.now(),
        }),
      );
      throw error;
    }
  }
}

/**
 * Reuses the PBI-011 analysis-request transaction after case capture. The
 * durable trigger store supplies the exact immutable profile/snapshot hashes;
 * this use case neither loads connector data nor duplicates analysis identity,
 * idempotency, outbox, or audit policy.
 */
export class SubmitCapturedAnalysisTrigger {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly triggers: AnalysisTriggerRequestStore,
    private readonly analyses: AnalysisRequestTransactionDependencies,
    private readonly preparation?: AnalysisTriggerSubmissionPreparation,
  ) {}

  public async execute(
    command: EnvelopeFor<"analysis.trigger.v2">,
    signal: AbortSignal,
  ): Promise<
    | RequestAnalysisResult
    | Readonly<{
        readonly kind: "notCaptured" | "notFound" | "submitted";
        readonly analysisJobId?: import("@caseweaver/domain").AnalysisJobId;
      }>
  > {
    throwIfAborted(signal);
    await this.preparation?.prepare(command, signal);
    throwIfAborted(signal);
    return this.unitOfWork.transaction(async (transaction) => {
      const prepared = await this.triggers.prepareAnalysisSubmission(
        transaction,
        { command },
      );
      switch (prepared.kind) {
        case "notFound":
        case "notCaptured":
          return { kind: prepared.kind };
        case "unavailable":
          throw new AnalysisTriggerInvocationError(
            "analysis.trigger.configurationUnavailable",
            "Analysis trigger configuration is unavailable.",
            false,
          );
        case "submitted":
          return {
            kind: "submitted",
            analysisJobId: prepared.analysisJobId,
          };
        case "ready":
          break;
      }

      const result = await requestAnalysisInTransaction(
        this.analyses,
        transaction,
        prepared.submission.command,
        {
          requestId: requestId(
            `analysis-trigger:${prepared.submission.request.id}`,
          ),
          workspaceId: command.workspaceId,
          principalId: prepared.submission.request.actorPrincipalId,
          correlationId: command.correlationId,
          ...(command.traceContext === undefined
            ? {}
            : { traceContext: command.traceContext }),
          signal,
        },
      );
      await this.triggers.bindAnalysisJob(transaction, {
        workspaceId: command.workspaceId,
        triggerRequestId: prepared.submission.request.id,
        analysisJobId: result.analysisJobId,
        occurredAt: this.analyses.clock.now(),
      });
      return result;
    });
  }
}

/**
 * Worker composition invokes this one feature use case for a v2 trigger. A
 * retry after capture resumes durable PBI-011 request submission rather than
 * recapturing mutable remote case content.
 */
export class CaptureAndSubmitAnalysisTrigger {
  public constructor(
    private readonly capture: CaptureAnalysisTriggerCase,
    private readonly submit: SubmitCapturedAnalysisTrigger,
  ) {}

  public async execute(
    command: EnvelopeFor<"analysis.trigger.v2">,
    signal: AbortSignal,
  ): Promise<unknown> {
    const captured = await this.capture.execute(command, signal);
    if (captured.kind === "alreadyCapturing" || captured.kind === "notFound") {
      return captured;
    }
    return this.submit.execute(command, signal);
  }
}

/**
 * The capture result deliberately carries the profile and connector pins from the
 * durable request. A worker can request PBI-011 analysis using these values without
 * looking up a trigger's mutable current revision.
 */
export interface CapturedAnalysisTriggerCaseResult {
  readonly kind: "captured" | "alreadyCaptured";
  readonly caseSnapshotId: CaseSnapshotId;
  readonly triggerRequestId: AnalysisTriggerRequestId;
  readonly analysisProfileVersionId: AnalysisProfileVersionId;
  readonly connectorRegistrationId: string;
  readonly connectorConfigurationVersionId: string;
}

function capturedResult(
  kind: CapturedAnalysisTriggerCaseResult["kind"],
  caseSnapshotId: CaseSnapshotId,
  request: AnalysisTriggerRequest,
): CapturedAnalysisTriggerCaseResult {
  return Object.freeze({
    kind,
    caseSnapshotId,
    triggerRequestId: request.id,
    analysisProfileVersionId: request.analysisProfileVersionId,
    connectorRegistrationId: request.connectorRegistrationId,
    connectorConfigurationVersionId: request.connectorConfigurationVersionId,
  });
}
