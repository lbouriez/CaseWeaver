import { describe, expect, it, vi } from "vitest";

import { runStandalone } from "./main.js";

describe("standalone command", () => {
  it("runs the durable queue migration without starting runtime processes", async () => {
    const output = { log: vi.fn(), error: vi.fn() };
    const migrateQueue = vi.fn(async () => {});
    const createRuntime = vi.fn();

    await expect(
      runStandalone(
        ["migrate-queue"],
        output,
        { DATABASE_URL: "postgresql://caseweaver@postgres:5432/caseweaver" },
        createRuntime,
        migrateQueue,
      ),
    ).resolves.toBe(0);

    expect(migrateQueue).toHaveBeenCalledOnce();
    expect(createRuntime).not.toHaveBeenCalled();
    expect(output.log).toHaveBeenCalledWith("Queue migration completed.");
  });

  it("redacts a queue migration failure", async () => {
    const output = { log: vi.fn(), error: vi.fn() };

    await expect(
      runStandalone(
        ["migrate-queue"],
        output,
        {},
        vi.fn(),
        async () => {
          throw new Error("postgresql://secret@host/database");
        },
      ),
    ).resolves.toBe(1);

    expect(output.error).toHaveBeenCalledWith("Queue migration failed.");
  });
});
