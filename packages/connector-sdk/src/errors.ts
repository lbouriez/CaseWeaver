export type ConnectorErrorCategory =
  | "authentication"
  | "authorization"
  | "configuration"
  | "conflict"
  | "network"
  | "protocol"
  | "rateLimit"
  | "remote"
  | "timeout";

export interface ConnectorErrorDetails {
  readonly connectorInstanceId?: string;
  readonly operation?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly statusCode?: number;
}

export interface ConnectorErrorOptions {
  readonly category: ConnectorErrorCategory;
  readonly retryable?: boolean;
  readonly details?: ConnectorErrorDetails;
  readonly cause?: unknown;
}

/**
 * A safe, typed failure that can cross a connector boundary. Its message must be safe
 * to expose to an operator and must not include credentials or raw remote payloads.
 */
export class ConnectorError extends Error {
  public readonly category: ConnectorErrorCategory;
  public readonly retryable: boolean;
  public readonly details?: ConnectorErrorDetails;

  public constructor(
    public readonly code: string,
    safeMessage: string,
    options: ConnectorErrorOptions,
  ) {
    super(safeMessage, { cause: options.cause });
    this.name = "ConnectorError";
    this.category = options.category;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export class ConnectorConfigurationError extends ConnectorError {
  public constructor(message: string, details?: ConnectorErrorDetails) {
    super("connector.configuration", message, {
      category: "configuration",
      details,
    });
    this.name = "ConnectorConfigurationError";
  }
}

export class ConnectorProtocolError extends ConnectorError {
  public constructor(message: string, details?: ConnectorErrorDetails) {
    super("connector.protocol", message, {
      category: "protocol",
      details,
    });
    this.name = "ConnectorProtocolError";
  }
}

export interface ConnectorRemoteErrorOptions {
  readonly category?: Exclude<
    ConnectorErrorCategory,
    "configuration" | "protocol"
  >;
  readonly connectorInstanceId?: string;
  readonly operation?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly retryable?: boolean;
  readonly statusCode?: number;
  readonly cause?: unknown;
}

/**
 * Maps a remote-system error while retaining retry, Retry-After, and request-ID data.
 */
export class ConnectorRemoteError extends ConnectorError {
  public constructor(
    safeMessage: string,
    options: ConnectorRemoteErrorOptions = {},
  ) {
    super("connector.remote", safeMessage, {
      category: options.category ?? "remote",
      retryable: options.retryable,
      details: {
        connectorInstanceId: options.connectorInstanceId,
        operation: options.operation,
        requestId: options.requestId,
        retryAfterMs: options.retryAfterMs,
        statusCode: options.statusCode,
      },
      cause: options.cause,
    });
    this.name = "ConnectorRemoteError";
  }
}

/**
 * Cancellation intentionally does not extend ConnectorError: callers must not record
 * it as a remote failure or retry it as one.
 */
export class ConnectorCancelledError extends Error {
  public readonly cancelled = true;

  public constructor() {
    super("The connector operation was cancelled.");
    this.name = "ConnectorCancelledError";
  }
}

export class ConnectorIdempotencyConflictError extends ConnectorError {
  public constructor(operation: string) {
    super(
      "connector.idempotencyConflict",
      "The idempotency key was already used for a different request.",
      {
        category: "conflict",
        details: { operation },
      },
    );
    this.name = "ConnectorIdempotencyConflictError";
  }
}

export function isConnectorCancellation(
  error: unknown,
): error is ConnectorCancelledError {
  return error instanceof ConnectorCancelledError;
}
