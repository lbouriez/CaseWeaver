# Observability

**PBI:** 013

This package owns vendor-neutral diagnostic redaction and real OpenTelemetry SDK
configuration. It deliberately does not contain application instrumentation or a fake
telemetry implementation.

## Diagnostics

Create diagnostic events with `createDiagnosticEvent` and export snapshots with
`createDiagnosticExport`. Both boundaries recursively redact secrets, credentials,
connection strings, request/response payloads, prompts, attachment content, URLs, and
error messages. Keep operator-useful identifiers and typed failure codes in explicit
attributes such as `workspaceId`, `jobId`, `attemptId`, and `failureCode`; do not put
untrusted text in diagnostic attributes.

`InMemoryDiagnosticSink` is test-only capture for the diagnostic contract. It is not an
OpenTelemetry substitute and emits no telemetry.

## OpenTelemetry

`resolveOpenTelemetryConfig(env, defaultServiceName)` returns `undefined` when
`OTEL_SDK_DISABLED=true` or no `OTEL_EXPORTER_OTLP_ENDPOINT` is configured. Otherwise
`startOpenTelemetry` registers real Node trace and metric SDK providers with OTLP/HTTP
trace and metric exporters. The base endpoint must be an unauthenticated HTTP(S) URL
without a query or fragment; trace and metric exporters use its `/v1/traces` and
`/v1/metrics` paths.

Supported settings:

- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_SERVICE_NAME`
- `OTEL_SERVICE_VERSION`
- `OTEL_METRIC_EXPORT_INTERVAL_MS` (1,000–3,600,000; default 30,000)
- `OTEL_SDK_DISABLED`

Concrete applications own SDK startup and shutdown. Instrumentation must emit spans and
metrics through the installed OpenTelemetry API, never through an in-memory replacement.

`captureOpenTelemetryTraceContext` and `withOpenTelemetrySpan` propagate only validated
W3C `traceparent`/`tracestate` values across the durable outbox. API mutation spans
capture this context, PostgreSQL persists it separately from payload content, and workers
extract it around command dispatch. No request body, prompt, response, URL, or secret is
placed in queue trace context.
