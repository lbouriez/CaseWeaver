import { describe, expect, it, vi } from "vitest";

import { PostgresDatabaseReadinessProbe } from "./database-readiness.js";

describe("PostgresDatabaseReadinessProbe", () => {
  it("uses only SELECT 1 for a successful check", async () => {
    const database = {
      query: vi.fn(async () => undefined),
    };
    const probe = new PostgresDatabaseReadinessProbe(database, 100);

    await expect(probe.check()).resolves.toBe("ready");
    expect(database.query).toHaveBeenCalledExactlyOnceWith("SELECT 1");
  });

  it("bounds a stalled check and reports it as unavailable", async () => {
    const database = {
      query: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const probe = new PostgresDatabaseReadinessProbe(database, 1);

    await expect(probe.check()).resolves.toBe("unavailable");
    expect(database.query).toHaveBeenCalledExactlyOnceWith("SELECT 1");
  });
});
