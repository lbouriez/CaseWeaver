import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from "pino";

import type { ApiConfig } from "./config.js";

const redactedPaths = [
  "password",
  "*.password",
  "secret",
  "*.secret",
  "token",
  "*.token",
  "authorization",
  "*.authorization",
  "cookie",
  "*.cookie",
  "apiKey",
  "*.apiKey",
  "api_key",
  "*.api_key",
  "databaseUrl",
  "*.databaseUrl",
  "database_url",
  "*.database_url",
  "connectionString",
  "*.connectionString",
  "connection_string",
  "*.connection_string",
  "req.headers",
  "req.body",
  "request.headers",
  "request.body",
  "headers",
  "body",
  "prompt",
  "*.prompt",
  "content",
  "*.content",
] as const;

export type AppLogger = Logger;

export function createLogger(
  config: ApiConfig,
  destination?: DestinationStream,
): AppLogger {
  const options: LoggerOptions = {
    base: {
      environment: config.nodeEnv,
      service: "caseweaver-api",
    },
    level: "info",
    redact: {
      paths: [...redactedPaths],
      censor: "[Redacted]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  return destination === undefined ? pino(options) : pino(options, destination);
}
