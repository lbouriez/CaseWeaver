import {
  CopilotClient,
  CopilotRequestHandler,
  ToolSet,
  type SessionConfig,
} from "@github/copilot-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  AiConfigurationError,
  AiProviderError,
  type NormalizedUsage,
  type RepositoryAgentMetering,
  type RepositoryAgentRuntimeResult,
  type RepositoryAgentToolGateway,
  type RepositoryReadOnlyTool,
} from "@caseweaver/ai-sdk";

import type { CopilotSdkByokClient, CopilotSdkByokResult } from "./index.js";

const toolNames = ["listFiles", "readFile", "searchFiles"] as const;
const modelOutput = z
  .object({
    summary: z.string().trim().min(1).max(32_000),
    evidence: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1_024),
            startLine: z.number().int().min(1).max(1_000_000),
            endLine: z.number().int().min(1).max(1_000_000),
          })
          .strict()
          .refine((value) => value.endLine >= value.startLine),
      )
      .max(100),
  })
  .strict();
const listFilesInput = z
  .object({
    prefix: z.string().min(1).max(1_024).optional(),
    maximumEntries: z.number().int().min(1).max(1_000).optional(),
  })
  .strict();
const readFileInput = z
  .object({
    path: z.string().min(1).max(1_024),
    startLine: z.number().int().min(1).max(1_000_000).optional(),
    endLine: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.startLine === undefined ||
      value.endLine === undefined ||
      value.endLine >= value.startLine,
  );
const searchFilesInput = z
  .object({
    query: z.string().min(1).max(512),
    prefix: z.string().min(1).max(1_024).optional(),
    maximumResults: z.number().int().min(1).max(500).optional(),
  })
  .strict();

export interface CopilotUsageEvent {
  readonly data: Readonly<{
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly reasoningTokens?: number;
    readonly providerCallId?: string;
  }>;
}

interface CopilotSessionPort {
  sendAndWait(
    input: { readonly prompt: string },
    timeoutMs?: number,
  ): Promise<
    | {
        readonly data: Readonly<{
          readonly content: string;
          readonly apiCallId?: string;
          readonly model?: string;
        }>;
      }
    | undefined
  >;
  on(
    event: "assistant.usage",
    handler: (event: CopilotUsageEvent) => void,
  ): () => void;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

interface CopilotClientPort {
  createSession(config: SessionConfig): Promise<CopilotSessionPort>;
  stop(): Promise<readonly Error[]>;
  forceStop(): Promise<void>;
}

export interface CopilotSdkByokRuntimeClientOptions {
  /** Test seam; production uses the official SDK's process-managed client. */
  readonly createClient?: (
    options: ConstructorParameters<typeof CopilotClient>[0],
  ) => CopilotClientPort;
  readonly createTemporaryDirectory?: () => Promise<string>;
  readonly removeTemporaryDirectory?: (directory: string) => Promise<void>;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}

function safeChildEnvironment(
  temporaryDirectory: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Readonly<Record<string, string>> {
  const path = environment.PATH;
  if (path === undefined || path.length === 0 || /[\r\n\0]/u.test(path)) {
    throw new AiConfigurationError(
      "The Copilot SDK executable path is unavailable.",
    );
  }
  return Object.freeze({
    PATH: path,
    HOME: temporaryDirectory,
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
    NO_COLOR: "1",
  });
}

function validUsage(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AiProviderError("Copilot SDK returned invalid usage.", {
      provider: "copilot-sdk-agent",
    });
  }
  return value;
}

function usage(value: {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}): NormalizedUsage {
  return Object.freeze({
    inputTokens: validUsage(value.inputTokens),
    outputTokens: validUsage(value.outputTokens),
    cacheReadInputTokens: validUsage(value.cacheReadTokens),
    cacheCreationInputTokens: validUsage(value.cacheWriteTokens),
    reasoningTokens: validUsage(value.reasoningTokens),
  });
}

function repositoryTools(gateway: RepositoryAgentToolGateway) {
  const invoke = async (
    tool: RepositoryReadOnlyTool,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown> => {
    try {
      return await gateway.execute(tool, input);
    } catch {
      // A sandbox failure must not reflect command, source, checkout, or secret details
      // back into the SDK's agent transcript.
      throw new Error("The read-only repository tool is unavailable.");
    }
  };
  return [
    {
      name: "listFiles",
      description: "List bounded paths in the pinned repository.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          prefix: { type: "string" },
          maximumEntries: { type: "integer", minimum: 1, maximum: 1_000 },
        },
      },
      skipPermission: true,
      defer: "never" as const,
      handler: async (value: unknown) =>
        invoke("listFiles", listFilesInput.parse(value)),
    },
    {
      name: "readFile",
      description: "Read a bounded line range from a pinned repository file.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string" },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
        },
      },
      skipPermission: true,
      defer: "never" as const,
      handler: async (value: unknown) =>
        invoke("readFile", readFileInput.parse(value)),
    },
    {
      name: "searchFiles",
      description: "Search bounded literal text in the pinned repository only.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string" },
          prefix: { type: "string" },
          maximumResults: { type: "integer", minimum: 1, maximum: 500 },
        },
      },
      skipPermission: true,
      defer: "never" as const,
      handler: async (value: unknown) =>
        invoke("searchFiles", searchFilesInput.parse(value)),
    },
  ];
}

