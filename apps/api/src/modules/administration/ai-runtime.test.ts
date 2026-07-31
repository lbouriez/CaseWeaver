import { describe, expect, it } from "vitest";

import { providerCapabilityTestTemplates } from "./ai-runtime.js";

describe("provider capability-test templates", () => {
  it("tests the immutable configured protocol mode instead of assuming chat", async () => {
    const templates = providerCapabilityTestTemplates();

    const embedding = await templates.load({
      providerType: "openai-compatible",
      testOperation: "provider.test",
      wireApi: "embeddings",
    });
    const chat = await templates.load({
      providerType: "openai-compatible",
      testOperation: "provider.test",
      wireApi: "chatCompletions",
    });

    expect(embedding?.request).toMatchObject({
      kind: "embedding",
      role: "embedding",
      request: { input: ["CaseWeaver provider capability test."] },
    });
    expect(chat?.request).toMatchObject({
      kind: "generation",
      role: "analysis",
    });
    expect(embedding?.templateDigest).not.toBe(chat?.templateDigest);
  });

  it("does not manufacture a template for an unregistered provider", async () => {
    await expect(
      providerCapabilityTestTemplates().load({
        providerType: "unregistered-provider",
        testOperation: "provider.test",
        wireApi: "embeddings",
      }),
    ).resolves.toBeUndefined();
  });
});
