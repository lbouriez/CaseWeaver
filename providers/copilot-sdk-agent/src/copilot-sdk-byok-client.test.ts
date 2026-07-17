import type { SessionConfig } from "@github/copilot-sdk";
import { describe, expect, it } from "vitest";

import {
  CopilotSdkByokRuntimeClient,
  type CopilotUsageEvent,
} from "./copilot-sdk-byok-client.js";

describe("CopilotSdkByokRuntimeClient", () => {
  it("uses the official SDK in isolated BYOK mode with only gateway-backed repository tools", async () => {
    let configuration: SessionConfig | undefined;
    let usageHandler: ((event: CopilotUsageEvent) => void) | undefined;
    const toolCalls: unknown[] = [];
    const cleaned: string[] = [];
    const client = new CopilotSdkByokRuntimeClient({
      environment: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        DATABASE_URL: "postgresql://must-not-reach-sdk",
        API_SESSION_SIGNING_SECRET: "must-not-reach-sdk",
      },
      createTemporaryDirectory: async () => "/tmp/caseweaver-copilot-test",
      removeTemporaryDirectory: async (directory) => {
        cleaned.push(directory);
      },
      createClient: (options) => {
        expect(options).toMatchObject({
          mode: "empty",
          baseDirectory: "/tmp/caseweaver-copilot-test",
          workingDirectory: "/tmp/caseweaver-copilot-test",
          useLoggedInUser: false,
          logLevel: "none",
          env: {
            PATH: "/usr/local/bin:/usr/bin:/bin",
            HOME: "/tmp/caseweaver-copilot-test",
          },
        });
        expect(options?.env).not.toHaveProperty("DATABASE_URL");
        expect(options?.env).not.toHaveProperty("API_SESSION_SIGNING_SECRET");
        return {
          createSession: async (value) => {
            configuration = value;
            return {
              on: (_event, handler) => {
                usageHandler = handler;
                return () => undefined;
              },
              sendAndWait: async () => {
                const readFile = value.tools?.find(
                  (tool) => tool.name === "readFile",
                );
                await readFile?.handler?.({
                  path: "src/service.ts",
                  startLine: 2,
                  endLine: 3,
                });
                usageHandler?.({
                  data: {
                    inputTokens: 12,
                    outputTokens: 4,
                    providerCallId: "request-1",
                  },
                });
                return {
                  data: {
                    apiCallId: "request-1",
                    model: "byok-model",
                    content:
                      '{"summary":"Pinned source handles the failure.","findings":[{"summary":"Pinned source handles the failure.","citations":[{"path":"src/service.ts","startLine":2,"endLine":3}]}]}',
                  },
                };
              },
              abort: async () => undefined,
              disconnect: async () => undefined,
            };
          },
          stop: async () => [],
          forceStop: async () => undefined,
        };
      },
    });

    await expect(
      client.run({
        provider: "openai",
        baseUrl: "https://models.example/v1",
        apiKey: "test-key",
        model: "byok-model",
        wireApi: "responses",
        instruction: "Investigate this pinned repository.",
        maximumTurns: 2,
        maximumInputTokensPerTurn: 100,
        maximumOutputTokensPerTurn: 50,
        maximumAggregateInputTokens: 200,
        maximumAggregateOutputTokens: 100,
        maximumOutputBytes: 4_096,
        tools: {
          execute: async (tool, input) => {
            toolCalls.push({ tool, input });
            return { path: "src/service.ts", startLine: 2, endLine: 3 };
          },
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      summary: "Pinned source handles the failure.",
      findings: [
        {
          summary: "Pinned source handles the failure.",
          citations: [{ path: "src/service.ts", startLine: 2, endLine: 3 }],
        },
      ],
      metering: {
        mode: "observableTurns",
        turns: [{ turn: 1, usage: { inputTokens: 12, outputTokens: 4 } }],
      },
      requestId: "request-1",
      effectiveModel: "byok-model",
    });

    expect(configuration).toMatchObject({
      model: "byok-model",
      provider: {
        type: "openai",
        baseUrl: "https://models.example/v1",
        wireApi: "responses",
        maxPromptTokens: 100,
        maxOutputTokens: 50,
      },
      availableTools: [
        "custom:listFiles",
        "custom:readFile",
        "custom:searchFiles",
      ],
      enableConfigDiscovery: false,
      enableSkills: false,
      enableHostGitOperations: false,
      enableSessionStore: false,
      remoteSession: "off",
    });
    expect(configuration?.tools?.map((tool) => tool.name)).toEqual([
      "listFiles",
      "readFile",
      "searchFiles",
    ]);
    expect(toolCalls).toEqual([
      {
        tool: "readFile",
        input: { path: "src/service.ts", startLine: 2, endLine: 3 },
      },
    ]);
    expect(cleaned).toEqual(["/tmp/caseweaver-copilot-test"]);
  });

  it("rejects malformed agent output without reflecting it into an error", async () => {
    const client = new CopilotSdkByokRuntimeClient({
      environment: { PATH: "/usr/bin" },
      createTemporaryDirectory: async () => "/tmp/caseweaver-copilot-invalid",
      removeTemporaryDirectory: async () => undefined,
      createClient: () => ({
        createSession: async () => ({
          on: () => () => undefined,
          sendAndWait: async () => ({
            data: { content: '{"summary":"secret-value","unexpected":true}' },
          }),
          abort: async () => undefined,
          disconnect: async () => undefined,
        }),
        stop: async () => [],
        forceStop: async () => undefined,
      }),
    });

    await expect(
      client.run({
        provider: "openai",
        baseUrl: "https://models.example/v1",
        apiKey: "test-key",
        model: "byok-model",
        wireApi: "completions",
        instruction: "Investigate.",
        maximumTurns: 1,
        maximumInputTokensPerTurn: 10,
        maximumOutputTokensPerTurn: 10,
        maximumAggregateInputTokens: 10,
        maximumAggregateOutputTokens: 10,
        maximumOutputBytes: 512,
        tools: { execute: async () => ({}) },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Copilot SDK returned an invalid result.");
  });
});
