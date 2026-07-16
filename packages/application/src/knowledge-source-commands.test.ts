import {
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

import {
  RequestKnowledgeSourceSynchronization,
  type RequestKnowledgeSourceSynchronizationCommand,
} from "./knowledge-source-commands.js";
import type {
  ApplicationTransaction,
  AuditStore,
  AuthorizationGuard,
  Clock,
  ExecutionContext,
  IdGenerator,
  KnowledgeSourceCommandStore,
  OutboxStore,
  UnitOfWork,
} from "./ports.js";

const now = utcInstant("2026-07-15T12:00:00.000Z");
const digest = (character: string) => sha256Digest(character.repeat(64));
const command: RequestKnowledgeSourceSynchronizationCommand = {
  sourceId: "source-1",
  kind: "synchronize",
  idempotencyKeyDigest: digest("a"),
  requestDigest: digest("b"),
};

class UnitOfWorkStub implements UnitOfWork {
  public async transaction<Result>(
    operation: (transaction: ApplicationTransaction) => Promise<Result>,
  ): Promise<Result> {
    return operation({} as ApplicationTransaction);
  }
}

class Ids implements IdGenerator {
  private nextValue = 0;

  public next(kind: Parameters<IdGenerator["next"]>[0]): string {
    this.nextValue += 1;
    return `${kind}-${this.nextValue}`;
  }
}

class SourceStore implements KnowledgeSourceCommandStore {
  public source:
    | {
        readonly id: string;
        readonly lifecycle: "enabled" | "disabled";
        readonly sourceConfigurationVersionId: string;
        readonly connectorConfigurationVersionId: string;
      }
    | undefined = {
    id: "source-1",
    lifecycle: "enabled",
    sourceConfigurationVersionId: "source-configuration-1",
    connectorConfigurationVersionId: "connector-configuration-1",
  };
  public fullRescanAvailable = true;
  public readonly idempotency = new Map<
    string,
    Awaited<ReturnType<KnowledgeSourceCommandStore["findIdempotency"]>>
  >();

  public async lockIdempotencyKey(): Promise<void> {}

  public async findIdempotency(
    _transaction: ApplicationTransaction,
    input: Parameters<KnowledgeSourceCommandStore["findIdempotency"]>[1],
  ) {
    return this.idempotency.get(input.keyDigest);
  }

  public async recordIdempotency(
    _transaction: ApplicationTransaction,
    input: Parameters<KnowledgeSourceCommandStore["recordIdempotency"]>[1],
  ): Promise<void> {
    this.idempotency.set(input.keyDigest, {
      requestDigest: input.requestDigest,
      outboxEnvelopeId: input.outboxEnvelopeId,
      sourceConfigurationVersionId: input.sourceConfigurationVersionId,
      connectorConfigurationVersionId: input.connectorConfigurationVersionId,
      kind: input.kind,
    });
  }

  public async findSource() {
    return this.source;
  }

  public async reserveManualFullRescan(): Promise<boolean> {
    const available = this.fullRescanAvailable;
    this.fullRescanAvailable = false;
    return available;
  }
}

class Outbox implements OutboxStore {
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

class Audit implements AuditStore {
  public readonly records: AuditRecord[] = [];

  public async append(
    _transaction: ApplicationTransaction,
    record: AuditRecord,
  ): Promise<void> {
    this.records.push(record);
  }
}

const authorization: AuthorizationGuard = { require: async () => undefined };
const clock: Clock = { now: () => now };
const context = (): ExecutionContext => ({
  requestId: requestId("request-1"),
  workspaceId: workspaceId("workspace-1"),
  principalId: principalId("principal-1"),
  correlationId: correlationId("correlation-1"),
  signal: new AbortController().signal,
});

function subject(
  store = new SourceStore(),
  outbox = new Outbox(),
  audit = new Audit(),
) {
  return {
    store,
    outbox,
    audit,
    useCase: new RequestKnowledgeSourceSynchronization(
      new UnitOfWorkStub(),
      store,
      outbox,
      audit,
      authorization,
      new Ids(),
      clock,
    ),
  };
}

describe("RequestKnowledgeSourceSynchronization", () => {
  it("authorizes and atomically records a version-pinned manual command, audit, and idempotency record", async () => {
    const { useCase, outbox, audit, store } = subject();

    const result = await useCase.execute(command, context());

    expect(result).toMatchObject({
      status: "queued",
      sourceConfigurationVersionId: "source-configuration-1",
      connectorConfigurationVersionId: "connector-configuration-1",
      replayed: false,
    });
    expect(outbox.envelopes).toHaveLength(1);
    expect(outbox.envelopes[0]).toMatchObject({
      type: "knowledge.synchronize.v2",
      payload: {
        sourceId: "source-1",
        sourceConfigurationVersionId: "source-configuration-1",
        connectorConfigurationVersionId: "connector-configuration-1",
        trigger: "manual",
      },
    });
    expect(audit.records).toMatchObject([
      {
        action: "knowledgeSource.synchronization.queued",
        outcome: "succeeded",
        permission: "connector.manage",
      },
    ]);
    expect(store.idempotency).toHaveLength(1);
  });

  it("replays the same idempotent command without another outbox or audit record", async () => {
    const { useCase, outbox, audit } = subject();
    const first = await useCase.execute(command, context());
    const replay = await useCase.execute(command, context());

    expect(replay).toEqual({ ...first, replayed: true });
    expect(outbox.envelopes).toHaveLength(1);
    expect(audit.records).toHaveLength(1);
    await expect(
      useCase.execute({ ...command, requestDigest: digest("c") }, context()),
    ).rejects.toThrow("idempotency key");
  });

  it("does not queue inactive or foreign sources and persists a failed audit record", async () => {
    const { useCase, outbox, audit, store } = subject();
    store.source = undefined;

    await expect(useCase.execute(command, context())).resolves.toEqual({
      status: "unavailable",
      replayed: false,
    });
    expect(outbox.envelopes).toHaveLength(0);
    expect(audit.records).toMatchObject([
      {
        action: "knowledgeSource.synchronization.rejected",
        outcome: "failed",
        reasonCode: "sourceUnavailable",
      },
    ]);
    expect(store.idempotency).toHaveLength(0);
  });

  it("uses the bounded full-rescan reservation and does not throttle regular synchronization", async () => {
    const { useCase, outbox, audit } = subject();
    const fullRescan = { ...command, kind: "fullRescan" as const };

    await expect(useCase.execute(fullRescan, context())).resolves.toMatchObject(
      {
        status: "queued",
      },
    );
    await expect(
      useCase.execute(
        {
          ...fullRescan,
          idempotencyKeyDigest: digest("d"),
          requestDigest: digest("e"),
        },
        context(),
      ),
    ).resolves.toEqual({ status: "cooldown", replayed: false });
    await expect(
      useCase.execute(
        {
          ...command,
          idempotencyKeyDigest: digest("f"),
          requestDigest: digest("1"),
        },
        context(),
      ),
    ).resolves.toMatchObject({ status: "queued" });
    expect(outbox.envelopes.map((envelope) => envelope.type)).toEqual([
      "knowledge.full-rescan.v2",
      "knowledge.synchronize.v2",
    ]);
    expect(audit.records.at(-1)).toMatchObject({
      action: "knowledgeSource.synchronization.queued",
    });
  });

  it("rejects an unsafe full-rescan cooldown configuration", () => {
    const { store, outbox, audit } = subject();
    expect(
      () =>
        new RequestKnowledgeSourceSynchronization(
          new UnitOfWorkStub(),
          store,
          outbox,
          audit,
          authorization,
          new Ids(),
          clock,
          59_999,
        ),
    ).toThrow("cooldown");
  });
});
