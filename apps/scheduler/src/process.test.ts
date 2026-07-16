import { describe, expect, it, vi } from "vitest";

import { createSchedulerProcess } from "./process.js";

describe("scheduler process", () => {
  it("runs an initial durable poll and prevents overlapping polls", async () => {
    let complete: (() => void) | undefined;
    const runOnce = vi.fn(
      () =>
        new Promise((resolve) => {
          complete = () =>
            resolve({ due: 0, leased: 0, enqueued: 0, duplicate: 0 });
        }),
    );
    const process = createSchedulerProcess({
      runtimes: [{ runOnce }],
      pollIntervalMs: 1_000,
    });

    const starting = process.start();
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalledOnce());
    const concurrent = process.runOnce();
    expect(runOnce).toHaveBeenCalledOnce();
    complete?.();
    await Promise.all([starting, concurrent]);
    await process.stop();
  });

  it("fails startup when the durable scheduler store cannot be polled", async () => {
    const process = createSchedulerProcess({
      runtimes: [
        {
          runOnce: async () => {
            throw new Error("database unavailable");
          },
        },
      ],
    });

    await expect(process.start()).rejects.toThrow("database unavailable");
  });
});
