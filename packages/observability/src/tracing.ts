import type { TraceContext } from "@caseweaver/domain";
import {
  type Context,
  context,
  propagation,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

const traceparentPattern = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/iu;

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
    .startActiveSpan(name, {}, parent, async (span) => {
      try {
        for (const [key, value] of Object.entries(input.attributes ?? {})) {
          span.setAttribute(key, value);
        }
        const result = await operation();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string"
        ) {
          span.setAttribute("caseweaver.failure_code", error.code);
        }
        throw error;
      } finally {
        span.end();
      }
    });
}
