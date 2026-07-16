import {
  analysisIdentityId,
  analysisJobId,
  analysisProfileVersionId,
  analysisTriggerId,
  analysisTriggerVersionId,
  caseSnapshotId,
  causationId,
  correlationId,
  deserializeEnvelope,
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
  type AnalysisTriggerInvocationError,
  CaptureAnalysisTriggerCase,
  CaptureAndSubmitAnalysisTrigger,
  RequestAnalysisTrigger,
  SubmitCapturedAnalysisTrigger,
} from "./analysis-trigger-use-cases.js";
import type {
  AnalysisTriggerRequest,
  AnalysisTriggerRequestStore,
  ApplicationTransaction,
  AuditStore,
  AuthorizationGuard,
  Clock,
  ExecutionContext,
  IdGenerator,
  OutboxStore,
  TriggeredCaseSnapshotCapture,
  UnitOfWork,
} from "./ports.js";

const now = utcInstant("2026-07-15T18:00:00.000Z");
const firstDigest = sha256Digest("a".repeat(64));
const secondDigest = sha256Digest("b".repeat(64));

class DirectUnitOfWork implements UnitOfWork {
  public async transaction<Result>(
    operation: (transaction: ApplicationTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation({} as ApplicationTransaction);
  }
}

class SequentialIds implements IdGenerator {
  private ordinal = 0;

