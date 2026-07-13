import {
  ConnectorCancelledError,
  ConnectorConfigurationError,
  ConnectorProtocolError,
  ConnectorRemoteError,
  type ConnectorSecretResolver,
} from "@caseweaver/connector-sdk";
import type { z } from "zod";

import {
  type JitbitConfiguration,
  jitbitConfigurationSchema,
} from "./config.js";
import {
  jitbitCommentsSchema,
  jitbitPostCommentResponseSchema,
  jitbitTicketSchema,
  jitbitTicketSummariesSchema,
  type JitbitComment,
  type JitbitTicket,
  type JitbitTicketSummary,
} from "./schemas.js";

const maximumReadAttempts = 3;

export interface JitbitClientOptions {
  readonly configuration: JitbitConfiguration;
  readonly secrets: ConnectorSecretResolver;
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

interface RequestOptions<TResponse> {
  readonly operation: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly method: "GET" | "POST";
  readonly body?: URLSearchParams;
  readonly responseSchema: z.ZodType<TResponse>;
  readonly signal: AbortSignal;
  readonly safeRead: boolean;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ConnectorCancelledError();
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : Math.max(0, time - Date.now());
}

function requestCorrelation(response: Response): string | undefined {
  return (
    response.headers.get("x-request-id") ??
    response.headers.get("request-id") ??
    undefined
  );
}

function sleepFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ConnectorCancelledError());
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new ConnectorCancelledError());
      },
      { once: true },
    );
  });
}

function remoteError(
  response: Response,
  operation: string,
  connectorInstanceId: string,
  safeRead: boolean,
): ConnectorRemoteError {
  const requestId = requestCorrelation(response);
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  if (response.status === 401) {
    return new ConnectorRemoteError("Jitbit authentication failed.", {
      category: "authentication",
      statusCode: response.status,
      operation,
      connectorInstanceId,
      requestId,
    });
  }
  if (response.status === 403) {
    return new ConnectorRemoteError("Jitbit authorization was denied.", {
      category: "authorization",
      statusCode: response.status,
      operation,
      connectorInstanceId,
      requestId,
    });
  }
  if (response.status === 429) {
    return new ConnectorRemoteError("Jitbit rate limited the request.", {
      category: "rateLimit",
      retryable: safeRead,
      retryAfterMs,
      statusCode: response.status,
      operation,
      connectorInstanceId,
      requestId,
    });
  }
  return new ConnectorRemoteError("Jitbit returned an unsuccessful response.", {
    category: "remote",
    retryable: safeRead && response.status >= 500,
    retryAfterMs,
    statusCode: response.status,
    operation,
    connectorInstanceId,
    requestId,
  });
}

export class JitbitClient {
  private readonly configuration: JitbitConfiguration;
  private readonly secrets: ConnectorSecretResolver;
  private readonly fetchImplementation: typeof fetch;
  private readonly sleep: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private readonly random: () => number;

  public constructor(options: JitbitClientOptions) {
    this.configuration = jitbitConfigurationSchema.parse(options.configuration);
    this.secrets = options.secrets;
    this.fetchImplementation = options.fetch ?? fetch;
    this.sleep = options.sleep ?? sleepFor;
    this.random = options.random ?? Math.random;
  }

  public async getTicketSummaries(input: {
    readonly count: number;
    readonly offset: number;
    readonly updatedFrom?: string;
    readonly signal: AbortSignal;
  }): Promise<readonly JitbitTicketSummary[]> {
    return this.request({
      operation: "listTickets",
      path: "/api/Tickets",
      method: "GET",
      query: {
        count: input.count,
        offset: input.offset,
        updatedFrom: input.updatedFrom,
      },
      responseSchema: jitbitTicketSummariesSchema,
      signal: input.signal,
      safeRead: true,
    });
  }

  public async getTicket(input: {
    readonly id: string;
    readonly signal: AbortSignal;
  }): Promise<JitbitTicket> {
    return this.request({
      operation: "getTicket",
      path: "/api/ticket",
      method: "GET",
      query: { id: input.id },
      responseSchema: jitbitTicketSchema,
      signal: input.signal,
      safeRead: true,
    });
  }

