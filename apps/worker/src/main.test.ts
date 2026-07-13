import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { runWorkerCommand } from "./main.js";

describe("runWorkerCommand", () => {
  it("reports worker health without initializing job infrastructure", () => {
    const output = { error: vi.fn(), log: vi.fn() };

    expect(runWorkerCommand(["health"], output)).toBe(0);
    expect(output.log).toHaveBeenCalledWith('{"status":"ok"}');
    expect(output.error).not.toHaveBeenCalled();
  });

  it("rejects unsupported commands through the executable entry point", () => {
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
    expect(result.stderr).toBe("Usage: caseweaver-worker health\n");
  });
});
