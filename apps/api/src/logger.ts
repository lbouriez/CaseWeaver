import { isSensitiveDiagnosticAttributeName } from "@caseweaver/observability";
import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from "pino";

import type { ApiConfig } from "./config.js";

const redactedLogValue = "[Redacted]";
const unsupportedLogValue = "[Unsupported]";

/** Pino otherwise serializes Error messages, stacks, and causes by default. */
function redactError(_error: Error): Readonly<{ readonly type: "Error" }> {
  return Object.freeze({ type: "Error" });
}

/**
 * Pino's path redactor cannot cover unknown depth or arrays. Walk only own data
 * properties so log values stay safe even when they contain accessor-backed input.
 */
function redactLogValue(value: unknown, visited: WeakSet<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : unsupportedLogValue;
  }
  if (typeof value !== "object") return unsupportedLogValue;
  if (value instanceof Error) return redactError(value);
  if (visited.has(value)) return "[Circular]";

  visited.add(value);
  try {
    if (Array.isArray(value)) {
      const values: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        values.push(
          descriptor !== undefined && "value" in descriptor
            ? redactLogValue(descriptor.value, visited)
            : redactedLogValue,
        );
      }
      return values;
    }

    const attributes: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (isSensitiveDiagnosticAttributeName(key)) {
        attributes[key] = redactedLogValue;
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      attributes[key] =
        descriptor !== undefined && "value" in descriptor
          ? redactLogValue(descriptor.value, visited)
          : redactedLogValue;
    }
    return attributes;
  } finally {
    visited.delete(value);
  }
}

function redactLogObject(value: object): Record<string, unknown> {
  const redacted = redactLogValue(value, new WeakSet<object>());
  return redacted !== null &&
    typeof redacted === "object" &&
    !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : {};
}

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
    serializers: {
      err: redactError,
      error: redactError,
    },
    formatters: {
      log: redactLogObject,
    },
    hooks: {
      logMethod(inputArgs, method) {
        if (inputArgs[0] instanceof Error) {
          return method.apply(this, [
            { err: inputArgs[0] },
            "CaseWeaver error",
          ]);
        }
        return method.apply(this, inputArgs);
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  return destination === undefined ? pino(options) : pino(options, destination);
}
