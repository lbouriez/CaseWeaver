import {
  causationId,
  correlationId,
  createEnvelope,
  type Envelope,
  outboxEnvelopeId,
  principalId,
  requestId,
  sha256Digest,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import type { AuditRecord } from "@caseweaver/security";
import { describe, expect, it } from "vitest";
import {
  PurgeRetentionWorkItem,
  QueueExpiredRetention,
  ReapExpiredRetentionWork,
  RetentionObjectReferenceUnavailableError,
} from "./operational-use-cases.js";
import type {
  ApplicationTransaction,
  AuditStore,
  AuthorizationGuard,
  Clock,
  ExecutionContext,
  IdGenerator,
  OperationsStore,
  OutboxStore,
  RetentionObjectReference,
  RetentionObjectStore,
  UnitOfWork,
} from "./ports.js";

const now = utcInstant("2026-07-15T12:00:00.000Z");
const digest = sha256Digest("a".repeat(64));
const workspace = workspaceId("workspace-1");

class ImmediateUnitOfWork implements UnitOfWork {
  public async transaction<Result>(
    operation: (transaction: ApplicationTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation({} as ApplicationTransaction);
  }
}

class FixedIds implements IdGenerator {
  private sequence = 0;

  public next(kind: Parameters<IdGenerator["next"]>[0]): string {
    this.sequence += 1;
    return `${kind}-${this.sequence}`;
  }
}

class MemoryOutbox implements OutboxStore {
  public readonly envelopes: Envelope[] = [];

  public async append(
    _transaction: ApplicationTransaction,
    envelope: Envelope,
  ): Promise<void> {
    this.envelopes.push(envelope);
  }

  public async claim(): Promise<readonly []> {
    return [];
  }

  public async acknowledge(): Promise<void> {}
}

class MemoryAudit implements AuditStore {
  public readonly records: AuditRecord[] = [];

  public async append(
    _transaction: ApplicationTransaction,
    record: AuditRecord,
  ): Promise<void> {
    this.records.push(record);
  }
}

const allowed: AuthorizationGuard = { require: async () => undefined };
const clock: Clock = { now: () => now };

function context(): ExecutionContext {
  return {
    requestId: requestId("request-1"),
    workspaceId: workspace,
    principalId: principalId("principal-1"),
    correlationId: correlationId("correlation-1"),
    signal: new AbortController().signal,
  };
}

function retentionStore(overrides: Partial<OperationsStore>): OperationsStore {
  return {
    lockAction: async () => undefined,
    findAction: async () => undefined,
    recordAction: async () => undefined,
    queueExpiredRetention: async () => [],
    claimRetentionWork: async () => undefined,
    completeRetentionWork: async () => false,
    releaseRetentionWork: async () => undefined,
    ...overrides,
  } as OperationsStore;
}

describe("retention work use cases", () => {
  it("queues a reaper command instead of enumerating expired work in an operator request", async () => {
    const outbox = new MemoryOutbox();
    const audit = new MemoryAudit();
    let queueCalls = 0;
    const store = retentionStore({
      queueExpiredRetention: async () => {
        queueCalls += 1;
        return [];
      },
    });
    const useCase = new QueueExpiredRetention(
      new ImmediateUnitOfWork(),
      store,
      outbox,
      audit,
      allowed,
      new FixedIds(),
      clock,
    );

    await expect(
      useCase.execute(
        { idempotencyKeyDigest: digest, requestDigest: digest },
        context(),
        17,
      ),
    ).resolves.toEqual({ queued: 1, replayed: false });

    expect(queueCalls).toBe(0);
    expect(outbox.envelopes).toMatchObject([
      {
        type: "retention.reap.v1",
        payload: { reason: "operator", limit: 17 },
      },
    ]);
    expect(audit.records).toMatchObject([{ action: "retention.reap.queued" }]);
  });

  it("reaps with a legacy-compatible command and atomically records purge work", async () => {
    const outbox = new MemoryOutbox();
    const audit = new MemoryAudit();
    let requestedLimit: number | undefined;
    const store = retentionStore({
      queueExpiredRetention: async (_transaction, input) => {
        requestedLimit = input.limit;
        return [
          { id: "retention-work-1", workspaceId: input.workspaceId },
          { id: "retention-work-2", workspaceId: input.workspaceId },
        ];
      },
    });
    const command = createEnvelope({
      id: outboxEnvelopeId("outbox-reap-1"),
      kind: "command",
      type: "retention.reap.v1",
      schemaVersion: 1,
      workspaceId: workspace,
      occurredAt: now,
      correlationId: correlationId("correlation-1"),
      causationId: causationId("causation-1"),
      payload: { reason: "scheduled" },
    });
    const useCase = new ReapExpiredRetentionWork(
      new ImmediateUnitOfWork(),
      store,
      outbox,
      audit,
      new FixedIds(),
      clock,
      23,
    );

    await expect(
      useCase.execute(command, new AbortController().signal),
    ).resolves.toEqual({ queued: 2 });

    expect(requestedLimit).toBe(23);
    expect(outbox.envelopes).toMatchObject([
      {
        type: "retention.purge.v1",
        payload: { workItemId: "retention-work-1" },
      },
      {
        type: "retention.purge.v1",
        payload: { workItemId: "retention-work-2" },
      },
    ]);
    expect(audit.records).toMatchObject([
      {
        action: "retention.reap.processed",
        origin: "worker",
        outcome: "succeeded",
        reasonCode: "scheduled",
      },
    ]);
  });

  it("fails closed and releases a key-only historical item without deleting an object", async () => {
    let releases = 0;
    let deletions = 0;
    const store = retentionStore({
      claimRetentionWork: async () => ({
        id: "retention-work-legacy",
        workspaceId: workspace,
        storageKey: "historical-key-not-used",
        fencingToken: 7n,
      }),
      releaseRetentionWork: async () => {
        releases += 1;
      },
    });
    const objects: RetentionObjectStore = {
      delete: async () => {
        deletions += 1;
      },
    };
    const useCase = new PurgeRetentionWorkItem(
      new ImmediateUnitOfWork(),
      store,
      objects,
      new MemoryAudit(),
      new FixedIds(),
      clock,
    );

    await expect(
      useCase.execute(
        workspace,
        "retention-work-legacy",
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(RetentionObjectReferenceUnavailableError);

    expect(deletions).toBe(0);
    expect(releases).toBe(1);
  });

  it("deletes only the full immutable reference and audits fenced completion", async () => {
    const reference: RetentionObjectReference = {
      workspaceId: workspace,
      storageBackendId: "storage-primary",
      key: "v1/caseweaver/opaque/content/sha256",
    };
    const deleted: RetentionObjectReference[] = [];
    let completed = 0;
    const audit = new MemoryAudit();
    const store = retentionStore({
      claimRetentionWork: async () => ({
        id: "retention-work-1",
        workspaceId: workspace,
        objectReference: reference,
        fencingToken: 9n,
      }),
      completeRetentionWork: async () => {
        completed += 1;
        return true;
      },
    });
    const objects: RetentionObjectStore = {
      delete: async (objectReference) => {
        deleted.push(objectReference);
      },
    };
    const useCase = new PurgeRetentionWorkItem(
      new ImmediateUnitOfWork(),
      store,
      objects,
      audit,
      new FixedIds(),
      clock,
    );

    await useCase.execute(
      workspace,
      "retention-work-1",
      new AbortController().signal,
    );

    expect(deleted).toEqual([reference]);
    expect(completed).toBe(1);
    expect(audit.records).toMatchObject([
      {
        action: "retention.work.completed",
        targetId: "retention:retention-work-1",
        origin: "worker",
        outcome: "succeeded",
      },
    ]);
  });
});