  public next(kind: Parameters<IdGenerator["next"]>[0]): string {
    this.ordinal += 1;
    return `${kind}-${this.ordinal}`;
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

  public async claim() {
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

class MemoryTriggerStore implements AnalysisTriggerRequestStore {
  private readonly requests = new Map<string, AnalysisTriggerRequest>();
  public readonly persisted: Parameters<
    AnalysisTriggerRequestStore["persistCapture"]
  >[1][] = [];
  public readonly failures: Parameters<
    AnalysisTriggerRequestStore["failCapture"]
  >[1][] = [];
  public claimCalls = 0;
  public claimOutcome:
    | Awaited<ReturnType<AnalysisTriggerRequestStore["claimCapture"]>>
    | undefined;
  public submissionOutcome:
    | Awaited<
        ReturnType<AnalysisTriggerRequestStore["prepareAnalysisSubmission"]>
      >
    | undefined;
  public readonly boundAnalysisJobs: Parameters<
    AnalysisTriggerRequestStore["bindAnalysisJob"]
  >[1][] = [];

  public async createOrFind(
    _transaction: ApplicationTransaction,
    input: Parameters<AnalysisTriggerRequestStore["createOrFind"]>[1],
  ): Promise<Awaited<ReturnType<AnalysisTriggerRequestStore["createOrFind"]>>> {
    if (
      input.expectedTriggerVersionId !== undefined &&
      input.expectedTriggerVersionId !==
        analysisTriggerVersionId("trigger-version-1")
    ) {
      const error = new Error("Analysis trigger configuration is unavailable.");
      Object.assign(error, {
        code: "analysis.trigger.configurationUnavailable",
        retryable: false,
      });
      throw error;
    }
    const existing = this.requests.get(input.idempotencyKeyDigest);
    if (existing !== undefined) return { kind: "replayed", request: existing };
    const request: AnalysisTriggerRequest = {
      id: input.id,
      workspaceId: input.workspaceId,
      actorPrincipalId: input.actorPrincipalId,
      triggerId: input.triggerId,
      triggerVersionId: analysisTriggerVersionId("trigger-version-1"),
      analysisProfileVersionId: analysisProfileVersionId("profile-version-1"),
      connectorRegistrationId: input.target.connectorInstanceId,
      connectorConfigurationVersionId: "connector-configuration-1",
      source: input.source,
      ...(input.occurrenceKey === undefined
        ? {}
        : { occurrenceKey: input.occurrenceKey }),
      target: input.target,
      idempotencyKeyDigest: input.idempotencyKeyDigest,
      requestDigest: input.requestDigest,
    };
    this.requests.set(input.idempotencyKeyDigest, request);
    return { kind: "created", request };
  }

  public async claimCapture(
    _transaction: ApplicationTransaction,
    _input: Parameters<AnalysisTriggerRequestStore["claimCapture"]>[1],
  ): Promise<Awaited<ReturnType<AnalysisTriggerRequestStore["claimCapture"]>>> {
    this.claimCalls += 1;
    if (this.claimOutcome === undefined) return { kind: "notFound" };
    return this.claimOutcome;
  }

  public async persistCapture(
    _transaction: ApplicationTransaction,
    input: Parameters<AnalysisTriggerRequestStore["persistCapture"]>[1],
  ): Promise<ReturnType<typeof caseSnapshotId>> {
    this.persisted.push(input);
    return caseSnapshotId("case-snapshot-1");
  }

  public async failCapture(
    _transaction: ApplicationTransaction,
    input: Parameters<AnalysisTriggerRequestStore["failCapture"]>[1],
  ): Promise<void> {
    this.failures.push(input);
  }

  public async prepareAnalysisSubmission(
    _transaction: ApplicationTransaction,
    _input: Parameters<
      AnalysisTriggerRequestStore["prepareAnalysisSubmission"]
    >[1],
  ): Promise<
    Awaited<
      ReturnType<AnalysisTriggerRequestStore["prepareAnalysisSubmission"]>
    >
  > {
    return this.submissionOutcome ?? { kind: "notCaptured" };
  }

  public async bindAnalysisJob(
    _transaction: ApplicationTransaction,
    input: Parameters<AnalysisTriggerRequestStore["bindAnalysisJob"]>[1],
  ): Promise<void> {
    this.boundAnalysisJobs.push(input);
  }

  public request(digest = firstDigest): AnalysisTriggerRequest {
    const request = this.requests.get(digest);
    if (request === undefined) throw new Error("Test request was not created.");
    return request;
  }
}

class FixedSnapshotCapture implements TriggeredCaseSnapshotCapture {
  public readonly requests: AnalysisTriggerRequest[] = [];

  public async capture(
    input: Parameters<TriggeredCaseSnapshotCapture["capture"]>[0],
  ) {
    this.requests.push(input.request);
    return {
      revision: "revision-1",
      capturedAt: now,
      title: "Case title",
      summary: "Case summary",
      contentHash: firstDigest,
      messages: [
        {
          id: "message-1",
          content: "Normalized case content",
          contentHash: secondDigest,
        },
      ],
    };
  }
}

const context: ExecutionContext = {
  requestId: requestId("request-1"),
  workspaceId: workspaceId("workspace-1"),
  principalId: principalId("principal-1"),
  correlationId: correlationId("correlation-1"),
  signal: new AbortController().signal,
};

const allowed: AuthorizationGuard = { require: async () => undefined };
const clock: Clock = { now: () => now };

function requestCommand(
  requestDigest = firstDigest,
  expectedTriggerVersionId?: ReturnType<typeof analysisTriggerVersionId>,
) {
  return {
    triggerId: analysisTriggerId("trigger-1"),
    ...(expectedTriggerVersionId === undefined
      ? {}
      : { expectedTriggerVersionId }),
    source: "webhook" as const,
    occurrenceKey: "event-1",
    target: {
      connectorInstanceId: "connector-1",
      resourceType: "case",
      externalId: "case-1",
    },
    idempotencyKeyDigest: firstDigest,
    requestDigest,
  };
}

describe("versioned analysis trigger use cases", () => {
  it("durably requests the expected immutable v2 trigger pin and atomically audits the command", async () => {
    const store = new MemoryTriggerStore();
    const outbox = new MemoryOutbox();
    const audit = new MemoryAudit();
    const useCase = new RequestAnalysisTrigger(
      new DirectUnitOfWork(),
      store,
      outbox,
      audit,
      allowed,
      new SequentialIds(),
      clock,
    );

    const expectedVersion = analysisTriggerVersionId("trigger-version-1");
    const created = await useCase.execute(
      requestCommand(firstDigest, expectedVersion),
      context,
    );
    const replayed = await useCase.execute(
      requestCommand(firstDigest, expectedVersion),
      context,
    );

    expect(created.replayed).toBe(false);
    expect(replayed).toEqual({ requestId: created.requestId, replayed: true });
    expect(outbox.envelopes).toHaveLength(1);
    expect(outbox.envelopes[0]).toMatchObject({
      type: "analysis.trigger.v2",
      payload: {
        triggerRequestId: created.requestId,
        triggerVersionId: "trigger-version-1",
        connectorConfigurationVersionId: "connector-configuration-1",
      },
    });
    expect(JSON.stringify(outbox.envelopes[0])).not.toContain("secret");
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      action: "analysis.trigger.requested",
      targetId: created.requestId,
    });

    await expect(
      useCase.execute(requestCommand(secondDigest), context),
    ).rejects.toMatchObject({
      name: "IdempotencyConflictError",
    });

    await expect(
      useCase.execute(
        requestCommand(
          secondDigest,
          analysisTriggerVersionId("trigger-version-unavailable"),
        ),
        context,
      ),
    ).rejects.toMatchObject({
      code: "analysis.trigger.configurationUnavailable",
      retryable: false,
    });
    expect(outbox.envelopes).toHaveLength(1);
    expect(audit.records).toHaveLength(1);
  });

  it("rejects v1 trigger commands without attempting mutable configuration resolution", async () => {
    const store = new MemoryTriggerStore();
    const capture = new FixedSnapshotCapture();
    const useCase = new CaptureAnalysisTriggerCase(
      new DirectUnitOfWork(),
      store,
      capture,
      clock,
    );
    const legacy = deserializeEnvelope({
      id: outboxEnvelopeId("outbox-trigger-v1"),
      kind: "command",
      type: "analysis.trigger.v1",
      schemaVersion: 1,
      workspaceId: context.workspaceId,
      occurredAt: now,
      correlationId: context.correlationId,
      causationId: causationId(context.requestId),
      payload: { triggerId: "legacy-trigger", source: "manual" },
    });

    await expect(useCase.execute(legacy, context.signal)).rejects.toMatchObject<
      Partial<AnalysisTriggerInvocationError>
    >({ code: "analysis.trigger.legacyUnavailable", retryable: false });
    expect(store.claimCalls).toBe(0);
    expect(capture.requests).toHaveLength(0);
  });

  it("does not claim or resolve a v2 request when cancellation precedes capture", async () => {
    const store = new MemoryTriggerStore();
    const outbox = new MemoryOutbox();
    const requester = new RequestAnalysisTrigger(
      new DirectUnitOfWork(),
      store,
      outbox,
      new MemoryAudit(),
      allowed,
      new SequentialIds(),
      clock,
    );
    await requester.execute(requestCommand(), context);
    const capture = new FixedSnapshotCapture();
    const useCase = new CaptureAnalysisTriggerCase(
      new DirectUnitOfWork(),
      store,
      capture,
      clock,
    );
    const controller = new AbortController();
    controller.abort(new Error("Capture cancelled."));

    await expect(
      useCase.execute(
        outbox.envelopes[0] as Extract<
          Envelope,
          { type: "analysis.trigger.v2" }
        >,
        controller.signal,
      ),
    ).rejects.toThrow("Capture cancelled.");
    expect(store.claimCalls).toBe(0);
    expect(capture.requests).toHaveLength(0);
  });

  it("captures a normalized snapshot only after a fenced v2 claim", async () => {
    const store = new MemoryTriggerStore();
    const outbox = new MemoryOutbox();
    const requester = new RequestAnalysisTrigger(
      new DirectUnitOfWork(),
      store,
      outbox,
      new MemoryAudit(),
      allowed,
      new SequentialIds(),
      clock,
    );
    await requester.execute(requestCommand(), context);
    const request = store.request();
    store.claimOutcome = {
      kind: "claimed",
      claim: { request, fencingToken: 4n },
    };
    const capture = new FixedSnapshotCapture();
    const useCase = new CaptureAnalysisTriggerCase(
      new DirectUnitOfWork(),
      store,
      capture,
      clock,
    );

    const result = await useCase.execute(
      outbox.envelopes[0] as Extract<Envelope, { type: "analysis.trigger.v2" }>,
      context.signal,
    );

    expect(result).toEqual({
      kind: "captured",
      caseSnapshotId: "case-snapshot-1",
      triggerRequestId: request.id,
      analysisProfileVersionId: "profile-version-1",
      connectorRegistrationId: "connector-1",
      connectorConfigurationVersionId: "connector-configuration-1",
    });
    expect(capture.requests).toEqual([request]);
    expect(store.persisted).toHaveLength(1);
    expect(store.persisted[0]?.claim.fencingToken).toBe(4n);
    expect(store.persisted[0]?.snapshot.messages[0]?.content).toBe(
      "Normalized case content",
    );
  });

  it("atomically turns a captured v2 request into the existing analysis job workflow", async () => {
    const store = new MemoryTriggerStore();
    const outbox = new MemoryOutbox();
    const audit = new MemoryAudit();
    const ids = new SequentialIds();
    const requester = new RequestAnalysisTrigger(
      new DirectUnitOfWork(),
      store,
      outbox,
      audit,
      allowed,
      ids,
      clock,
    );
    await requester.execute(requestCommand(), context);
    const request = store.request();
    const command = outbox.envelopes[0] as Extract<
      Envelope,
      { type: "analysis.trigger.v2" }
    >;
    store.claimOutcome = {
      kind: "captured",
      request,
      caseSnapshotId: caseSnapshotId("case-snapshot-1"),
    };
    store.submissionOutcome = {
      kind: "ready",
      submission: {
        request,
        command: {
          idempotencyKeyDigest: sha256Digest("c".repeat(64)),
          requestDigest: sha256Digest("d".repeat(64)),
          identityHash: sha256Digest("e".repeat(64)),
          analysisProfileVersionId: request.analysisProfileVersionId,
          caseSnapshotId: caseSnapshotId("case-snapshot-1"),
        },
      },
    };
    const analyses = {
      lockIdempotencyKey: async () => undefined,
      findIdempotency: async () => undefined,
      findOrCreateIdentity: async () => ({
        id: analysisIdentityId("analysis-identity-1"),
        workspaceId: context.workspaceId,
        identityHash: sha256Digest("e".repeat(64)),
        analysisProfileVersionId: request.analysisProfileVersionId,
        caseSnapshotId: caseSnapshotId("case-snapshot-1"),
      }),
      findJobByRunOrdinal: async () => undefined,
      createJob: async () => undefined,
      recordIdempotency: async () => undefined,
    };
    const submit = new SubmitCapturedAnalysisTrigger(
      new DirectUnitOfWork(),
      store,
      { store: analyses as never, outbox, audit, ids, clock },
    );
    const workflow = new CaptureAndSubmitAnalysisTrigger(
      new CaptureAnalysisTriggerCase(
        new DirectUnitOfWork(),
        store,
        new FixedSnapshotCapture(),
        clock,
      ),
      submit,
    );

    const result = await workflow.execute(command, context.signal);

    expect(result).toMatchObject({
      replayed: false,
      analysisIdentityId: "analysis-identity-1",
    });
    expect(store.boundAnalysisJobs).toHaveLength(1);
    expect(store.boundAnalysisJobs[0]).toMatchObject({
      triggerRequestId: request.id,
      analysisJobId: analysisJobId("analysisJob-5"),
    });
    expect(outbox.envelopes).toHaveLength(2);
    expect(outbox.envelopes[1]).toMatchObject({ type: "analysis.execute.v1" });
    expect(audit.records).toHaveLength(2);
    expect(audit.records[1]).toMatchObject({
      action: "analysis.requested",
      actorPrincipalId: context.principalId,
    });
  });

  it("fails closed when the pinned configuration is unavailable", async () => {
    const store = new MemoryTriggerStore();
    const outbox = new MemoryOutbox();
    const requester = new RequestAnalysisTrigger(
      new DirectUnitOfWork(),
      store,
      outbox,
      new MemoryAudit(),
      allowed,
      new SequentialIds(),
      clock,
    );
    await requester.execute(requestCommand(), context);
    store.claimOutcome = { kind: "unavailable" };
    const capture = new FixedSnapshotCapture();
    const useCase = new CaptureAnalysisTriggerCase(
      new DirectUnitOfWork(),
      store,
      capture,
      clock,
    );

    await expect(
      useCase.execute(
        outbox.envelopes[0] as Extract<
          Envelope,
          { type: "analysis.trigger.v2" }
        >,
        context.signal,
      ),
    ).rejects.toMatchObject<Partial<AnalysisTriggerInvocationError>>({
      code: "analysis.trigger.configurationUnavailable",
      retryable: false,
    });
    expect(capture.requests).toHaveLength(0);
  });
});