function systemInstruction(): string {
  return [
    "You are a repository investigation agent running in an isolated multi-tenant service.",
    "Use only the supplied read-only repository tools. Do not ask for, access, infer, or disclose credentials, configuration values, environment data, URLs, or source excerpts.",
    "Do not use shell, filesystem, network, Git, MCP, skills, subagents, plugins, or write tools.",
    "Return exactly one JSON object with a concise summary and evidence locations.",
    'Schema: {"summary":"safe concise finding","evidence":[{"path":"relative/file","startLine":1,"endLine":1}]}.',
  ].join("\n");
}

function parseModelOutput(
  value: string,
  maximumOutputBytes: number,
): RepositoryAgentRuntimeResult {
  if (new TextEncoder().encode(value).byteLength > maximumOutputBytes) {
    throw new AiProviderError("Copilot SDK returned an oversized result.", {
      provider: "copilot-sdk-agent",
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AiProviderError("Copilot SDK returned an invalid result.", {
      provider: "copilot-sdk-agent",
    });
  }
  const output = modelOutput.safeParse(parsed);
  if (!output.success) {
    throw new AiProviderError("Copilot SDK returned an invalid result.", {
      provider: "copilot-sdk-agent",
    });
  }
  return Object.freeze({
    summary: output.data.summary,
    evidence: Object.freeze(
      output.data.evidence.map((item) => Object.freeze(item)),
    ),
  });
}

function metering(turns: readonly NormalizedUsage[]): RepositoryAgentMetering {
  if (turns.length === 0) return Object.freeze({ mode: "aggregate" as const });
  return Object.freeze({
    mode: "observableTurns" as const,
    turns: Object.freeze(
      turns.map((turn, index) =>
        Object.freeze({ turn: index + 1, usage: turn }),
      ),
    ),
  });
}

/**
 * The SDK's request interception point is the provider-egress guard. It gives
 * the adapter an enforceable pre-request turn limit instead of discovering an
 * overage from a usage event after an unbudgeted model call has already left
 * the process. It also prevents the agent runtime from reaching a different
 * endpoint even if a malformed SDK/session option attempted to do so.
 */
class PinnedByokRequestHandler extends CopilotRequestHandler {
  private readonly endpoint: URL;
  private requests = 0;

  public constructor(
    endpoint: string,
    private readonly maximumTurns: number,
  ) {
    super();
    this.endpoint = new URL(endpoint);
  }

  protected override async sendRequest(
    request: Request,
    context: { readonly url: string },
  ): Promise<Response> {
    let target: URL;
    try {
      target = new URL(context.url);
    } catch {
      throw new AiProviderError("Copilot SDK provider egress is unavailable.", {
        provider: "copilot-sdk-agent",
      });
    }
    const basePath = this.endpoint.pathname.endsWith("/")
      ? this.endpoint.pathname
      : `${this.endpoint.pathname}/`;
    if (
      target.origin !== this.endpoint.origin ||
      (target.pathname !== this.endpoint.pathname &&
        !target.pathname.startsWith(basePath))
    ) {
      throw new AiProviderError("Copilot SDK provider egress is unavailable.", {
        provider: "copilot-sdk-agent",
      });
    }
    this.requests += 1;
    if (this.requests > this.maximumTurns) {
      throw new AiProviderError("Copilot SDK exceeded its turn limit.", {
        provider: "copilot-sdk-agent",
      });
    }
    return super.sendRequest(
      request,
      context as Parameters<CopilotRequestHandler["sendRequest"]>[1],
    );
  }
}

/**
 * Real BYOK-only bridge to the official Copilot SDK. The SDK process starts in
 * its empty multi-tenant mode with an empty per-run home/work directory and no
 * inherited service credentials. It receives one pinned provider endpoint/key
 * only through the metered provider invocation and exposes only gateway-backed,
 * read-only repository tools.
 */
export class CopilotSdkByokRuntimeClient implements CopilotSdkByokClient {
  private readonly createClient: (
    options: ConstructorParameters<typeof CopilotClient>[0],
  ) => CopilotClientPort;
  private readonly createTemporaryDirectory: () => Promise<string>;
  private readonly removeTemporaryDirectory: (
    directory: string,
  ) => Promise<void>;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;

  public constructor(options: CopilotSdkByokRuntimeClientOptions = {}) {
    this.createClient =
      options.createClient ??
      ((input) => new CopilotClient(input) as unknown as CopilotClientPort);
    this.createTemporaryDirectory =
      options.createTemporaryDirectory ??
      (() => mkdtemp(join(tmpdir(), "caseweaver-copilot-sdk-")));
    this.removeTemporaryDirectory =
      options.removeTemporaryDirectory ??
      ((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 2 }));
    this.environment = options.environment ?? process.env;
  }

  public async run(
    input: Parameters<CopilotSdkByokClient["run"]>[0],
  ): Promise<CopilotSdkByokResult> {
    if (input.signal.aborted) throw input.signal.reason;
    const temporaryDirectory = await this.createTemporaryDirectory();
    let client: CopilotClientPort | undefined;
    let session: CopilotSessionPort | undefined;
    const turns: NormalizedUsage[] = [];
    let requestId: string | undefined;
    let effectiveModel: string | undefined;
    try {
      const requestHandler = new PinnedByokRequestHandler(
        input.baseUrl,
        input.maximumTurns,
      );
      client = this.createClient({
        mode: "empty",
        baseDirectory: temporaryDirectory,
        workingDirectory: temporaryDirectory,
        env: safeChildEnvironment(temporaryDirectory, this.environment),
        useLoggedInUser: false,
        logLevel: "none",
        requestHandler,
      });
      session = await client.createSession({
        clientName: "caseweaver-repository-agent",
        model: input.model,
        provider: {
          type: input.provider,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          wireApi: input.wireApi,
          transport: "http",
          maxPromptTokens: input.maximumInputTokensPerTurn,
          maxOutputTokens: input.maximumOutputTokensPerTurn,
        },
        availableTools: (() => {
          const available = new ToolSet();
          for (const name of toolNames) available.addCustom(name);
          return available.toArray();
        })(),
        tools: repositoryTools(input.tools),
        enableConfigDiscovery: false,
        skipCustomInstructions: true,
        enableSessionTelemetry: false,
        enableSkills: false,
        enableHostGitOperations: false,
        enableSessionStore: false,
        remoteSession: "off",
        infiniteSessions: { enabled: false },
        systemMessage: { mode: "replace", content: systemInstruction() },
      });
      const unsubscribeUsage = session.on("assistant.usage", (event) => {
        const observed = usage(event.data);
        turns.push(observed);
        if (turns.length > input.maximumTurns) {
          void session?.abort().catch(() => undefined);
        }
        requestId ??= event.data.providerCallId;
      });
      const abort = () => {
        void session?.abort().catch(() => undefined);
      };
      input.signal.addEventListener("abort", abort, { once: true });
      try {
        const result = await session.sendAndWait(
          { prompt: input.instruction },
          Math.min(15 * 60_000, Math.max(1_000, input.maximumTurns * 60_000)),
        );
        if (result === undefined) {
          throw new AiProviderError("Copilot SDK returned no result.", {
            provider: "copilot-sdk-agent",
          });
        }
        requestId ??= result.data.apiCallId;
        effectiveModel = result.data.model;
        return Object.freeze({
          ...parseModelOutput(result.data.content, input.maximumOutputBytes),
          metering: metering(turns),
          ...(turns.length === 0 ? {} : { usage: aggregateUsage(turns) }),
          ...(requestId === undefined ? {} : { requestId }),
          ...(effectiveModel === undefined ? {} : { effectiveModel }),
        });
      } finally {
        unsubscribeUsage();
        input.signal.removeEventListener("abort", abort);
      }
    } finally {
      try {
        await session?.disconnect();
      } catch {
        await client?.forceStop().catch(() => undefined);
      }
      try {
        await client?.stop();
      } catch {
        await client?.forceStop().catch(() => undefined);
      }
      await this.removeTemporaryDirectory(temporaryDirectory).catch(
        () => undefined,
      );
    }
  }
}

function aggregateUsage(turns: readonly NormalizedUsage[]): NormalizedUsage {
  const total = (field: keyof NormalizedUsage): number | undefined => {
    const values = turns
      .map((turn) => turn[field])
      .filter((value): value is number => value !== undefined);
    return values.length === 0
      ? undefined
      : values.reduce((sum, value) => sum + value, 0);
  };
  return Object.freeze({
    inputTokens: total("inputTokens"),
    outputTokens: total("outputTokens"),
    cacheReadInputTokens: total("cacheReadInputTokens"),
    cacheCreationInputTokens: total("cacheCreationInputTokens"),
    reasoningTokens: total("reasoningTokens"),
  });
}
