import {
  captureEvent,
  type ErrorEvent,
  flush,
  initWithoutDefaultIntegrations,
  type SeverityLevel,
} from "@sentry/node";

import type {
  DiagnosticEvent,
  DiagnosticSeverity,
  DiagnosticSink,
  DiagnosticValue,
} from "./diagnostics.js";

const safeNamePattern = /^[a-z][a-z0-9_.-]{0,119}$/u;
const safeCodePattern = /^[A-Za-z][A-Za-z0-9]*(?:[._][A-Za-z0-9]+){1,7}$/u;
const safeOutcomePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u;
const safeEnvironmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;

const externalCodeAttributes = new Map([
  ["errorCode", "caseweaver.error_code"],
  ["failureCode", "caseweaver.failure_code"],
  ["operation", "caseweaver.operation"],
  ["outcome", "caseweaver.outcome"],
]);

const externalMeasurementAttributes = new Map([
  ["attemptCount", "caseweaver.attempt_count"],
  ["durationMs", "caseweaver.duration_ms"],
  ["retryCount", "caseweaver.retry_count"],
]);

export interface SentryConfig {
  /** Deployment-owned DSN. It must never become a DTO, log, or event field. */
  readonly dsn: string;
  readonly environment: string;
  readonly release?: string;
  readonly errorSampleRatio: number;
  readonly flushTimeoutMs: number;
}

export interface SentryExternalEvent {
  readonly name: string;
  readonly severity: DiagnosticSeverity;
  readonly tags: Readonly<Record<string, string>>;
  readonly measurements: Readonly<Record<string, number>>;
}

export interface SentryEventTransport {
  capture(event: SentryExternalEvent): void;
  flush(timeoutMs: number): Promise<void>;
}

export type SentryEventTransportFactory = (
  config: SentryConfig,
) => SentryEventTransport;

export class SentryConfigurationError extends Error {
  public constructor() {
    super("Sentry configuration is invalid.");
    this.name = "SentryConfigurationError";
  }
}

function parseDsn(value: string): string {
  let dsn: URL;
  try {
    dsn = new URL(value);
  } catch {
    throw new SentryConfigurationError();
  }
  if (
    dsn.protocol !== "https:" ||
    dsn.username.length === 0 ||
    dsn.hostname.length === 0 ||
    dsn.search.length > 0 ||
    dsn.hash.length > 0 ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new SentryConfigurationError();
  }
  return value;
}

function parseRatio(value: string | undefined, fallback: number): number {
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new SentryConfigurationError();
  }
  return parsed;
}

function parseFlushTimeout(value: string | undefined): number {
  if (value === undefined || value.length === 0) return 1_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 50 || parsed > 10_000) {
    throw new SentryConfigurationError();
  }
  return parsed;
}

/**
 * Returns no Sentry configuration unless an administrator explicitly supplies
 * a deployment DSN. Configuration is intentionally not an HTTP/API concern.
 */
export function resolveSentryConfig(
  environment: NodeJS.ProcessEnv,
): SentryConfig | undefined {
  const dsn = environment.SENTRY_DSN?.trim();
  if (dsn === undefined || dsn.length === 0) return undefined;
  const sentryEnvironment =
    environment.SENTRY_ENVIRONMENT?.trim() ??
    environment.NODE_ENV ??
    "production";
  if (!safeEnvironmentPattern.test(sentryEnvironment)) {
    throw new SentryConfigurationError();
  }
  const release = environment.SENTRY_RELEASE?.trim();
  if (
    release !== undefined &&
    release.length > 0 &&
    !safeEnvironmentPattern.test(release)
  ) {
    throw new SentryConfigurationError();
  }
  return Object.freeze({
    dsn: parseDsn(dsn),
    environment: sentryEnvironment,
    ...(release === undefined || release.length === 0 ? {} : { release }),
    errorSampleRatio: parseRatio(environment.SENTRY_ERROR_SAMPLE_RATIO, 1),
    flushTimeoutMs: parseFlushTimeout(environment.SENTRY_FLUSH_TIMEOUT_MS),
  });
}

function asExternalValue(
  value: DiagnosticValue | undefined,
): string | undefined {
  return typeof value === "string" && safeCodePattern.test(value)
    ? value
    : undefined;
}

function asExternalOutcome(
  value: DiagnosticValue | undefined,
): string | undefined {
  return typeof value === "string" && safeOutcomePattern.test(value)
    ? value
    : undefined;
}

function asExternalMeasurement(
  value: DiagnosticValue | undefined,
): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * DiagnosticEvent is a public in-process contract, so do not trust a caller to
 * have built it with createDiagnosticEvent. In particular, reading an accessor
 * here could execute untrusted code and turn a safe-looking sentinel into an
 * externally exported tag.
 */
function ownDataDiagnosticAttribute(
  attributes: unknown,
  name: string,
): DiagnosticValue | undefined {
  if (attributes === null || typeof attributes !== "object") {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(attributes, name);
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !("value" in descriptor)
  ) {
    return undefined;
  }
  return descriptor.value as DiagnosticValue;
}

/**
 * Projects redacted diagnostics to a smaller contract for third-party export.
 * It intentionally ignores every attribute not named in these allow-lists.
 */
