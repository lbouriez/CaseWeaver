import type { TraceContext } from "@caseweaver/domain";
import {
  type Context,
  context,
  propagation,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

const traceparentPattern = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/iu;
const safeSpanNamePattern = /^caseweaver\.[a-z][a-z0-9_.-]{0,119}$/u;
const safeTokenPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/u;
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const safeFailureCodePattern =
  /^[A-Za-z][A-Za-z0-9]*(?:[._][A-Za-z0-9]+){1,7}$/u;

const stringAttributeNames = new Set([
  "caseweaver.analysis_outcome",
  "caseweaver.attestation_outcome",
  "caseweaver.cache_outcome",
  "caseweaver.checkout_outcome",
  "caseweaver.component",
  "caseweaver.envelope_type",
  "caseweaver.failure_code",
  "caseweaver.operation",
  "caseweaver.outcome",
  "caseweaver.publication_outcome",
  "caseweaver.stage",
  "caseweaver.trigger_kind",
]);

const identifierAttributeNames = new Set(["caseweaver.workspace_id"]);

const numericAttributeNames = new Set([
  "caseweaver.attempt_count",
  "caseweaver.duration_ms",
  "caseweaver.retry_count",
]);

const booleanAttributeNames = new Set(["caseweaver.cache_hit"]);

export type SafeSpanAttributeValue = string | number | boolean;

/**
 * OpenTelemetry attributes can be exported to a third party. Keep this
 * boundary allow-listed rather than trying to recognise sensitive free text
 * after it has entered a span.
 */
export function redactOpenTelemetrySpanAttributes(
  attributes: Readonly<Record<string, SafeSpanAttributeValue>>,
): Readonly<Record<string, SafeSpanAttributeValue>> {
  const redacted: Record<string, SafeSpanAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (stringAttributeNames.has(key)) {
      if (typeof value === "string" && safeTokenPattern.test(value)) {
        redacted[key] = value;
      }
      continue;
    }
    if (identifierAttributeNames.has(key)) {
      if (typeof value === "string" && safeIdentifierPattern.test(value)) {
        redacted[key] = value;
      }
      continue;
    }
    if (numericAttributeNames.has(key)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        redacted[key] = value;
      }
      continue;
    }
    if (booleanAttributeNames.has(key) && typeof value === "boolean") {
      redacted[key] = value;
    }
  }
  return Object.freeze(redacted);
}

function safeSpanName(name: string): string {
  return safeSpanNamePattern.test(name) ? name : "caseweaver.operation";
}

function safeFailureCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    safeFailureCodePattern.test(error.code)
  ) {
    return error.code;
  }
  return "caseweaver.unexpected";
}

function asTraceContext(
  carrier: Readonly<Record<string, string>>,
): TraceContext | undefined {
  const traceparent = carrier.traceparent;
  if (traceparent === undefined || !traceparentPattern.test(traceparent)) {
    return undefined;
  }
  const tracestate = carrier.tracestate;
  if (
    tracestate !== undefined &&
    (tracestate.length === 0 || tracestate.length > 512)
  ) {
    return undefined;
  }
  return Object.freeze({
    traceparent: traceparent.toLowerCase(),
    ...(tracestate === undefined ? {} : { tracestate }),
  });
}

function extractedContext(traceContext: TraceContext | undefined): Context {
  if (traceContext === undefined) return context.active();
  const carrier: Record<string, string> = {
    traceparent: traceContext.traceparent,
    ...(traceContext.tracestate === undefined
      ? {}
      : { tracestate: traceContext.tracestate }),
  };
  return propagation.extract(context.active(), carrier, {
    get: (source, key) => source[key.toLowerCase()],
    keys: (source) => Object.keys(source),
  });
}

/**
 * Captures standard W3C propagation headers only. No prompt, URL, request
 * body, or provider metadata is eligible to cross the durable queue boundary.
 */
export function captureOpenTelemetryTraceContext(): TraceContext | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier, {
    set: (target, key, value) => {
      if (key === "traceparent" || key === "tracestate") {
        target[key] = String(value);
      }
    },
  });
  return asTraceContext(carrier);
}

export async function withOpenTelemetrySpan<Result>(
  name: string,
  input: {
    readonly traceContext?: TraceContext;
    readonly attributes?: Readonly<Record<string, string | number | boolean>>;
  },
  operation: () => Promise<Result>,
): Promise<Result> {
  const parent = extractedContext(input.traceContext);
  return trace
    .getTracer("caseweaver")
    .startActiveSpan(safeSpanName(name), {}, parent, async (span) => {
      try {
        for (const [key, value] of Object.entries(
          redactOpenTelemetrySpanAttributes(input.attributes ?? {}),
        )) {
          span.setAttribute(key, value);
        }
        const result = await operation();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute("caseweaver.failure_code", safeFailureCode(error));
        throw error;
      } finally {
        span.end();
      }
    });
}
