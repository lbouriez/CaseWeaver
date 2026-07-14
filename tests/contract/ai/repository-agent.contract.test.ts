import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

async function source(...segments: string[]): Promise<string> {
  return readFile(resolve(process.cwd(), ...segments), "utf8");
}

describe("Repository-agent contract boundaries", () => {
  it("keeps the shared runtime and metering contracts provider-neutral", async () => {
    const [contracts, runtimeContract, provider, runtime] = await Promise.all([
      source("packages", "ai-sdk", "src", "contracts.ts"),
      source("packages", "ai-sdk", "src", "repository-agent.ts"),
      source("providers", "copilot-sdk-agent", "src", "index.ts"),
      source("infrastructure", "repository-runtime", "src", "index.ts"),
    ]);

    expect(contracts).toMatch(/maximumInputTokensPerTurn/);
    expect(contracts).toMatch(/observableTurns/);
    expect(runtimeContract).toMatch(/interface RepositoryAgentRuntime/);
    expect(provider).not.toMatch(
      /@caseweaver\/ai-config|@caseweaver\/ai-execution/,
    );
    expect(runtime).not.toMatch(/copilot-sdk-agent|openai-compatible/);
  });
});
