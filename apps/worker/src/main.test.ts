import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { runWorkerCommand } from "./main.js";

describe("runWorkerCommand", () => {
  it("reports worker health only after a bounded PostgreSQL readiness probe", async () => {
    const output = { error: vi.fn(), log: vi.fn() };
    const readiness = { check: vi.fn(async () => "ready" as const) };

    await expect(
      runWorkerCommand(
        ["health"],
        output,
        { DATABASE_URL: "postgresql://caseweaver:test@localhost/test" },
        readiness,
      ),
    ).resolves.toBe(0);
    expect(readiness.check).toHaveBeenCalledExactlyOnceWith();
    expect(output.log).toHaveBeenCalledWith('{"status":"ok"}');
    expect(output.error).not.toHaveBeenCalled();
  });

  it("fails closed when PostgreSQL readiness is unavailable", async () => {
    const output = { error: vi.fn(), log: vi.fn() };
    await expect(
      runWorkerCommand(
        ["health"],
        output,
        { DATABASE_URL: "postgresql://caseweaver:test@localhost/test" },
        { check: async () => "unavailable" },
      ),
    ).resolves.toBe(1);
    expect(output.error).toHaveBeenCalledWith(
      "Worker database is unavailable.",
    );
    expect(output.log).not.toHaveBeenCalled();
  });

  it("fails closed on production startup when required runtime configuration is absent", () => {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url),
        ),
        fileURLToPath(new URL("./main.ts", import.meta.url)),
        "start",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Worker startup failed.\n");
  });
});
