import { describe, expect, it, vi } from "vitest";

import { PostgresSchedulerReadinessProbe } from "./database-readiness.js";

describe("PostgresSchedulerReadinessProbe", () => {
  it("reports ready after a bounded non-mutating query", async () => {
    const query = vi.fn(async () => undefined);
    const probe = new PostgresSchedulerReadinessProbe({ query }, 1_000);

    await expect(probe.check()).resolves.toBe("ready");
    expect(query).toHaveBeenCalledExactlyOnceWith("SELECT 1");
  });

  it("fails closed when PostgreSQL cannot be reached", async () => {
    const probe = new PostgresSchedulerReadinessProbe(
      { query: async () => Promise.reject(new Error("connection refused")) },
      1_000,
    );

    await expect(probe.check()).resolves.toBe("unavailable");
  });
});
