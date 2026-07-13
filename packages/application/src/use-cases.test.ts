import {
  type AnalysisJob,
  analysisProfileVersionId,
  caseSnapshotId,
  correlationId,
  type Envelope,
  principalId,
  requestId,
  sha256Digest,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import type { AuditRecord } from "@caseweaver/security";
import { describe, expect, it } from "vitest";

import type {
  AnalysisIdentityRecord,
  AnalysisRequestStore,
  ApplicationTransaction,
  AuditStore,
  AuthorizationGuard,
  BootstrapInstallation,
  BootstrapWorkspaceStore,
  ClaimedOutboxEnvelope,
  Clock,
  DurableMessageQueue,
  ExecutionContext,
  IdGenerator,
  OutboxStore,
  StoredIdempotencyRecord,
  UnitOfWork,
} from "./ports.js";
import {
  BootstrapWorkspace,
  ForceRerunAnalysis,
  OutboxRelay,
  RequestAnalysis,
} from "./use-cases.js";

const digest = (character: string) => sha256Digest(character.repeat(64));
const now = utcInstant("2026-01-01T00:00:00.000Z");

class SerializedUnitOfWork implements UnitOfWork {
  private tail = Promise.resolve();

  public async transaction<Result>(
    operation: (transaction: ApplicationTransaction) => Promise<Result>,
  ): Promise<Result> {
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preceding = this.tail;
    this.tail = current;
    await preceding;
    try {
      return await operation({} as ApplicationTransaction);
    } finally {
      release?.();
    }
  }
}

class FixedIds implements IdGenerator {
  private sequence = 0;

  public next(kind: Parameters<IdGenerator["next"]>[0]): string {
    this.sequence += 1;
    return `${kind}-${this.sequence}`;
  }
}

const clock: Clock = { now: () => now };
const allowed: AuthorizationGuard = { require: async () => undefined };

function context(): ExecutionContext {
  return {
    requestId: requestId("request-1"),
    workspaceId: workspaceId("workspace-1"),
    principalId: principalId("principal-1"),
    correlationId: correlationId("correlation-1"),
    signal: new AbortController().signal,
  };
}

class MemoryAuditStore implements AuditStore {
  public readonly records: AuditRecord[] = [];

  public async append(
    _transaction: ApplicationTransaction,
    record: AuditRecord,
  ): Promise<void> {
    this.records.push(record);
  }
}

class MemoryBootstrapStore implements BootstrapWorkspaceStore {
  public installation: BootstrapInstallation | undefined;
  public workspaceCreates = 0;
  public principalCreates = 0;
  public administratorAssignments = 0;

  public async lockInstallation(
    _transaction: ApplicationTransaction,
  ): Promise<BootstrapInstallation | undefined> {
    return this.installation;
  }

  public async createWorkspace(): Promise<void> {
    this.workspaceCreates += 1;
  }

  public async createPrincipal(): Promise<void> {
    this.principalCreates += 1;
  }

  public async assignWorkspaceRole(
    _transaction: ApplicationTransaction,
    assignment: Parameters<BootstrapWorkspaceStore["assignWorkspaceRole"]>[1],
  ): Promise<void> {
    if (assignment.role === "administrator") {
      this.administratorAssignments += 1;
    }
  }

  public async completeInstallation(
    _transaction: ApplicationTransaction,
    installation: BootstrapInstallation,
  ): Promise<void> {
    this.installation = installation;
  }
}

class MemoryAnalysisStore implements AnalysisRequestStore {
  private readonly idempotency = new Map<string, StoredIdempotencyRecord>();
  private readonly identities = new Map<string, AnalysisIdentityRecord>();
  public readonly jobs = new Map<string, AnalysisJob>();

  public async lockIdempotencyKey(): Promise<void> {}

  public async findIdempotency(
    _transaction: ApplicationTransaction,
    input: Parameters<AnalysisRequestStore["findIdempotency"]>[1],
  ): Promise<StoredIdempotencyRecord | undefined> {
    return this.idempotency.get(input.keyDigest);
  }

  public async recordIdempotency(
    _transaction: ApplicationTransaction,
    input: Parameters<AnalysisRequestStore["recordIdempotency"]>[1],
  ): Promise<void> {
    this.idempotency.set(input.keyDigest, {
      requestDigest: input.requestDigest,
      resourceId: input.resourceId,
    });
  }

  public async findOrCreateIdentity(
    _transaction: ApplicationTransaction,
    input: Parameters<AnalysisRequestStore["findOrCreateIdentity"]>[1],
  ): Promise<AnalysisIdentityRecord> {
    const found = this.identities.get(input.identityHash);
    if (found !== undefined) {
      return found;
    }
    const identity: AnalysisIdentityRecord = {
      id: input.id,
      workspaceId: input.workspaceId,
      identityHash: input.identityHash,
      analysisProfileVersionId: input.analysisProfileVersionId,
      caseSnapshotId: input.caseSnapshotId,
    };
    this.identities.set(input.identityHash, identity);
    return identity;
  }

  public async findJobByRunOrdinal(
    _transaction: ApplicationTransaction,
    input: Parameters<AnalysisRequestStore["findJobByRunOrdinal"]>[1],
  ): Promise<AnalysisJob | undefined> {
    return [...this.jobs.values()].find(
      (job) =>
        job.workspaceId === input.workspaceId &&
        job.analysisIdentityId === input.analysisIdentityId &&
        job.runOrdinal === input.runOrdinal,
    );
  }

  public async createJob(
    _transaction: ApplicationTransaction,
    job: AnalysisJob,
  ): Promise<void> {
    this.jobs.set(job.id, job);
  }

  public async lockIdentityForRerun(
    _transaction: ApplicationTransaction,
    input: Parameters<AnalysisRequestStore["lockIdentityForRerun"]>[1],
  ): Promise<{
    readonly identity: AnalysisIdentityRecord;
    readonly nextRunOrdinal: number;
  }> {
    const identity = [...this.identities.values()].find(
      (candidate) =>
        candidate.workspaceId === input.workspaceId &&
        candidate.id === input.analysisIdentityId,
    );
    if (identity === undefined) {
      throw new Error("Analysis identity was not found.");
    }
    const runOrdinals = [...this.jobs.values()]
      .filter((job) => job.analysisIdentityId === identity.id)
      .map((job) => job.runOrdinal);
    return {
      identity,
      nextRunOrdinal: Math.max(...runOrdinals) + 1,
    };
  }

  public async findJob(
    _transaction: ApplicationTransaction,
    input: Parameters<AnalysisRequestStore["findJob"]>[1],
  ): Promise<AnalysisJob | undefined> {
    const job = this.jobs.get(input.analysisJobId);
    return job?.workspaceId === input.workspaceId ? job : undefined;
  }

  public async updateJobState(
    _transaction: ApplicationTransaction,
    job: AnalysisJob,
  ): Promise<void> {
    this.jobs.set(job.id, job);
  }
}

class MemoryOutbox implements OutboxStore {
  public readonly envelopes: Envelope[] = [];
  public acknowledgements = 0;
  public failAcknowledgement = false;
  private claimed = false;

  public async append(
    _transaction: ApplicationTransaction,
    envelope: Envelope,
  ): Promise<void> {
    this.envelopes.push(envelope);
  }

  public async claim(): Promise<readonly ClaimedOutboxEnvelope[]> {
    if (this.claimed || this.envelopes.length === 0) {
      return [];
    }
    this.claimed = true;
    return this.envelopes.map((envelope) => ({
      envelope,
      claimToken: "claim-1",
    }));
  }

  public async acknowledge(): Promise<void> {
    if (this.failAcknowledgement) {
      throw new Error("simulated process crash");
    }
    this.acknowledgements += 1;
  }

  public expireClaim(): void {
    this.claimed = false;
  }
}

const command = {
  idempotencyKeyDigest: digest("a"),
  requestDigest: digest("b"),
  identityHash: digest("c"),
  analysisProfileVersionId: analysisProfileVersionId("profile-version-1"),
  caseSnapshotId: caseSnapshotId("snapshot-1"),
};

describe("BootstrapWorkspace", () => {
  it("serializes first-install creation through trusted bootstrap authorization", async () => {
    const store = new MemoryBootstrapStore();
    const audit = new MemoryAuditStore();
    const service = new BootstrapWorkspace(
      new SerializedUnitOfWork(),
      store,
      {
        resolveInitialAdministrator: async () => ({
          principalId: principalId("trusted-administrator"),
        }),
      },
      audit,
      new FixedIds(),
      clock,
    );

    const [first, second] = await Promise.all([
      service.execute(),
      service.execute(),
    ]);

    expect([first.created, second.created]).toEqual([true, false]);
    expect(store.workspaceCreates).toBe(1);
    expect(store.principalCreates).toBe(1);
    expect(store.administratorAssignments).toBe(1);
    expect(audit.records).toHaveLength(1);
  });
});

describe("RequestAnalysis and ForceRerunAnalysis", () => {
  it("replays an identical idempotent request and rejects a changed one", async () => {
    const store = new MemoryAnalysisStore();
    const outbox = new MemoryOutbox();
    const request = new RequestAnalysis(
      new SerializedUnitOfWork(),
      store,
      outbox,
      new MemoryAuditStore(),
      allowed,
      new FixedIds(),
      clock,
    );

    const first = await request.execute(command, context());
    const replay = await request.execute(command, context());

    expect(replay).toEqual({ ...first, replayed: true });
    await expect(
      request.execute({ ...command, requestDigest: digest("d") }, context()),
    ).rejects.toThrow("idempotency key");
    expect(outbox.envelopes).toHaveLength(1);
  });

  it("creates the next run without modifying the initial job", async () => {
    const store = new MemoryAnalysisStore();
    const outbox = new MemoryOutbox();
    const unitOfWork = new SerializedUnitOfWork();
    const request = new RequestAnalysis(
      unitOfWork,
      store,
      outbox,
      new MemoryAuditStore(),
      allowed,
      new FixedIds(),
      clock,
    );
    const first = await request.execute(command, context());
    const rerun = await new ForceRerunAnalysis(
      unitOfWork,
      store,
      outbox,
      new MemoryAuditStore(),
      allowed,
      new FixedIds(),
      clock,
    ).execute({ analysisIdentityId: first.analysisIdentityId }, context());

    expect(store.jobs.get(first.analysisJobId)?.runOrdinal).toBe(0);
    expect(rerun.runOrdinal).toBe(1);
    expect(store.jobs.size).toBe(2);
  });
});

describe("OutboxRelay", () => {
  it("reuses the envelope ID when publish succeeds before acknowledgement crashes", async () => {
    const outbox = new MemoryOutbox();
    const store = new MemoryAnalysisStore();
    const unitOfWork = new SerializedUnitOfWork();
    const request = new RequestAnalysis(
      unitOfWork,
      store,
      outbox,
      new MemoryAuditStore(),
      allowed,
      new FixedIds(),
      clock,
    );
    await request.execute(command, context());
    const published: string[] = [];
    const queue: DurableMessageQueue = {
      publish: async (envelope) => {
        published.push(envelope.id);
      },
    };
    const relay = new OutboxRelay(unitOfWork, outbox, queue, clock);

    outbox.failAcknowledgement = true;
    await expect(relay.runOnce()).rejects.toThrow("simulated process crash");
    outbox.failAcknowledgement = false;
    outbox.expireClaim();
    await expect(relay.runOnce()).resolves.toEqual({ delivered: 1 });

    expect(published).toEqual([
      outbox.envelopes[0]?.id,
      outbox.envelopes[0]?.id,
    ]);
    expect(outbox.acknowledgements).toBe(1);
  });
});
