import { describe, expect, it, vi } from "vitest";

import { attachStandaloneShutdownSignals } from "./process.js";

describe("standalone process signals", () => {
  it("stops the composed runtime without force-exiting", async () => {
    const runtime = { start: async () => {}, stop: vi.fn(async () => {}) };
    const listeners = new Map<string, () => void>();
    attachStandaloneShutdownSignals(runtime, {
      once: (signal, listener) => listeners.set(signal, listener),
      off: vi.fn(),
    });

    listeners.get("SIGTERM")?.();
    await vi.waitFor(() => expect(runtime.stop).toHaveBeenCalledOnce());
  });
});
