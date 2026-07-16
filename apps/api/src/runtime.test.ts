import { describe, expect, it, vi } from "vitest";

import { attachApiShutdownSignals, createApiRuntime } from "./runtime.js";

function app(input: { readonly listen?: () => Promise<void> } = {}) {
  return {
    listen: vi.fn(input.listen ?? (async () => {})),
    close: vi.fn(async () => {}),
  };
}

describe("API runtime", () => {
  it("closes transport resources when binding fails", async () => {
    const server = app({
      listen: async () => {
        throw new Error("address unavailable");
      },
    });
    const runtime = createApiRuntime({
      app: server as never,
      host: "127.0.0.1",
      port: 3000,
    });

    await expect(runtime.start()).rejects.toThrow("address unavailable");
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("stops through a signal without forcing a process exit", async () => {
    const server = app();
    const runtime = createApiRuntime({
      app: server as never,
      host: "127.0.0.1",
      port: 3000,
    });
    await runtime.start();
    const listeners = new Map<string, () => void>();
    const process = {
      once: vi.fn((signal: string, listener: () => void) => {
        listeners.set(signal, listener);
      }),
      off: vi.fn(),
    };
    attachApiShutdownSignals(runtime, process as never);

    listeners.get("SIGTERM")?.();
    await vi.waitFor(() => expect(server.close).toHaveBeenCalledOnce());

    expect(process.once).toHaveBeenCalledTimes(2);
  });
});
