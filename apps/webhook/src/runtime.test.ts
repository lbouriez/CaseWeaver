import { describe, expect, it, vi } from "vitest";

import {
  attachWebhookShutdownSignals,
  createWebhookRuntime,
} from "./runtime.js";

describe("webhook runtime", () => {
  it("closes a partially started server when listen fails", async () => {
    const app = {
      listen: vi.fn(async () => {
        throw new Error("bind failed");
      }),
      close: vi.fn(async () => {}),
    };
    const runtime = createWebhookRuntime({
      app: app as never,
      host: "127.0.0.1",
      port: 8080,
    });

    await expect(runtime.start()).rejects.toThrow("bind failed");
    expect(app.close).toHaveBeenCalledOnce();
  });

  it("uses graceful signal cleanup instead of a forced exit", async () => {
    const app = { listen: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const runtime = createWebhookRuntime({
      app: app as never,
      host: "127.0.0.1",
      port: 8080,
    });
    await runtime.start();
    const listeners = new Map<string, () => void>();
    attachWebhookShutdownSignals(runtime, {
      once: (_signal, listener) => listeners.set(_signal, listener),
      off: vi.fn(),
    });

    listeners.get("SIGINT")?.();
    await vi.waitFor(() => expect(app.close).toHaveBeenCalledOnce());
  });
});
