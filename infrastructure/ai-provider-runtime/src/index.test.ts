import {
  AiConfigurationError,
  type AiProviderDispatcher,
} from "@caseweaver/ai-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  EnvironmentAiSecretResolver,
  RegisteredAiModelTokenizerResolver,
  RegisteredAiProviderDispatcher,
} from "./index.js";

const binding = {
  workspaceId: "workspace-1",
  providerType: "test-provider",
} as never;

describe("RegisteredAiProviderDispatcher", () => {
  it("routes only to the immutable binding's registered provider type", async () => {
    const generate = vi.fn(async () => ({ value: { text: "ok" } }));
    const dispatcher = new RegisteredAiProviderDispatcher([
      {
        providerType: "test-provider",
        dispatcher: { generate } as unknown as AiProviderDispatcher,
      },
    ]);
    const invocation = {
      binding: { providerType: "test-provider" },
    } as never;

    await expect(dispatcher.generate(invocation)).resolves.toEqual({
      value: { text: "ok" },
    });
    expect(generate).toHaveBeenCalledWith(invocation);
    expect(() =>
      dispatcher.generate({ binding: { providerType: "missing" } } as never),
    ).toThrow(AiConfigurationError);
  });

  it("rejects duplicate or invalid contribution keys", () => {
    const dispatcher = {} as AiProviderDispatcher;
    expect(
      () =>
        new RegisteredAiProviderDispatcher([
          { providerType: "provider", dispatcher },
          { providerType: "provider", dispatcher },
        ]),
    ).toThrow(AiConfigurationError);
    expect(
      () =>
        new RegisteredAiProviderDispatcher([
          { providerType: "not valid", dispatcher },
        ]),
    ).toThrow(AiConfigurationError);
  });
});

describe("EnvironmentAiSecretResolver", () => {
  it("resolves only an allowed opaque environment reference", async () => {
    const resolver = new EnvironmentAiSecretResolver({ PROVIDER_KEY: "value" });
    await expect(
      resolver.resolve("env:PROVIDER_KEY", new AbortController().signal),
    ).resolves.toEqual({ value: "value" });
    await expect(
      resolver.resolve("vault:provider", new AbortController().signal),
    ).rejects.toBeInstanceOf(AiConfigurationError);
  });

  it("does not resolve a secret after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const failure = await new EnvironmentAiSecretResolver({
      PROVIDER_KEY: "must-not-appear",
    })
      .resolve("env:PROVIDER_KEY", controller.signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AiConfigurationError);
    expect(failure).toMatchObject({
      message: "AI execution was cancelled.",
    });
    expect(JSON.stringify(failure)).not.toContain("must-not-appear");
  });

  it("does not expose an unavailable secret locator in its failure", async () => {
    const failure = await new EnvironmentAiSecretResolver({})
      .resolve("env:MISSING_KEY", new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AiConfigurationError);
    expect(failure).toMatchObject({
      message: "The configured AI credential is unavailable.",
    });
    expect(JSON.stringify(failure)).not.toContain("MISSING_KEY");
  });
});

describe("RegisteredAiModelTokenizerResolver", () => {
  it("routes an already retained binding and rejects an unregistered provider", () => {
    const resolver = new RegisteredAiModelTokenizerResolver([
      {
        providerType: "test-provider",
        create: () => ({ count: () => 3 }),
      },
    ]);
    expect(resolver.resolve(binding).count("text")).toBe(3);
    expect(() =>
      resolver.resolve({ ...binding, providerType: "missing" }),
    ).toThrow(AiConfigurationError);
  });
});
