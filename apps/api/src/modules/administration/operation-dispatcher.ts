import { createHash, randomUUID } from "node:crypto";

import type {
  CancelOperationalJob,
  QueueExpiredRetention,
  PurgeCaseSnapshot,
  RecoverExpiredJob,
  RequestKnowledgeSourceSynchronization,
  RetryDeadLetter,
} from "@caseweaver/application";
import {
  type AdministrationActionPreview,
  type AdministrationActionPreviewStore,
  type AdministrationOperationCommand,
  type AdministrationOperationPreflightPort,
  type AdministrationOperationRequestContext,
  AdministrationDeniedError,
  AdministrationUnavailableError,
  type StoredAdministrationActionPreview,
  digestOperationCommand,
  requiredOperationPermission,
  validateOperationCommand,
} from "@caseweaver/administration";
import {
  analysisJobId,
  correlationId,
  principalId,
  requestId,
  sha256Digest,
  workspaceId,
  publicationIntentId,
} from "@caseweaver/domain";

import type { AdminRequestContext, AdminResource } from "./routes.js";

type RoutedAction =
  | "connector.test"
  | "connector.activate"
  | "connector.disable"
  | "provider.test"
  | "provider.activate"
  | "provider.disable"
  | "source.synchronize"
  | "source.fullRescan"
  | "dead-letter.retry"
  | "job.cancel"
  | "job.recover"
  | "retention.reap"
  | "privacy.purge"
  | "diagnostics.export"
  | "secret.rotate"
  | "secret.revoke"
  | "publication.approve";

export interface SessionBoundAdminRequestContext extends AdminRequestContext {
  /** Stable server-side session identity; never provided by the browser. */
  readonly sessionId: string;
}

export interface OperationsUseCases {
  readonly retryDeadLetter: Pick<RetryDeadLetter, "execute">;
  readonly cancelJob: Pick<CancelOperationalJob, "execute">;
  readonly recoverJob: Pick<RecoverExpiredJob, "execute">;
  readonly queueRetention: Pick<QueueExpiredRetention, "execute">;
  readonly requestKnowledgeSourceSynchronization?: Pick<
    RequestKnowledgeSourceSynchronization,
    "execute"
  >;
  readonly purgeCaseSnapshot?: Pick<PurgeCaseSnapshot, "execute">;
  readonly approvePublication: Pick<
    import("@caseweaver/application").ApprovePublication,
    "execute"
  >;
}

/**
 * Adapter-owned transition for descriptor-backed configurations. It composes
 * the immutable administration lifecycle store rather than changing runtime
 * configuration rows in place.
 */
export interface DescriptorConfigurationLifecycle {
  execute(
    input: Readonly<{
      readonly action: "configuration.activate" | "configuration.disable";
      readonly configurationId: string;
      readonly resourceType: "connector-instances" | "ai-provider-instances";
      readonly context: SessionBoundAdminRequestContext;
      readonly idempotencyKeyDigest: ReturnType<typeof sha256Digest>;
    }>,
  ): Promise<
    Readonly<{ readonly changed: boolean; readonly lifecycle: string }>
  >;
}

/** Feature-owned administration lifecycle action; it only changes reference
 * metadata and never receives or returns a secret value. */
export interface SecretReferenceLifecycle {
  execute(
    input: Readonly<{
      readonly action: "secret.rotate" | "secret.revoke";
      readonly secretReferenceId: string;
      readonly context: SessionBoundAdminRequestContext;
      readonly idempotencyKeyDigest: ReturnType<typeof sha256Digest>;
    }>,
  ): Promise<
    Readonly<{ readonly changed: boolean; readonly lifecycle: string }>
  >;
}

export type RoutedOperationMapping =
  | Readonly<{
      readonly kind: "supported";
      readonly command: AdministrationOperationCommand;
    }>
  | Readonly<{ readonly kind: "unavailable" }>;

/**
 * Maps the HTTP action surface to operations commands
 * that can receive every required input. Connector/provider/source tests are
 * deliberately unavailable here; privacy purge has its own parameterized route
 * because the generic preview endpoint must never accept a deletion reason.
 */
