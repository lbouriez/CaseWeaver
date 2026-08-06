import { describe, expect, it, vi } from "vitest";

import { StandaloneStartupError } from "./index.js";
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
      runStandalone(["migrate-queue"], output, {}, vi.fn(), async () => {
        throw new Error("postgresql://secret@host/database");
      }),
    ).resolves.toBe(1);

    expect(output.error).toHaveBeenCalledWith("Queue migration failed.");
  });

  it("reports only an allow-listed startup configuration outcome", async () => {
    const output = { log: vi.fn(), error: vi.fn() };
    const configurationFailure = new Error(
      "postgresql://caseweaver_runtime:secret@postgres/caseweaver",
    );
    configurationFailure.name = "ObjectStorageConfigurationError";

    await expect(
      runStandalone(["start"], output, {}, async () => {
        throw configurationFailure;
      }),
    ).resolves.toBe(1);

    expect(output.error).toHaveBeenCalledWith(
      "Standalone startup failed (objectStorage.invalidConfiguration).",
    );
    expect(output.error).not.toHaveBeenCalledWith(
      expect.stringContaining("secret"),
    );
  });

  it("reports an owned standalone startup phase without its cause", async () => {
    const output = { log: vi.fn(), error: vi.fn() };

    await expect(
      runStandalone(["start"], output, {}, async () => {
        throw new StandaloneStartupError("worker.compose");
      }),
    ).resolves.toBe(1);

    expect(output.error).toHaveBeenCalledWith(
      "Standalone startup failed (standalone.worker.compose).",
    );
  });
});
