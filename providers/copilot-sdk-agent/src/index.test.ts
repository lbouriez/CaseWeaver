import type {
  AiProviderBinding,
  ProviderInvocation,
  RepositoryAgentRequest,
} from "@caseweaver/ai-sdk";
import { describe, expect, it } from "vitest";

import {
  CopilotSdkAgentProvider,
  type CopilotSdkAgentProviderOptions,
} from "./index.js";

const binding: AiProviderBinding = {
  bindingVersionId: "binding-1",
  providerInstanceVersionId: "provider-1",
  providerType: "copilot-sdk-agent",
  endpoint: "https://models.example/v1",
  canonicalModel: "byok-model",
  wireApi: "responses",
  parameters: {},
  capabilities: new Set(["repositoryAgent", "tools"]),
  secretReference: "vault:models",
};
const invocation = (): ProviderInvocation<RepositoryAgentRequest> => ({
  binding,
  secret: { value: "byok-key" },
  request: {
    instruction: "Inspect the configured repository.",
    maximumTurns: 2,
    maximumInputTokensPerTurn: 20,
    maximumOutputTokensPerTurn: 10,
  },
  signal: new AbortController().signal,
});

function options(): CopilotSdkAgentProviderOptions {
  return {
    repository: {
      repositoryId: "support-service",
      checkoutSecretReference: "vault:checkout/support-service",
      pinnedCommit: "a".repeat(40),
    },
    limits: {
      maximumTurns: 3,
      maximumCpuMilliseconds: 1_000,
      maximumMemoryBytes: 1_024,
      maximumOutputBytes: 1_024,
      maximumToolCalls: 3,
      timeoutMs: 1_000,
      maximumAggregateInputTokens: 50,
      maximumAggregateOutputTokens: 20,
    },
    runtime: {
      run: async (_request, runner) =>
        runner({
          repositoryId: "support-service",
          pinnedCommit: "a".repeat(40),
          tools: { execute: async () => ({}) },
        }),
    },
    client: {
      run: async () => ({
        summary: "The pinned source handles the error.",
        evidence: [{ path: "src/service.ts", startLine: 2, endLine: 3 }],
        metering: { mode: "aggregate" },
        usage: { inputTokens: 12, outputTokens: 4 },
        requestId: "intentionally-not-returned",
      }),
    },
    now: () => 10,
  };
}

describe("CopilotSdkAgentProvider", () => {
  it("uses the injected runtime and BYOK-only OpenAI configuration", async () => {
    const input: unknown[] = [];
    const configured = options();
    configured.client = {
      run: async (value) => {
        input.push(value);
        return {
          summary: "The pinned source handles the error.",
          evidence: [{ path: "src/service.ts", startLine: 2, endLine: 3 }],
          metering: { mode: "aggregate" },
          usage: { inputTokens: 12, outputTokens: 4 },
          requestId: "intentionally-not-returned",
        };
      },
    };
    const provider = new CopilotSdkAgentProvider(configured);

    await expect(
      provider.runRepositoryAgent(invocation()),
    ).resolves.toMatchObject({
      value: { summary: "The pinned source handles the error." },
      usage: { inputTokens: 12, outputTokens: 4 },
      metadata: {
        providerRequestId: "intentionally-not-returned",
        rawRedacted: { evidenceCount: 1 },
      },
    });
    expect(input[0]).toMatchObject({
      provider: "openai",
      baseUrl: "https://models.example/v1",
      apiKey: "byok-key",
      wireApi: "responses",
      maximumAggregateInputTokens: 40,
      maximumAggregateOutputTokens: 20,
    });
    expect(input[0]).not.toHaveProperty("githubToken");
    expect(input[0]).not.toHaveProperty("subscription");
  });

  it("rejects unsafe bindings, excessive turns, and unsafe aggregate usage", async () => {
    const provider = new CopilotSdkAgentProvider(options());
    await expect(
      provider.runRepositoryAgent({
        ...invocation(),
        binding: { ...binding, endpoint: "http://models.example" },
      }),
    ).rejects.toThrow("unsafe");
    await expect(
      provider.runRepositoryAgent({
        ...invocation(),
        request: {
          instruction: "Inspect.",
          maximumTurns: 4,
          maximumInputTokensPerTurn: 20,
          maximumOutputTokensPerTurn: 10,
        },
      }),
    ).rejects.toThrow("turn limit");

    const configured = options();
    configured.client = {
      run: async () => ({
        summary: "Bound exceeded.",
        evidence: [],
        metering: { mode: "aggregate" },
        usage: { inputTokens: 51 },
      }),
    };
    await expect(
      new CopilotSdkAgentProvider(configured).runRepositoryAgent(invocation()),
    ).rejects.toMatchObject({ code: "ai.provider" });
  });
});