export function mapRoutedOperation(
  input: Readonly<{
    readonly action: RoutedAction;
    readonly resource: AdminResource;
    readonly id?: string;
  }>,
): RoutedOperationMapping {
  const requiresId = (resource: AdminResource): string | undefined =>
    input.resource === resource ? input.id : undefined;

  switch (input.action) {
    case "dead-letter.retry": {
      const id = requiresId("dead-letters");
      return id === undefined
        ? Object.freeze({ kind: "unavailable" })
        : Object.freeze({
            kind: "supported",
            command: {
              action: "deadLetter.retry" as const,
              target: { resource: "deadLetter" as const, id },
              parameters: {} as const,
            } satisfies AdministrationOperationCommand,
          });
    }
    case "job.cancel":
    case "job.recover": {
      const id = requiresId("operation-jobs");
      return id === undefined
        ? Object.freeze({ kind: "unavailable" })
        : Object.freeze({
            kind: "supported",
            command: {
              action:
                input.action === "job.cancel"
                  ? ("job.cancel" as const)
                  : ("job.recover" as const),
              target: { resource: "job" as const, id },
              parameters: {} as const,
            } satisfies AdministrationOperationCommand,
          });
    }
    case "retention.reap":
      // The current browser route uses the platform card as the trigger. A
      // resource-specific retention page may later expose an explicit limit.
      return input.resource === "platform" && input.id === undefined
        ? Object.freeze({
            kind: "supported",
            command: {
              action: "retention.reap" as const,
              target: { resource: "retention" as const },
              parameters: { limit: 100 },
            } satisfies AdministrationOperationCommand,
          })
        : Object.freeze({ kind: "unavailable" });
    case "secret.rotate":
    case "secret.revoke": {
      const id = requiresId("secret-references");
      return id === undefined
        ? Object.freeze({ kind: "unavailable" })
        : Object.freeze({
            kind: "supported",
            command: {
              action: input.action,
              target: { resource: "secretReference", id },
              parameters: {} as const,
            } satisfies AdministrationOperationCommand,
          });
    }
    case "publication.approve": {
      const id = requiresId("publications");
      return id === undefined
        ? Object.freeze({ kind: "unavailable" })
        : Object.freeze({
            kind: "supported",
            command: {
              action: "publication.approve",
              target: { resource: "publication", id },
              parameters: {},
            } satisfies AdministrationOperationCommand,
          });
    }
    case "source.synchronize":
    case "source.fullRescan": {
      const id = requiresId("knowledge-sources");
      return id === undefined
        ? Object.freeze({ kind: "unavailable" })
        : Object.freeze({
            kind: "supported",
            command: {
              action:
                input.action === "source.synchronize"
                  ? "knowledgeSource.synchronize"
                  : "knowledgeSource.fullRescan",
              target: { resource: "knowledgeSource", id },
              parameters: {
                kind:
                  input.action === "source.synchronize"
                    ? "synchronize"
                    : "fullRescan",
              },
            } satisfies AdministrationOperationCommand,
          });
    }
    case "connector.test":
    case "provider.test":
    case "privacy.purge":
    case "diagnostics.export":
      return Object.freeze({ kind: "unavailable" });
    case "connector.activate":
    case "connector.disable": {
      const id = requiresId("connector-instances");
      return id === undefined
        ? Object.freeze({ kind: "unavailable" })
        : Object.freeze({
            kind: "supported",
            command: {
              action:
                input.action === "connector.activate"
                  ? "configuration.activate"
                  : "configuration.disable",
              target: { resource: "configuration", id },
              parameters: { resourceType: "connector-instances" },
            } satisfies AdministrationOperationCommand,
          });
    }
    case "provider.activate":
    case "provider.disable": {
      const id = requiresId("ai-provider-instances");
      return id === undefined
        ? Object.freeze({ kind: "unavailable" })
        : Object.freeze({
            kind: "supported",
            command: {
              action:
                input.action === "provider.activate"
                  ? "configuration.activate"
                  : "configuration.disable",
              target: { resource: "configuration", id },
              parameters: { resourceType: "ai-provider-instances" },
            } satisfies AdministrationOperationCommand,
          });
    }
  }
}

/** The resource-specific privacy route is the only route that accepts its
 * required reason. Generic action previews never receive sensitive parameters. */
export function mapPrivacyPurge(
  input: Readonly<{ readonly caseSnapshotId: string; readonly reason: string }>,
): Readonly<{
  readonly kind: "supported";
  readonly command: AdministrationOperationCommand;
}> {
  return Object.freeze({
    kind: "supported",
    command: {
      action: "privacy.purge",
      target: { resource: "caseSnapshot", id: input.caseSnapshotId },
      parameters: { reason: input.reason },
    } satisfies AdministrationOperationCommand,
  });
}

export function digestIdempotencyKey(
  value: string,
): ReturnType<typeof sha256Digest> {
  return sha256Digest(createHash("sha256").update(value, "utf8").digest("hex"));
}