export function projectSentryExternalEvent(
  event: DiagnosticEvent,
): SentryExternalEvent {
  const tags: Record<string, string> = {
    "caseweaver.event": safeNamePattern.test(event.name)
      ? event.name
      : "caseweaver.diagnostic",
    "caseweaver.severity": event.severity,
  };
  const measurements: Record<string, number> = {};
  for (const [attribute, tag] of externalCodeAttributes) {
    const value = ownDataDiagnosticAttribute(event.attributes, attribute);
    const external =
      attribute === "outcome"
        ? asExternalOutcome(value)
        : asExternalValue(value);
    if (external !== undefined) tags[tag] = external;
  }
  for (const [attribute, measurement] of externalMeasurementAttributes) {
    const value = asExternalMeasurement(
      ownDataDiagnosticAttribute(event.attributes, attribute),
    );
    if (value !== undefined) measurements[measurement] = value;
  }
  return Object.freeze({
    name: tags["caseweaver.event"] ?? "caseweaver.diagnostic",
    severity: event.severity,
    tags: Object.freeze(tags),
    measurements: Object.freeze(measurements),
  });
}

function sentryLevel(severity: DiagnosticSeverity): SeverityLevel {
  switch (severity) {
    case "warn":
      return "warning";
    case "debug":
    case "info":
    case "error":
      return severity;
  }
}

function onlyExternalTags(
  tags: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of [
    "caseweaver.event",
    "caseweaver.severity",
    "caseweaver.error_code",
    "caseweaver.failure_code",
    "caseweaver.operation",
    "caseweaver.outcome",
  ]) {
    const value = tags[key];
    if (
      typeof value === "string" &&
      value !== undefined &&
      safeOutcomePattern.test(value)
    ) {
      safe[key] = value;
    }
  }
  return safe;
}

function onlyExternalMeasurements(
  measurements: Readonly<Record<string, number>>,
): Record<string, number> {
  const safe: Record<string, number> = {};
  for (const key of [
    "caseweaver.attempt_count",
    "caseweaver.duration_ms",
    "caseweaver.retry_count",
  ]) {
    const value = measurements[key];
    if (value !== undefined && Number.isFinite(value) && value >= 0) {
      safe[key] = value;
    }
  }
  return safe;
}

/** Final defensive SDK boundary; it does not preserve any SDK-added context. */
function projectSdkEvent(event: ErrorEvent): ErrorEvent {
  const tags = onlyExternalTags(event.tags ?? {});
  const name = tags["caseweaver.event"] ?? "caseweaver.diagnostic";
  return {
    type: undefined,
    level: sentryLevel(
      event.level === "warning"
        ? "warn"
        : event.level === "debug" ||
            event.level === "info" ||
            event.level === "error"
          ? event.level
          : "error",
    ),
    message: safeNamePattern.test(name) ? name : "caseweaver.diagnostic",
    tags,
    extra: onlyExternalMeasurements(
      Object.fromEntries(
        Object.entries(event.extra ?? {}).filter(
          ([, value]) => typeof value === "number",
        ),
      ) as Record<string, number>,
    ),
  };
}

function createSdkTransport(config: SentryConfig): SentryEventTransport {
  initWithoutDefaultIntegrations({
    dsn: config.dsn,
    environment: config.environment,
    ...(config.release === undefined ? {} : { release: config.release }),
    sampleRate: config.errorSampleRatio,
    // The Sentry SDK is an event transport only. OpenTelemetry owns traces.
    tracesSampleRate: 0,
    integrations: [],
    sendDefaultPii: false,
    includeLocalVariables: false,
    registerEsmLoaderHooks: false,
    skipOpenTelemetrySetup: true,
    beforeBreadcrumb: () => null,
    beforeSend: projectSdkEvent,
  });
  return Object.freeze({
    capture(event: SentryExternalEvent): void {
      captureEvent({
        level: sentryLevel(event.severity),
        message: event.name,
        tags: onlyExternalTags(event.tags),
        extra: onlyExternalMeasurements(event.measurements),
      });
    },
    async flush(timeoutMs: number): Promise<void> {
      await flush(timeoutMs);
    },
  });
}

/**
 * Best-effort diagnostic sink. It deliberately has no captureException API,
 * consumes no raw Error, and cannot affect business or audit outcomes.
 */
export class SentryDiagnosticSink implements DiagnosticSink {
  public constructor(
    private readonly transport: SentryEventTransport,
    private readonly flushTimeoutMs: number,
  ) {}

  public record(event: DiagnosticEvent): void {
    try {
      this.transport.capture(projectSentryExternalEvent(event));
    } catch {
      // An observability sink is not a correctness boundary.
    }
  }

  public async flush(): Promise<void> {
    try {
      await this.transport.flush(this.flushTimeoutMs);
    } catch {
      // Shutdown must remain bounded when an optional external sink is down.
    }
  }
}

export function createSentryDiagnosticSink(
  config: SentryConfig,
  factory: SentryEventTransportFactory = createSdkTransport,
): SentryDiagnosticSink {
  return new SentryDiagnosticSink(factory(config), config.flushTimeoutMs);
}
