import {
  auditEventId,
  causationId,
  createEnvelope,
  IdempotencyConflictError,
  outboxEnvelopeId,
  type Sha256Digest,
} from "@caseweaver/domain";

import type {
  AuditStore,
  AuthorizationGuard,
  Clock,
  ExecutionContext,
  IdGenerator,
  KnowledgeSourceCommandKind,
  KnowledgeSourceCommandStore,
  OutboxStore,
  UnitOfWork,
} from "./ports.js";

const minimumFullRescanCooldownMs = 60_000;
const maximumFullRescanCooldownMs = 86_400_000;
const defaultFullRescanCooldownMs = 3_600_000;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("The operation was aborted.");
  }
}

export interface RequestKnowledgeSourceSynchronizationCommand {
  readonly sourceId: string;
  readonly kind: KnowledgeSourceCommandKind;
  readonly idempotencyKeyDigest: Sha256Digest;
  readonly requestDigest: Sha256Digest;
}

export type RequestKnowledgeSourceSynchronizationResult =
  | Readonly<{
      readonly status: "queued";
      readonly outboxEnvelopeId: string;
      readonly sourceConfigurationVersionId: string;
      readonly connectorConfigurationVersionId: string;
      readonly replayed: boolean;
    }>
  | Readonly<{
      readonly status: "unavailable" | "cooldown";
      readonly replayed: false;
    }>;

/**
 * Queues a source synchronization without selecting or invoking a connector.
 * The worker resolves and verifies the immutable configuration version before
 * it performs I/O.  This keeps manual administration and scheduled execution
 * on the same durable, provider-neutral command boundary.
 */
export class RequestKnowledgeSourceSynchronization {
  public constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: KnowledgeSourceCommandStore,
    private readonly outbox: OutboxStore,
    private readonly audit: AuditStore,
    private readonly authorization: AuthorizationGuard,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly fullRescanCooldownMs = defaultFullRescanCooldownMs,
  ) {
    if (
      !Number.isInteger(fullRescanCooldownMs) ||
      fullRescanCooldownMs < minimumFullRescanCooldownMs ||
      fullRescanCooldownMs > maximumFullRescanCooldownMs
    ) {
      throw new RangeError(
        "Manual full-rescan cooldown must be between one minute and twenty-four hours.",
      );
    }
  }

  public async execute(
    command: RequestKnowledgeSourceSynchronizationCommand,
    context: ExecutionContext,
  ): Promise<RequestKnowledgeSourceSynchronizationResult> {
    if (command.sourceId.length < 1 || command.sourceId.length > 200) {
      throw new RangeError("Knowledge source ID is invalid.");
    }
    if (command.kind !== "synchronize" && command.kind !== "fullRescan") {
      throw new RangeError("Knowledge source command kind is invalid.");
    }

    throwIfAborted(context.signal);
    await this.authorization.require(context, "connector.manage");
    throwIfAborted(context.signal);

    return this.unitOfWork.transaction(async (transaction) => {
      const idempotency = {
        workspaceId: context.workspaceId,
        operation: "knowledgeSource.synchronize" as const,
        keyDigest: command.idempotencyKeyDigest,
      };
      await this.store.lockIdempotencyKey(transaction, idempotency);
      const prior = await this.store.findIdempotency(transaction, idempotency);
      if (prior !== undefined) {
        if (prior.requestDigest !== command.requestDigest) {
          throw new IdempotencyConflictError("knowledgeSource.synchronize");
        }
        return {
          status: "queued",
          outboxEnvelopeId: prior.outboxEnvelopeId,
          sourceConfigurationVersionId: prior.sourceConfigurationVersionId,
          connectorConfigurationVersionId:
            prior.connectorConfigurationVersionId,
          replayed: true,
        };
      }

      const occurredAt = this.clock.now();
      const source = await this.store.findSource(transaction, {
        workspaceId: context.workspaceId,
        sourceId: command.sourceId,
      });
      if (source === undefined || source.lifecycle !== "enabled") {
        await this.recordRejectedAudit(
          transaction,
          context,
          command,
          occurredAt,
          "sourceUnavailable",
        );
        return { status: "unavailable", replayed: false };
      }

      if (command.kind === "fullRescan") {
        const reserved = await this.store.reserveManualFullRescan(transaction, {
          workspaceId: context.workspaceId,
          sourceId: source.id,
          occurredAt,
          cooldownMs: this.fullRescanCooldownMs,
        });
        if (!reserved) {
          await this.recordRejectedAudit(
            transaction,
            context,
            command,
            occurredAt,
            "fullRescanCooldown",
          );
          return { status: "cooldown", replayed: false };
        }
      }

      const envelopeId = outboxEnvelopeId(this.ids.next("outboxEnvelope"));
      await this.outbox.append(
        transaction,
        createEnvelope({
          id: envelopeId,
          kind: "command",
          type:
            command.kind === "synchronize"
              ? "knowledge.synchronize.v2"
              : "knowledge.full-rescan.v2",
          schemaVersion: 1,
          workspaceId: context.workspaceId,
          occurredAt,
          correlationId: context.correlationId,
          causationId: causationId(context.requestId),
          ...(context.traceContext === undefined
            ? {}
            : { traceContext: context.traceContext }),
          payload: {
            sourceId: source.id,
            sourceConfigurationVersionId: source.sourceConfigurationVersionId,
            connectorConfigurationVersionId:
              source.connectorConfigurationVersionId,
            trigger: "manual",
          },
        }),
      );
      await this.audit.append(transaction, {
        id: auditEventId(this.ids.next("auditEvent")),
        workspaceId: context.workspaceId,
        actorPrincipalId: context.principalId,
        action: "knowledgeSource.synchronization.queued",
        targetId: source.id,
        targetType: "knowledgeSource",
        outcome: "succeeded",
        permission: "connector.manage",
        afterHash: command.requestDigest,
        idempotencyKeyDigest: command.idempotencyKeyDigest,
        requestId: context.requestId,
        correlationId: context.correlationId,
        occurredAt,
      });
      await this.store.recordIdempotency(transaction, {
        ...idempotency,
        requestDigest: command.requestDigest,
        outboxEnvelopeId: envelopeId,
        sourceConfigurationVersionId: source.sourceConfigurationVersionId,
        connectorConfigurationVersionId: source.connectorConfigurationVersionId,
        kind: command.kind,
        occurredAt,
      });

      return {
        status: "queued",
        outboxEnvelopeId: envelopeId,
        sourceConfigurationVersionId: source.sourceConfigurationVersionId,
        connectorConfigurationVersionId: source.connectorConfigurationVersionId,
        replayed: false,
      };
    });
  }

  private async recordRejectedAudit(
    transaction: Parameters<AuditStore["append"]>[0],
    context: ExecutionContext,
    command: RequestKnowledgeSourceSynchronizationCommand,
    occurredAt: ReturnType<Clock["now"]>,
    reasonCode: "sourceUnavailable" | "fullRescanCooldown",
  ): Promise<void> {
    await this.audit.append(transaction, {
      id: auditEventId(this.ids.next("auditEvent")),
      workspaceId: context.workspaceId,
      actorPrincipalId: context.principalId,
      action: "knowledgeSource.synchronization.rejected",
      targetId: command.sourceId,
      targetType: "knowledgeSource",
      outcome: "failed",
      permission: "connector.manage",
      reasonCode,
      afterHash: command.requestDigest,
      idempotencyKeyDigest: command.idempotencyKeyDigest,
      requestId: context.requestId,
      correlationId: context.correlationId,
      occurredAt,
    });
  }
}