/**
 * Executes an already-confirmed operation. The feature use cases own
 * business policy, idempotency records, outbox work, and their success audits.
 */
export class AdministrationOperationDispatcher {
  public constructor(
    private readonly dependencies: Readonly<{
      readonly previews: AdministrationActionPreviewStore;
      readonly preflight: AdministrationOperationPreflightPort;
      readonly useCases: OperationsUseCases;
      readonly secretReferences?: SecretReferenceLifecycle;
      readonly configurationLifecycle?: DescriptorConfigurationLifecycle;
      readonly createPreviewId?: () => string;
      readonly now?: () => Date;
    }>,
  ) {}

  public async preview(
    command: AdministrationOperationCommand,
    context: SessionBoundAdminRequestContext,
  ): Promise<AdministrationActionPreview> {
    const valid = validateOperationCommand(command);
    const permission = requiredOperationPermission(valid.action);
    this.requirePermission(context, permission);
    if (
      !isRoutable(
        valid.action,
        this.dependencies.secretReferences,
        this.dependencies.configurationLifecycle,
        this.dependencies.useCases.purgeCaseSnapshot,
        this.dependencies.useCases.requestKnowledgeSourceSynchronization,
      )
    )
      throw new AdministrationUnavailableError();

    const assessment = await this.dependencies.preflight.preview({
      command: valid,
      context: toAdministrationContext(context),
    });
    assertAssessment(assessment);
    const now = (this.dependencies.now ?? (() => new Date()))();
    const stored: StoredAdministrationActionPreview = Object.freeze({
      id: (this.dependencies.createPreviewId ?? randomUUID)(),
      workspaceId: workspaceId(context.workspaceId),
      principalId: principalId(context.principalId),
      sessionId: context.sessionId,
      action: valid.action,
      target: valid.target,
      command: valid,
      parameterDigest: digestOperationCommand(valid),
      permission,
      confirmation: assessment.confirmation,
      impact: assessment.impact,
      canConfirm: assessment.canConfirm,
      ...(assessment.estimatedCost === undefined
        ? {}
        : { estimatedCost: assessment.estimatedCost }),
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    });
    await this.dependencies.previews.create(stored);
    return publicPreview(stored);
  }

