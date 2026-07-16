import { describe, expect, it, vi } from "vitest";

import { PostgresWorkerReadinessProbe } from "./database-readiness.js";

describe("PostgresWorkerReadinessProbe", () => {
  it("checks only bounded PostgreSQL connectivity", async () => {
    const database = { query: vi.fn(async () => undefined) };
    const probe = new PostgresWorkerReadinessProbe(database, 100);

    await expect(probe.check()).resolves.toBe("ready");
    expect(database.query).toHaveBeenCalledExactlyOnceWith("SELECT 1");
  });

  it("reports a stalled query as unavailable", async () => {
    const database = {
      query: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const probe = new PostgresWorkerReadinessProbe(database, 1);

    await expect(probe.check()).resolves.toBe("unavailable");
  });
});
