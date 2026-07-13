import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { OpenAiCompatibleProvider } from "../../../providers/openai-compatible/src/index.js";

describe("OpenAI-compatible AI provider contract", () => {
  it("exposes the SDK provider methods without importing configuration or execution policy", async () => {
    const source = await readFile(
      resolve(
        process.cwd(),
        "providers",
        "openai-compatible",
        "src",
        "index.ts",
      ),
      "utf8",
    );
    const provider = new OpenAiCompatibleProvider({
      fetch: async () => new Response("{}", { status: 200 }),
    });

    expect(typeof provider.embed).toBe("function");
    expect(typeof provider.analyzeVision).toBe("function");
    expect(typeof provider.generate).toBe("function");
    expect(source).not.toMatch(
      /@caseweaver\/ai-config|@caseweaver\/ai-execution/,
    );
  });
});