  public async execute(
    previewId: string,
    idempotencyKeyDigest: ReturnType<typeof sha256Digest>,
    context: SessionBoundAdminRequestContext,
  ): Promise<
    Readonly<{
      readonly operationId: string;
      readonly outcome: "accepted" | "completed";
      readonly message: string;
    }>
  > {
    const stored = await this.dependencies.previews.consume({
      previewId,
      workspaceId: workspaceId(context.workspaceId),
      principalId: principalId(context.principalId),
      sessionId: context.sessionId,
      now: (this.dependencies.now ?? (() => new Date()))().toISOString(),
    });
    if (stored === undefined || !stored.canConfirm) {
      throw new AdministrationUnavailableError();
    }
    const valid = validateOperationCommand(stored.command);
    if (stored.parameterDigest !== digestOperationCommand(valid)) {
      throw new AdministrationUnavailableError();
    }
    this.requirePermission(context, stored.permission);
    if (
      !isRoutable(
        valid.action,
        this.dependencies.secretReferences,
        this.dependencies.configurationLifecycle,
        this.dependencies.useCases.purgeCaseSnapshot,
        this.dependencies.useCases.requestKnowledgeSourceSynchronization,
      )
    )
      throw new AdministrationUnavailableError();

    const executionContext = {
      workspaceId: workspaceId(context.workspaceId),
      principalId: principalId(context.principalId),
      requestId: requestId(context.requestId),
      correlationId: correlationId(context.correlationId),
      signal: new AbortController().signal,
    };
    const mutation = {
      idempotencyKeyDigest,
      requestDigest: digestOperationCommand(valid),
    };

    switch (valid.action) {
      case "deadLetter.retry": {
        const result = await this.dependencies.useCases.retryDeadLetter.execute(
          analysisJobId(requiredId(valid)),
          mutation,
          executionContext,
        );
        return Object.freeze(
          result.analysisJobId === undefined
            ? {
                operationId: requiredId(valid),
                outcome: "completed" as const,
                message: "No eligible dead letter was retried.",
              }
            : {
                operationId: result.analysisJobId,
                outcome: "accepted" as const,
                message: "A replacement analysis job was queued.",
              },
        );
      }
      case "job.cancel": {
        const id = requiredId(valid);
        const result = await this.dependencies.useCases.cancelJob.execute(
          analysisJobId(id),
          mutation,
          executionContext,
        );
        return Object.freeze({
          operationId: id,
          outcome: "completed" as const,
          message: result.cancelled
            ? "The analysis job was cancelled."
            : "The analysis job was not eligible for cancellation.",
        });
      }
      case "job.recover": {
        const id = requiredId(valid);
        const result = await this.dependencies.useCases.recoverJob.execute(
          analysisJobId(id),
          mutation,
          executionContext,
        );
        return Object.freeze({
          operationId: id,
          outcome: result.recovered ? "accepted" : "completed",
          message: result.recovered
            ? "The expired job was returned to the queue."
            : "The analysis job was not eligible for recovery.",
        });
      }
      case "retention.reap": {
        const result = await this.dependencies.useCases.queueRetention.execute(
          mutation,
          executionContext,
          retentionLimit(valid),
        );
        return Object.freeze({
          operationId: `retention:${context.workspaceId}`,
          outcome: result.queued > 0 ? "accepted" : "completed",
          message:
            result.queued > 0
              ? "Expired retention work was queued."
              : "No expired retention work was eligible.",
        });
      }
      case "knowledgeSource.synchronize":
      case "knowledgeSource.fullRescan": {
        const request =
          this.dependencies.useCases.requestKnowledgeSourceSynchronization;
        if (request === undefined) throw new AdministrationUnavailableError();
        const result = await request.execute(
          {
            sourceId: requiredId(valid),
            kind: knowledgeSourceCommandKind(valid),
            idempotencyKeyDigest,
            requestDigest: digestOperationCommand(valid),
          },
          executionContext,
        );
        return Object.freeze({
          operationId:
            result.status === "queued"
              ? result.outboxEnvelopeId
              : requiredId(valid),
          outcome: result.status === "queued" ? "accepted" : "completed",
          message:
            result.status === "queued"
              ? result.replayed
                ? "The source synchronization request was already queued."
                : "The source synchronization was queued with its immutable configuration version."
              : result.status === "cooldown"
                ? "A manual full rescan is still within its server-enforced cooldown."
                : "The knowledge source is not available for synchronization.",
        });
      }
      case "privacy.purge": {
        const id = requiredId(valid);
        const purgeCaseSnapshot = this.dependencies.useCases.purgeCaseSnapshot;
        if (purgeCaseSnapshot === undefined)
          throw new AdministrationUnavailableError();
        const result = await purgeCaseSnapshot.execute(
          id,
          privacyReason(valid),
          mutation,
          executionContext,
        );
        return Object.freeze({
          operationId: id,
          outcome: result.purged ? "accepted" : "completed",
          message: result.purged
            ? "The case snapshot purge was accepted."
            : "The case snapshot was not available for purge.",
        });
      }
      case "secret.rotate":
      case "secret.revoke": {
        const lifecycle = this.dependencies.secretReferences;
        if (lifecycle === undefined) throw new AdministrationUnavailableError();
        const result = await lifecycle.execute({
          action: valid.action,
          secretReferenceId: requiredId(valid),
          context,
          idempotencyKeyDigest,
        });
        return Object.freeze({
          operationId: requiredId(valid),
          outcome: "completed" as const,
          message: result.changed
            ? `Secret reference lifecycle is now ${result.lifecycle}.`
            : `Secret reference was already ${result.lifecycle}.`,
        });
      }
      case "publication.approve": {
        const id = requiredId(valid);
        const result =
          await this.dependencies.useCases.approvePublication.execute(
            publicationIntentId(id),
            executionContext,
          );
        return Object.freeze({
          operationId: id,
          outcome: result.approved ? ("accepted" as const) : "completed",
          message: result.approved
            ? result.replayed
              ? "Publication intent was already approved."
              : "Publication intent was approved and queued when eligible."
            : "The publication intent is not eligible for approval.",
        });
      }
      case "configuration.activate":
      case "configuration.disable": {
        const lifecycle = this.dependencies.configurationLifecycle;
        if (lifecycle === undefined) throw new AdministrationUnavailableError();
        const result = await lifecycle.execute({
          action: valid.action,
          configurationId: requiredId(valid),
          resourceType: configurationResourceType(valid),
          context,
          idempotencyKeyDigest,
        });
        return Object.freeze({
          operationId: requiredId(valid),
          outcome: "completed" as const,
          message: result.changed
            ? `Configuration is now ${result.lifecycle}.`
            : `Configuration was already ${result.lifecycle}.`,
        });
      }
    }
  }

