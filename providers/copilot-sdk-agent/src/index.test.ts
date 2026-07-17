import type {
  AiProviderBinding,
  PinnedRepositoryAgentRuntimeResolver,
  ProviderInvocation,
  RepositoryAgentRequest,
  RepositoryAgentRuntimePin,
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
const runtimePin: RepositoryAgentRuntimePin = {
  workspaceId: "workspace-1",
  runtimeVersionId: "runtime-version-1",
  repositoryId: "support-service",
  pinnedCommit: "a".repeat(40),
};

const invocation = (): ProviderInvocation<RepositoryAgentRequest> => ({
  binding,
  secret: { value: "byok-key" },
  request: {
    runtimePin,
    instruction: "Inspect the configured repository.",
    maximumTurns: 2,
    maximumInputTokensPerTurn: 20,
    maximumOutputTokensPerTurn: 10,
  },
  signal: new AbortController().signal,
});

function harness(
  input: {
    readonly resolver?: PinnedRepositoryAgentRuntimeResolver;
    readonly client?: CopilotSdkAgentProviderOptions["client"];
  } = {},
) {
  const resolverPins: RepositoryAgentRuntimePin[] = [];
  const runtimeRequests: unknown[] = [];
  const clientInputs: unknown[] = [];
  const resolver: PinnedRepositoryAgentRuntimeResolver = {
    resolve: async (pin) => {
      resolverPins.push(pin);
      return {
        runtime: {
          repositoryId: "support-service",
          pinnedCommit: "a".repeat(40),
        },
        allowedTools: ["listFiles", "readFile"],
        limits: {
          timeoutMs: 2_000,
          maximumCpuMilliseconds: 2_000,
          maximumMemoryBytes: 2_048,
          maximumOutputBytes: 2_048,
          maximumToolCalls: 4,
        },
        executor: {
          run: async (request, runner) => {
            runtimeRequests.push(request);
            await runner({
              runtime: request.runtime,
              signal: request.signal,
              tools: { execute: async () => ({}) },
            });
            return {
              summary: "The pinned source handles the error.",
              evidence: [
                {
                  id: `repository-evidence-${"a".repeat(64)}`,
                  path: "src/service.ts",
                  startLine: 2,
                  endLine: 3,
                  excerptHash: "b".repeat(64),
                },
              ],
              findings: [
                {
                  id: `repository-finding-${"c".repeat(64)}`,
                  summary: "The pinned source handles the error.",
                  evidenceIds: [`repository-evidence-${"a".repeat(64)}`],
                },
              ],
            };
          },
        },
      };
    },
  };
  const client: CopilotSdkAgentProviderOptions["client"] = {
    run: async (value) => {
      clientInputs.push(value);
      return {
        summary: "The pinned source handles the error.",
        findings: [
          {
            summary: "The pinned source handles the error.",
            citations: [{ path: "src/service.ts", startLine: 2, endLine: 3 }],
          },
        ],
        metering: {
          mode: "observableTurns",
          turns: [{ turn: 1, usage: { inputTokens: 12, outputTokens: 4 } }],
        },
        usage: { inputTokens: 12, outputTokens: 4 },
        requestId: "intentionally-not-returned",
      };
    },
  };
  const options: CopilotSdkAgentProviderOptions = {
    runtimeResolver: input.resolver ?? resolver,
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
    client: input.client ?? client,
    now: () => 10,
  };
  return {
    provider: new CopilotSdkAgentProvider(options),
    resolverPins,
    runtimeRequests,
    clientInputs,
  };
}

describe("CopilotSdkAgentProvider", () => {
  it("uses the required immutable runtime pin and never falls back to a fixed repository", async () => {
    const test = harness();

    await expect(
      test.provider.runRepositoryAgent(invocation()),
    ).resolves.toMatchObject({
      value: { summary: "The pinned source handles the error." },
      usage: { inputTokens: 12, outputTokens: 4 },
      metadata: {
        providerRequestId: "intentionally-not-returned",
        rawRedacted: { evidenceCount: 1, findingCount: 1 },
      },
    });
    expect(test.resolverPins).toEqual([runtimePin]);
    expect(test.runtimeRequests).toEqual([
      expect.objectContaining({
        allowedTools: ["listFiles", "readFile"],
        limits: {
          timeoutMs: 1_000,
          maximumCpuMilliseconds: 1_000,
          maximumMemoryBytes: 1_024,
          maximumOutputBytes: 1_024,
          maximumToolCalls: 3,
        },
      }),
    ]);
    expect(test.clientInputs[0]).toMatchObject({
      provider: "openai",
      baseUrl: "https://models.example/v1",
      apiKey: "byok-key",
      wireApi: "responses",
      maximumAggregateInputTokens: 40,
      maximumAggregateOutputTokens: 20,
    });
    expect(test.clientInputs[0]).not.toHaveProperty("checkoutSecretReference");
    expect(test.clientInputs[0]).not.toHaveProperty("githubToken");
    expect(test.clientInputs[0]).not.toHaveProperty("subscription");
  });

  it("rejects a resolver that returns a different repository or commit before contacting Copilot", async () => {
    const calls: unknown[] = [];
    const test = harness({
      resolver: {
        resolve: async () => ({
          runtime: {
            repositoryId: "different-service",
            pinnedCommit: "b".repeat(40),
          },
          allowedTools: ["readFile"],
          limits: {
            timeoutMs: 1_000,
            maximumCpuMilliseconds: 1_000,
            maximumMemoryBytes: 1_024,
            maximumOutputBytes: 1_024,
            maximumToolCalls: 1,
          },
          executor: {
            run: async () => ({
              summary: "unreachable",
              evidence: [],
              findings: [],
            }),
          },
        }),
      },
      client: {
        run: async (input) => {
          calls.push(input);
          throw new Error("must not call client");
        },
      },
    });

    await expect(
      test.provider.runRepositoryAgent(invocation()),
    ).rejects.toThrow("immutable pinned repository");
    expect(calls).toEqual([]);
  });

  it("rejects unsafe bindings, excessive turns, and unsafe aggregate usage for a pinned invocation", async () => {
    const test = harness();
    await expect(
      test.provider.runRepositoryAgent({
        ...invocation(),
        binding: { ...binding, endpoint: "http://models.example" },
      }),
    ).rejects.toThrow("unsafe");
    await expect(
      test.provider.runRepositoryAgent({
        ...invocation(),
        request: {
          runtimePin,
          instruction: "Inspect.",
          maximumTurns: 4,
          maximumInputTokensPerTurn: 20,
          maximumOutputTokensPerTurn: 10,
        },
      }),
    ).rejects.toThrow("turn limit");

    const testWithExcessUsage = harness({
      client: {
        run: async () => ({
          summary: "Bound exceeded.",
          findings: [],
          metering: {
            mode: "observableTurns",
            turns: [{ turn: 1, usage: { inputTokens: 51, outputTokens: 1 } }],
          },
          usage: { inputTokens: 51, outputTokens: 1 },
        }),
      },
    });
    await expect(
      testWithExcessUsage.provider.runRepositoryAgent(invocation()),
    ).rejects.toMatchObject({ code: "ai.provider" });
  });
});
