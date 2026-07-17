# Observability

**PBIs:** 013, 020

This package owns vendor-neutral diagnostic redaction and real OpenTelemetry SDK
configuration. It deliberately does not contain application instrumentation or a fake
telemetry implementation.

## Diagnostics

Create diagnostic events with `createDiagnosticEvent` and export snapshots with
`createDiagnosticExport`. Both boundaries recursively redact secrets, credentials,
connection strings, request/response payloads, prompts, model output, attachment
content, URLs, repository paths, secret locators, and error messages. Keep
operator-useful identifiers and typed failure codes in explicit
attributes such as `workspaceId`, `jobId`, `attemptId`, and `failureCode`; do not put
untrusted text in diagnostic attributes.

`InMemoryDiagnosticSink` is test-only capture for the diagnostic contract. It is not an
OpenTelemetry substitute and emits no telemetry.

## OpenTelemetry

`resolveOpenTelemetryConfig(env, defaultServiceName)` returns `undefined` when
`OTEL_SDK_DISABLED=true` or no `OTEL_EXPORTER_OTLP_ENDPOINT` is configured. Otherwise
`startOpenTelemetry` registers real Node trace and metric SDK providers with OTLP/HTTP
trace and metric exporters. The base endpoint must be an HTTP(S) URL without embedded
credentials, a query, or fragment; trace and metric exporters use its `/v1/traces` and
`/v1/metrics` paths.

Supported settings:

- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_SERVICE_NAME`
- `OTEL_SERVICE_VERSION`
- `OTEL_EXPORTER_OTLP_HEADERS` (deployment-only `Header=Value` pairs; never exported
  as telemetry attributes)
- `OTEL_METRIC_EXPORT_INTERVAL_MS` (1,000–3,600,000; default 30,000)
- `OTEL_TRACE_SAMPLE_RATIO` (0–1; default 0.05)
- `OTEL_SDK_DISABLED`

Concrete applications own SDK startup and shutdown. Instrumentation must emit spans and
metrics through the installed OpenTelemetry API, never through an in-memory replacement.

`captureOpenTelemetryTraceContext` and `withOpenTelemetrySpan` propagate only validated
W3C `traceparent`/`tracestate` values across the durable outbox. API mutation spans
capture this context, PostgreSQL persists it separately from payload content, and workers
extract it around command dispatch. No request body, prompt, response, URL, or secret is
placed in queue trace context.

`withOpenTelemetrySpan` exports only allow-listed operational attributes and typed
failure codes. Paths, URLs, prompts, model output, source/attachment content, headers,
cookies, secret locators, and arbitrary free text are dropped before a span reaches an
exporter.

## Optional Sentry error sink

`resolveSentryConfig` is deployment-only and returns `undefined` unless `SENTRY_DSN`
is configured. `SentryDiagnosticSink` accepts only a strict projection of a
`DiagnosticEvent`: event name, severity, typed error/failure code, bounded outcome, and
numeric retry/attempt/duration measurements. It never accepts an `Error`, exception,
request, breadcrumb, user, context, prompt, result, source, attachment, URL, path,
header, cookie, credential, or secret locator.

Supported settings are:

- `SENTRY_DSN` (HTTPS deployment DSN)
- `SENTRY_ENVIRONMENT`
- `SENTRY_RELEASE`
- `SENTRY_ERROR_SAMPLE_RATIO` (0–1; default 1)
- `SENTRY_FLUSH_TIMEOUT_MS` (50–10,000; default 1,000)

The package initializes Sentry without default integrations or OpenTelemetry setup;
automatic request, exception, breadcrumb, and SDK context capture are disabled. The
sink is best effort and must never affect an audit, command, queue acknowledgement, or
user-visible operation. Applications own optional sink construction and shutdown.