  private requirePermission(
    context: SessionBoundAdminRequestContext,
    permission: ReturnType<typeof requiredOperationPermission>,
  ): void {
    if (!context.permissions.includes(permission)) {
      throw new AdministrationDeniedError();
    }
  }
}

function isRoutable(
  action: AdministrationOperationCommand["action"],
  secretReferences: SecretReferenceLifecycle | undefined,
  configurationLifecycle: DescriptorConfigurationLifecycle | undefined,
  purgeCaseSnapshot: Pick<PurgeCaseSnapshot, "execute"> | undefined,
  requestKnowledgeSourceSynchronization:
    | Pick<RequestKnowledgeSourceSynchronization, "execute">
    | undefined,
): action is
  | "deadLetter.retry"
  | "job.cancel"
  | "job.recover"
  | "retention.reap"
  | "knowledgeSource.synchronize"
  | "knowledgeSource.fullRescan"
  | "privacy.purge"
  | "secret.rotate"
  | "secret.revoke"
  | "publication.approve"
  | "configuration.activate"
  | "configuration.disable" {
  return (
    action === "deadLetter.retry" ||
    action === "job.cancel" ||
    action === "job.recover" ||
    action === "retention.reap" ||
    ((action === "knowledgeSource.synchronize" ||
      action === "knowledgeSource.fullRescan") &&
      requestKnowledgeSourceSynchronization !== undefined) ||
    (action === "privacy.purge" && purgeCaseSnapshot !== undefined) ||
    action === "publication.approve" ||
    ((action === "secret.rotate" || action === "secret.revoke") &&
      secretReferences !== undefined) ||
    ((action === "configuration.activate" ||
      action === "configuration.disable") &&
      configurationLifecycle !== undefined)
  );
}

function toAdministrationContext(
  context: SessionBoundAdminRequestContext,
): AdministrationOperationRequestContext {
  return Object.freeze({
    workspaceId: workspaceId(context.workspaceId),
    principalId: principalId(context.principalId),
    sessionId: context.sessionId,
    requestId: context.requestId,
    correlationId: context.correlationId,
    ...(context.uiActionId === undefined
      ? {}
      : { uiActionId: context.uiActionId }),
    requestMode: context.requestMode,
  });
}

function requiredId(command: AdministrationOperationCommand): string {
  if (command.target.id === undefined)
    throw new AdministrationUnavailableError();
  return command.target.id;
}

function retentionLimit(command: AdministrationOperationCommand): number {
  if (
    command.action !== "retention.reap" ||
    !("limit" in command.parameters) ||
    typeof command.parameters.limit !== "number"
  ) {
    throw new AdministrationUnavailableError();
  }
  return command.parameters.limit;
}

function knowledgeSourceCommandKind(
  command: AdministrationOperationCommand,
): "synchronize" | "fullRescan" {
  if (
    (command.action !== "knowledgeSource.synchronize" &&
      command.action !== "knowledgeSource.fullRescan") ||
    !("kind" in command.parameters) ||
    (command.parameters.kind !== "synchronize" &&
      command.parameters.kind !== "fullRescan")
  ) {
    throw new AdministrationUnavailableError();
  }
  return command.parameters.kind;
}

function privacyReason(command: AdministrationOperationCommand): string {
  if (
    command.action !== "privacy.purge" ||
    !("reason" in command.parameters) ||
    typeof command.parameters.reason !== "string"
  ) {
    throw new AdministrationUnavailableError();
  }
  return command.parameters.reason;
}

function configurationResourceType(
  command: AdministrationOperationCommand,
): "connector-instances" | "ai-provider-instances" {
  if (
    (command.action !== "configuration.activate" &&
      command.action !== "configuration.disable") ||
    !("resourceType" in command.parameters) ||
    (command.parameters.resourceType !== "connector-instances" &&
      command.parameters.resourceType !== "ai-provider-instances")
  ) {
    throw new AdministrationUnavailableError();
  }
  return command.parameters.resourceType;
}

function publicPreview(
  stored: StoredAdministrationActionPreview,
): AdministrationActionPreview {
  const { command: _command, ...preview } = stored;
  return Object.freeze(preview);
}

function assertAssessment(
  value: Awaited<ReturnType<AdministrationOperationPreflightPort["preview"]>>,
): void {
  if (
    value.confirmation.trim().length < 1 ||
    value.impact.trim().length < 1 ||
    value.confirmation.length > 500 ||
    value.impact.length > 2_000
  ) {
    throw new AdministrationUnavailableError();
  }
}
