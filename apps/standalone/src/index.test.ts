import type {
  ApplicationTransaction,
  ClaimedOutboxEnvelope,
  OutboxStore,
  UnitOfWork,
} from "@caseweaver/application";
import {
  causationId,
  correlationId,
  createEnvelope,
  type Envelope,
  outboxEnvelopeId,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { describe, expect, it, vi } from "vitest";

import {
  createStandaloneRuntime,
  type DurableEnvelopeConsumer,
  type DurableQueueRuntime,
  type ManagedProcess,
} from "./index.js";

const envelope = createEnvelope({
  id: outboxEnvelopeId("1b279899-f02d-47c5-8bdc-6b447ed3ae0c"),
  kind: "command",
  type: "knowledge.synchronize.v2",
  schemaVersion: 1,
  workspaceId: workspaceId("workspace-1"),
  occurredAt: utcInstant("2026-07-14T18:00:00.000Z"),
  correlationId: correlationId("correlation-1"),
  causationId: causationId("causation-1"),
  payload: {
    sourceId: "source-1",
    sourceConfigurationVersionId: "source-version-1",
    connectorConfigurationVersionId: "connector-version-1",
    trigger: "manual",
  },
});

class RecordingQueue implements DurableQueueRuntime {
  public readonly events: string[] = [];
  public readonly published: Envelope[] = [];
  public consumer: DurableEnvelopeConsumer | undefined;

  public async start(): Promise<void> {
    this.events.push("queue.start");
  }

  public async stop(): Promise<void> {
    this.events.push("queue.stop");
  }

  public async publish(message: Envelope): Promise<void> {
    this.events.push("queue.publish");
    this.published.push(message);
  }

  public async work(consumer: DurableEnvelopeConsumer): Promise<string> {
    this.events.push("queue.work");
    this.consumer = consumer;
    return "worker-subscription";
  }
}

function process(name: string, events: string[]): ManagedProcess {
  return {
    start: async () => {
      events.push(`${name}.start`);
    },
    stop: async () => {
      events.push(`${name}.stop`);
    },
  };
}

function outbox(claims: readonly ClaimedOutboxEnvelope[]): {
  readonly store: OutboxStore;
  readonly acknowledgements: ClaimedOutboxEnvelope[];
} {
  const acknowledgements: ClaimedOutboxEnvelope[] = [];
  return {
    store: {
      append: async () => {},
      claim: async () => claims,
      acknowledge: async (_transaction, claim) => {
        acknowledgements.push(claim);
      },
    },
    acknowledgements,
  };
}

const unitOfWork: UnitOfWork = {
  transaction: async (operation) => operation({} as ApplicationTransaction),
};

describe("standalone composition", () => {
  it("uses the same durable queue for the outbox relay and normal worker consumer", async () => {
    const events: string[] = [];
    const queue = new RecordingQueue();
    const claimed: ClaimedOutboxEnvelope = {
      envelope,
      claimToken: "claim-1",
    };
    const relay = outbox([claimed]);
    const worker = { consume: vi.fn(async () => {}) };
    const runtime = createStandaloneRuntime({
      unitOfWork,
      outbox: relay.store,
      clock: { now: () => utcInstant("2026-07-14T18:00:01.000Z") },
      queue,
      worker,
      api: process("api", events),
      webhook: process("webhook", events),
      scheduler: process("scheduler", events),
      relayPollIntervalMs: 1_000,
    });

    await runtime.start();
    await runtime.stop();

    expect(queue.consumer).toBe(worker);
    expect(worker.consume).not.toHaveBeenCalled();
    expect(queue.published).toEqual([envelope]);
    expect(relay.acknowledgements).toEqual([claimed]);
    expect(queue.events).toEqual([
      "queue.start",
      "queue.work",
      "queue.publish",
      "queue.stop",
    ]);
    expect(events).toEqual([
      "scheduler.start",
      "api.start",
      "webhook.start",
      "webhook.stop",
      "api.stop",
      "scheduler.stop",
    ]);
  });

  it("cleans up the durable queue when a colocated process cannot start", async () => {
    const queue = new RecordingQueue();
    const relay = outbox([]);
    const worker = { consume: async () => {} };
    const webhook: ManagedProcess = {
      start: async () => {
        throw new Error("webhook bind failed");
      },
      stop: async () => {},
    };
    const runtime = createStandaloneRuntime({
      unitOfWork,
      outbox: relay.store,
      clock: { now: () => utcInstant("2026-07-14T18:00:01.000Z") },
      queue,
      worker,
      api: { start: async () => {}, stop: async () => {} },
      webhook,
      scheduler: { start: async () => {}, stop: async () => {} },
    });

    await expect(runtime.start()).rejects.toThrow("webhook bind failed");
    expect(queue.events).toEqual(["queue.start", "queue.work", "queue.stop"]);
  });
});
