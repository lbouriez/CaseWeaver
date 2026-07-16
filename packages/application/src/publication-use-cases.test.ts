import {
  analysisJobId,
  analysisProfileVersionId,
  analysisResultId,
  caseSnapshotId,
  causationId,
  correlationId,
  createEnvelope,
  type Envelope,
  outboxEnvelopeId,
  type PublicationIntent,
  principalId,
  publicationIntentId,
  requestId,
  sha256Digest,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { describe, expect, it, vi } from "vitest";

import type {
  AnalysisIdentityRecord,
  AnalysisRequestStore,
  ApplicationTransaction,
  AuditStore,
  AuthorizationGuard,
  Clock,
  ExecutionContext,
  IdGenerator,
  OutboxStore,
  PublicationIntentStore,
  StoredIdempotencyRecord,
  UnitOfWork as UnitOfWorkPort,
} from "./ports.js";
import {
  ApprovePublication,
  RequestAnalysisWithPublication,
  SchedulePublicationForCompletedAnalysis,
} from "./publication-use-cases.js";

const now = utcInstant("2026-07-14T16:00:00.000Z");
const digest = sha256Digest("a".repeat(64));

class DirectUnitOfWork implements UnitOfWorkPort {
  public async transaction<Result>(
    operation: (transaction: ApplicationTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation({} as ApplicationTransaction);
  }
}

class Ids implements IdGenerator {
  private value = 0;

  public next(kind: Parameters<IdGenerator["next"]>[0]): string {
    this.value += 1;
    return `${kind}-${this.value}`;
  }
}

class AnalysisStore implements AnalysisRequestStore {
  public readonly jobs = new Map<
    string,
    import("@caseweaver/domain").AnalysisJob
  >();
  private readonly idempotency = new Map<string, StoredIdempotencyRecord>();

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
    return {
      id: input.id,
      workspaceId: input.workspaceId,
      identityHash: input.identityHash,
      analysisProfileVersionId: input.analysisProfileVersionId,
      caseSnapshotId: input.caseSnapshotId,
    };
  }

  public async findJobByRunOrdinal(): Promise<undefined> {
    return undefined;
  }

  public async createJob(
    _transaction: ApplicationTransaction,
    job: import("@caseweaver/domain").AnalysisJob,
  ): Promise<void> {
    this.jobs.set(job.id, job);
  }

  public async lockIdentityForRerun(): Promise<never> {
    throw new Error("Not used by this test.");
  }

  public async findJob(
    _transaction: ApplicationTransaction,
    input: Parameters<AnalysisRequestStore["findJob"]>[1],
  ) {
    return this.jobs.get(input.analysisJobId);
  }

  public async updateJobState(): Promise<void> {}
}

class PublicationStore implements PublicationIntentStore {
  public readonly intents: PublicationIntent[] = [];
  public readonly commands: Envelope[] = [];
  public ready: ReturnType<typeof publicationIntentId>[] = [];
  public approvals = 0;
  private readonly approved = new Set<string>();

  public async findProfile() {
    return {
      id: "profile-1",
      version: "1",
      destinationConnectorInstanceId: "connector-1",
      destinationConnectorConfigurationVersionId: "connector-configuration-1",
      policy: {
        mode: "autoPublishInternal" as const,
        visibility: "internal" as const,
      },
    };
  }

  public async createOrFindIntent(
    _transaction: ApplicationTransaction,
    input: Parameters<PublicationIntentStore["createOrFindIntent"]>[1],
  ): Promise<PublicationIntent> {
    const intent: PublicationIntent = {
      id: input.id,
      workspaceId: input.workspaceId,
      analysisJobId: input.analysisJobId,
      state: input.state,
      createdAt: input.occurredAt,
      updatedAt: input.occurredAt,
    };
    this.intents.push(intent);
    return intent;
  }

  public async findIntent(
    _transaction: ApplicationTransaction,
    input: Parameters<PublicationIntentStore["findIntent"]>[1],
  ): Promise<PublicationIntent | undefined> {
    return this.intents.find(
      (intent) => intent.id === input.publicationIntentId,
    );
  }

  public async updateIntent(): Promise<void> {}

  public async approveIntent(
    _transaction: ApplicationTransaction,
    input: Parameters<PublicationIntentStore["approveIntent"]>[1],
  ) {
    const index = this.intents.findIndex(
      (intent) => intent.id === input.publicationIntentId,
    );
    const intent = this.intents[index];
    if (intent === undefined) {
      return { outcome: "notApprovable" as const };
    }
    if (this.approved.has(intent.id)) {
      return { outcome: "alreadyApproved" as const, intent };
    }
    if (intent.state !== "awaitingApproval") {
      return { outcome: "notApprovable" as const };
    }
    const approved: PublicationIntent = {
      ...intent,
      state: "pending",
      updatedAt: input.occurredAt,
    };
    this.intents[index] = approved;
    this.approved.add(approved.id);
    this.approvals += 1;
    return { outcome: "approved" as const, intent: approved };
  }

  public async bindAnalysisResult(): Promise<void> {}

  public async findReadyIntentIds() {
    return this.ready;
  }

  public async enqueuePublication(
    _transaction: ApplicationTransaction,
    envelope: Envelope,
  ): Promise<void> {
    if (!this.commands.some((command) => command.id === envelope.id)) {
      this.commands.push(envelope);
    }
  }
}

class Outbox implements OutboxStore {
  public readonly commands: Envelope[] = [];

  public async append(
    _transaction: ApplicationTransaction,
    envelope: Envelope,
  ): Promise<void> {
    this.commands.push(envelope);
  }

  public async claim() {
    return [];
  }

  public async acknowledge(): Promise<void> {}
}

const context: ExecutionContext = {
  requestId: requestId("request-1"),
  workspaceId: workspaceId("workspace-1"),
  principalId: principalId("principal-1"),
  correlationId: correlationId("correlation-1"),
  signal: new AbortController().signal,
};

function command(dryRun: boolean) {
  return {
    idempotencyKeyDigest: digest,
    requestDigest: digest,
    identityHash: digest,
    analysisProfileVersionId: analysisProfileVersionId("profile-version-1"),
    caseSnapshotId: caseSnapshotId("snapshot-1"),
    publication: {
      profileId: "profile-1",
      profileVersion: "1",
      target: {
        connectorInstanceId: "connector-1",
        resourceType: "case",
        externalId: "case-1",
      },
      intentHash: digest,
      dryRun,
    },
  };
}

describe("RequestAnalysisWithPublication", () => {
  it("keeps a dry run out of publication identity while still queuing analysis", async () => {
    const analyses = new AnalysisStore();
    const publications = new PublicationStore();
    const outbox = new Outbox();
    const service = new RequestAnalysisWithPublication(
      new DirectUnitOfWork(),
      analyses,
      publications,
      outbox,
      { append: async () => undefined } satisfies AuditStore,
      { require: async () => undefined } satisfies AuthorizationGuard,
      new Ids(),
      { now: () => now } satisfies Clock,
    );

    const preview = await service.execute(command(true), context);

    expect(preview).toMatchObject({ preview: true });
    expect(publications.intents).toEqual([]);
    expect(outbox.commands).toHaveLength(1);
    expect(outbox.commands[0]?.type).toBe("analysis.execute.v1");

    const approvedRequest = await service.execute(
      { ...command(false), idempotencyKeyDigest: sha256Digest("b".repeat(64)) },
      context,
    );
    expect(approvedRequest.publicationIntentId).toBeDefined();
    expect(publications.intents).toHaveLength(1);
  });

  describe("ApprovePublication", () => {
    it("authorizes and atomically records a single audit and command for retries", async () => {
      const publications = new PublicationStore();
      const intent: PublicationIntent = {
        id: publicationIntentId("intent-approval-1"),
        workspaceId: context.workspaceId,
        analysisJobId: analysisJobId("analysis-job-approval-1"),
        state: "awaitingApproval",
        createdAt: now,
        updatedAt: now,
      };
      publications.intents.push(intent);
      publications.ready = [intent.id];
      const authorization = { require: vi.fn(async () => undefined) };
      const audit = { append: vi.fn(async () => undefined) };
      const service = new ApprovePublication(
        new DirectUnitOfWork(),
        publications,
        audit,
        authorization,
        new Ids(),
        { now: () => now } satisfies Clock,
      );

      await expect(service.execute(intent.id, context)).resolves.toEqual({
        approved: true,
        replayed: false,
      });
      await expect(service.execute(intent.id, context)).resolves.toEqual({
        approved: true,
        replayed: true,
      });

      expect(authorization.require).toHaveBeenCalledWith(
        context,
        "publication.approve",
      );
      expect(publications.approvals).toBe(1);
      expect(publications.commands).toHaveLength(1);
      expect(audit.append).toHaveBeenCalledTimes(1);
    });

    it("does not enqueue publication until the completed-analysis handoff", async () => {
      const publications = new PublicationStore();
      const intent: PublicationIntent = {
        id: publicationIntentId("intent-awaiting-result-1"),
        workspaceId: context.workspaceId,
        analysisJobId: analysisJobId("analysis-job-awaiting-result-1"),
        state: "awaitingApproval",
        createdAt: now,
        updatedAt: now,
      };
      publications.intents.push(intent);
      const service = new ApprovePublication(
        new DirectUnitOfWork(),
        publications,
        { append: async () => undefined } satisfies AuditStore,
        { require: async () => undefined } satisfies AuthorizationGuard,
        new Ids(),
        { now: () => now } satisfies Clock,
      );

      await expect(service.execute(intent.id, context)).resolves.toEqual({
        approved: true,
        replayed: false,
      });
      expect(publications.commands).toHaveLength(0);
    });
  });

  it("turns AnalysisCompleted into a durable publication command without rendering", async () => {
    const publications = new PublicationStore();
    const intent: PublicationIntent = {
      id: publicationIntentId("intent-ready-1"),
      workspaceId: context.workspaceId,
      analysisJobId: analysisJobId("analysis-job-ready-1"),
      state: "pending",
      createdAt: now,
      updatedAt: now,
    };
    publications.intents.push(intent);
    publications.ready = [intent.id];
    const service = new SchedulePublicationForCompletedAnalysis(
      new DirectUnitOfWork(),
      publications,
      { now: () => now } satisfies Clock,
    );
    const event = createEnvelope({
      id: outboxEnvelopeId("outbox-analysis-completed-1"),
      kind: "domainEvent",
      type: "analysis.completed.v1",
      schemaVersion: 1,
      workspaceId: context.workspaceId,
      occurredAt: now,
      correlationId: context.correlationId,
      causationId: causationId("cause-1"),
      payload: {
        analysisJobId: analysisJobId("analysis-job-ready-1"),
        analysisResultId: analysisResultId("analysis-result-ready-1"),
      },
    });

    await expect(service.execute(event)).resolves.toEqual({ scheduled: 1 });
    await expect(service.execute(event)).resolves.toEqual({ scheduled: 1 });
    expect(publications.commands).toHaveLength(1);
    expect(publications.commands[0]?.type).toBe("publication.execute.v1");
  });
});
