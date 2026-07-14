import type { EnvelopeFor, WorkspaceId } from "@caseweaver/domain";

import { publicationDeliveryIdentity } from "./identity.js";
import type {
  PublicationAttempt,
  PublicationCandidate,
  PublicationExecutionDependencies,
} from "./ports.js";

export class PublicationExecutionError extends Error {
  public constructor(
    public readonly code:
      | "publication.destinationUnavailable"
      | "publication.notReady"
      | "publication.cancelled",
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PublicationExecutionError";
  }
}

function errorDetails(error: unknown): {
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
  return { code: "publication.destinationFailure", retryable: true };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new PublicationExecutionError(
      "publication.cancelled",
      "Publication execution was cancelled.",
      false,
    );
  }
}

export class PublicationExecutor {
  public constructor(
    private readonly dependencies: PublicationExecutionDependencies,
  ) {
    if (!Number.isInteger(dependencies.leaseMs) || dependencies.leaseMs < 1) {
      throw new RangeError("Publication lease duration must be positive.");
    }
  }

  public async execute(
    command:
      | EnvelopeFor<"publication.execute.v1">
      | EnvelopeFor<"publication.reconcile.v1">,
    signal: AbortSignal,
  ): Promise<{ readonly published: boolean; readonly attempted: boolean }> {
    throwIfAborted(signal);
    const reconciliation = command.type === "publication.reconcile.v1";
    const candidate = await this.dependencies.unitOfWork.transaction(
      (transaction) =>
        this.dependencies.store.findCandidate(transaction, {
          workspaceId: command.workspaceId,
          publicationIntentId: command.payload.publicationIntentId,
        }),
    );
    if (candidate === undefined) {
      return { published: false, attempted: false };
    }
    const identity = publicationDeliveryIdentity(candidate.identityHash);
    if (identity.marker.value !== candidate.marker.value) {
      throw new Error("Publication intent has an invalid immutable marker.");
    }
    const prepared = await this.prepare(
      command.workspaceId,
      candidate,
      candidate.identityHash,
      candidate.marker.value,
      reconciliation,
    );
    if (prepared === undefined) {
      return { published: false, attempted: false };
    }
    const { attempt, fencingToken } = prepared;

    try {
      throwIfAborted(signal);
      const destination = this.dependencies.destinations.resolve(
        candidate.profile.destination.connectorInstanceId,
      );
      if (destination === undefined) {
        throw new PublicationExecutionError(
          "publication.destinationUnavailable",
          "The configured publication destination is unavailable.",
          true,
        );
      }
      const existing = await destination.findPublication({
        target: candidate.target,
        marker: candidate.marker,
        requestId: candidate.intent.id,
        signal,
      });
      if (existing !== null) {
        await this.recordPublished(candidate, attempt, {
          reference: existing.reference,
          marker: existing.marker.value,
          requestId: candidate.intent.id,
        });
        return { published: true, attempted: true };
      }
      const publication = this.dependencies.renderer.render({
        analysis: candidate.analysis,
        profile: candidate.profile,
      });
      throwIfAborted(signal);
      const result = await destination.publish({
        target: candidate.target,
        marker: candidate.marker,
        idempotencyKey: identity.idempotencyKey,
        requestHash: identity.requestHash,
        publication,
        requestId: candidate.intent.id,
        signal,
      });
      if (result.status === "outcome_unknown") {
        await this.dependencies.unitOfWork.transaction((transaction) =>
          this.dependencies.store.recordOutcomeUnknown(transaction, {
            candidate,
            attempt,
            now: this.dependencies.clock.now(),
          }),
        );
        return { published: false, attempted: true };
      }
      await this.recordPublished(candidate, attempt, {
        reference: result.receipt.reference,
        marker: result.receipt.marker.value,
        requestId: result.receipt.requestId,
      });
      return { published: true, attempted: true };
    } catch (error) {
      await this.dependencies.unitOfWork.transaction((transaction) =>
        this.dependencies.store.recordFailure(transaction, {
          candidate,
          attempt,
          error: errorDetails(error),
          now: this.dependencies.clock.now(),
        }),
      );
      throw error;
    } finally {
      await this.dependencies.unitOfWork.transaction((transaction) =>
        this.dependencies.leases.complete(transaction, {
          workspaceId: command.workspaceId,
          resourceType: "publication",
          resourceKey: candidate.identityHash,
          fencingToken,
        }),
      );
    }
  }

  public async reconcile(
    workspaceId: WorkspaceId,
    signal: AbortSignal,
    limit = 25,
  ): Promise<{ readonly queued: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError(
        "Publication reconciliation limit must be between 1 and 100.",
      );
    }
    const intents = await this.dependencies.unitOfWork.transaction(
      (transaction) =>
        this.dependencies.store.findOutcomeUnknown(transaction, {
          workspaceId,
          limit,
        }),
    );
    let queued = 0;
    for (const id of intents) {
      await this.execute(
        {
          id: `publication-reconcile:${id}` as EnvelopeFor<"publication.reconcile.v1">["id"],
          kind: "command",
          type: "publication.reconcile.v1",
          schemaVersion: 1,
          workspaceId,
          occurredAt: this.dependencies.clock.now(),
          correlationId:
            `publication-reconcile:${id}` as EnvelopeFor<"publication.reconcile.v1">["correlationId"],
          causationId:
            `publication-reconcile:${id}` as EnvelopeFor<"publication.reconcile.v1">["causationId"],
          payload: { publicationIntentId: id },
        },
        signal,
      );
      queued += 1;
    }
    return { queued };
  }

  private async prepare(
    workspaceId: WorkspaceId,
    candidate: PublicationCandidate,
    identityHash: string,
    marker: string,
    allowOutcomeUnknown: boolean,
  ): Promise<
    | {
        readonly attempt: PublicationAttempt;
        readonly fencingToken: bigint;
      }
    | undefined
  > {
    return this.dependencies.unitOfWork.transaction(async (transaction) => {
      const lease = await this.dependencies.leases.acquire(transaction, {
        workspaceId,
        resourceType: "publication",
        resourceKey: identityHash,
        leaseMs: this.dependencies.leaseMs,
      });
      if (lease === undefined) return undefined;
      const attempt = await this.dependencies.store.prepare(transaction, {
        candidate,
        identityHash,
        marker,
        allowOutcomeUnknown,
        now: this.dependencies.clock.now(),
      });
      if (attempt === undefined) {
        await this.dependencies.leases.complete(transaction, {
          workspaceId,
          resourceType: "publication",
          resourceKey: identityHash,
          fencingToken: lease.fencingToken,
        });
        return undefined;
      }
      return { attempt, fencingToken: lease.fencingToken };
    });
  }

  private async recordPublished(
    candidate: PublicationCandidate,
    attempt: PublicationAttempt,
    receipt: {
      readonly reference: PublicationCandidate["target"];
      readonly marker: string;
      readonly requestId?: string;
    },
  ): Promise<void> {
    await this.dependencies.unitOfWork.transaction((transaction) =>
      this.dependencies.store.recordPublished(transaction, {
        candidate,
        attempt,
        receipt,
        now: this.dependencies.clock.now(),
      }),
    );
  }
}