  public async getComments(input: {
    readonly id: string;
    readonly signal: AbortSignal;
  }): Promise<readonly JitbitComment[]> {
    return this.request({
      operation: "getComments",
      path: "/api/comments",
      method: "GET",
      query: { id: input.id },
      responseSchema: jitbitCommentsSchema,
      signal: input.signal,
      safeRead: true,
    });
  }

  public async postInternalComment(input: {
    readonly id: string;
    readonly body: string;
    readonly signal: AbortSignal;
  }): Promise<string> {
    return this.request({
      operation: "postComment",
      path: "/api/comment",
      method: "POST",
      body: new URLSearchParams({
        id: input.id,
        body: input.body,
        forTechsOnly: "true",
      }),
      responseSchema: jitbitPostCommentResponseSchema,
      signal: input.signal,
      safeRead: false,
    });
  }

  private async request<TResponse>(
    options: RequestOptions<TResponse>,
  ): Promise<TResponse> {
    const settings = this.configuration.settings;
    const secretReference =
      this.configuration.secrets[settings.apiTokenSecretName];
    if (secretReference === undefined) {
      throw new ConnectorConfigurationError(
        "The configured Jitbit API token secret reference is missing.",
        { connectorInstanceId: settings.connectorInstanceId },
      );
    }

    let lastError: ConnectorRemoteError | undefined;
    for (let attempt = 1; attempt <= maximumReadAttempts; attempt += 1) {
      throwIfAborted(options.signal);
      const resolved = await this.secrets.resolve(
        secretReference,
        options.signal,
      );
      throwIfAborted(options.signal);
      if (resolved.value.length === 0) {
        throw new ConnectorConfigurationError(
          "The configured Jitbit API token resolved to an empty value.",
          { connectorInstanceId: settings.connectorInstanceId },
        );
      }

      const timeout = AbortSignal.timeout(settings.requestTimeoutMs);
      const signal = AbortSignal.any([options.signal, timeout]);
      const url = new URL(options.path, `${settings.baseUrl}/`);
      for (const [name, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined) url.searchParams.set(name, String(value));
      }

      try {
        const response = await this.fetchImplementation(url, {
          method: options.method,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${resolved.value}`,
            ...(options.body === undefined
              ? {}
              : { "Content-Type": "application/x-www-form-urlencoded" }),
          },
          body: options.body,
          signal,
        });
        throwIfAborted(options.signal);
        if (!response.ok) {
          throw remoteError(
            response,
            options.operation,
            settings.connectorInstanceId,
            options.safeRead,
          );
        }

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new ConnectorProtocolError(
            "Jitbit returned a malformed JSON response.",
            {
              connectorInstanceId: settings.connectorInstanceId,
              operation: options.operation,
              requestId: requestCorrelation(response),
            },
          );
        }
        const parsed = options.responseSchema.safeParse(payload);
        if (!parsed.success) {
          throw new ConnectorProtocolError(
            "Jitbit returned an invalid response.",
            {
              connectorInstanceId: settings.connectorInstanceId,
              operation: options.operation,
              requestId: requestCorrelation(response),
            },
          );
        }
        return parsed.data;
      } catch (error) {
        if (error instanceof ConnectorCancelledError) throw error;
        if (options.signal.aborted) throw new ConnectorCancelledError();
        const connectorError =
          error instanceof ConnectorRemoteError
            ? error
            : error instanceof ConnectorProtocolError
              ? error
              : new ConnectorRemoteError(
                  timeout.aborted
                    ? "Jitbit request timed out."
                    : "Jitbit request could not reach the remote service.",
                  {
                    category: timeout.aborted ? "timeout" : "network",
                    retryable: options.safeRead,
                    connectorInstanceId: settings.connectorInstanceId,
                    operation: options.operation,
                    cause: error,
                  },
                );
        if (
          !options.safeRead ||
          !connectorError.retryable ||
          attempt === maximumReadAttempts
        ) {
          throw connectorError;
        }
        lastError = connectorError;
        const retryAfter = connectorError.details?.retryAfterMs;
        const backoff = Math.min(2_000, 100 * 2 ** (attempt - 1));
        await this.sleep(
          retryAfter ?? Math.round(backoff * (0.5 + this.random())),
          options.signal,
        );
      }
    }
    throw (
      lastError ?? new ConnectorProtocolError("Jitbit retry state was invalid.")
    );
  }
}
