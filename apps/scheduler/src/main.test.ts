import { describe, expect, it, vi } from "vitest";

import { runSchedulerCommand } from "./main.js";

describe("runSchedulerCommand", () => {
  it("reports scheduler health only after its bounded database probe", async () => {
    const output = { error: vi.fn(), log: vi.fn() };
    const readiness = { check: vi.fn(async () => "ready" as const) };

    await expect(
      runSchedulerCommand(
        ["health"],
        output,
        { DATABASE_URL: "postgresql://scheduler:test@localhost/test" },
        readiness,
      ),
    ).resolves.toBe(0);

    expect(readiness.check).toHaveBeenCalledExactlyOnceWith();
    expect(output.log).toHaveBeenCalledWith('{"status":"ok"}');
    expect(output.error).not.toHaveBeenCalled();
  });

  it("fails closed without a database URL", async () => {
    const output = { error: vi.fn(), log: vi.fn() };

    await expect(runSchedulerCommand(["health"], output, {})).resolves.toBe(1);
    expect(output.error).toHaveBeenCalledWith(
      "Scheduler database is unavailable.",
    );
    expect(output.log).not.toHaveBeenCalled();
  });
});
