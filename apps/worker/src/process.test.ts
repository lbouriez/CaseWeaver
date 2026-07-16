import { describe, expect, it, vi } from "vitest";

import { createWorkerProcess } from "./process.js";

describe("worker process", () => {
  it("starts one durable queue consumer and relays through that queue lifecycle", async () => {
    const events: string[] = [];
    const queue = {
      start: vi.fn(async () => {
        events.push("queue.start");
      }),
      stop: vi.fn(async () => {
        events.push("queue.stop");
      }),
      work: vi.fn(async () => {
        events.push("queue.work");
        return "subscription";
      }),
    };
    const relay = {
      runOnce: vi.fn(async () => {
        events.push("relay.run");
        return { delivered: 0 };
      }),
    };
    const dispatch = vi.fn(async () => {});
    const worker = createWorkerProcess({
      queue,
      dispatcher: { dispatch },
      relay,
      relayPollIntervalMs: 1_000,
    });

    await worker.start();
    await worker.stop();

    expect(queue.work).toHaveBeenCalledOnce();
    expect(relay.runOnce).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    expect(events).toEqual([
      "queue.start",
      "queue.work",
      "relay.run",
      "queue.stop",
    ]);
  });

  it("stops the queue if initial relay startup fails", async () => {
    const queue = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      work: vi.fn(async () => "subscription"),
    };
    const worker = createWorkerProcess({
      queue,
      dispatcher: { dispatch: async () => {} },
      relay: {
        runOnce: async () => {
          throw new Error("outbox unavailable");
        },
      },
    });

    await expect(worker.start()).rejects.toThrow("outbox unavailable");
    expect(queue.stop).toHaveBeenCalledOnce();
  });

  it("does not overlap relay polls and drains an active relay before stopping the queue", async () => {
    let resolveActiveRelay:
      | ((value: Readonly<{ readonly delivered: number }>) => void)
      | undefined;
    const queue = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      work: vi.fn(async () => "subscription"),
    };
    const relay = {
      runOnce: vi
        .fn<() => Promise<Readonly<{ readonly delivered: number }>>>()
        .mockResolvedValueOnce({ delivered: 0 })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveActiveRelay = resolve;
            }),
        ),
    };
    const worker = createWorkerProcess({
      queue,
      dispatcher: { dispatch: async () => {} },
      relay,
    });

    await worker.start();
    const activeRelay = worker.runRelayOnce();
    const overlappingRelay = worker.runRelayOnce();
    expect(relay.runOnce).toHaveBeenCalledTimes(2);

    const stopping = worker.stop();
    await Promise.resolve();
    expect(queue.stop).not.toHaveBeenCalled();

    resolveActiveRelay?.({ delivered: 1 });
    await Promise.all([activeRelay, overlappingRelay, stopping]);

    expect(queue.stop).toHaveBeenCalledOnce();
  });
});
