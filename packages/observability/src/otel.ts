import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

export interface OpenTelemetryConfig {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly tracesEndpoint: string;
  readonly metricsEndpoint: string;
  readonly metricExportIntervalMs: number;
}

export interface OpenTelemetrySdk {
  shutdown(): Promise<void>;
}

export class OpenTelemetryConfigurationError extends Error {
  public constructor() {
    super("OpenTelemetry configuration is invalid.");
    this.name = "OpenTelemetryConfigurationError";
  }
}

function readOptionalBoolean(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new OpenTelemetryConfigurationError();
}

function validServiceName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(value);
}

function parseEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new OpenTelemetryConfigurationError();
  }
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw new OpenTelemetryConfigurationError();
  }
  return endpoint;
}

function exportEndpoint(endpoint: URL, signal: "traces" | "metrics"): string {
  const normalized = new URL(endpoint);
  normalized.pathname = `${normalized.pathname.replace(/\/+$/u, "")}/v1/${signal}`;
  return normalized.toString();
}

function parseMetricExportInterval(value: string | undefined): number {
  if (value === undefined || value.length === 0) return 30_000;
  const interval = Number(value);
  if (!Number.isInteger(interval) || interval < 1_000 || interval > 3_600_000) {
    throw new OpenTelemetryConfigurationError();
  }
  return interval;
}

/**
 * Returns no SDK when OpenTelemetry is disabled or no collector endpoint is
 * configured. This does not substitute an in-memory or no-op telemetry SDK.
 */
export function resolveOpenTelemetryConfig(
  env: NodeJS.ProcessEnv,
  defaultServiceName: string,
): OpenTelemetryConfig | undefined {
  if (readOptionalBoolean(env.OTEL_SDK_DISABLED)) return undefined;
  const endpointValue = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (endpointValue === undefined || endpointValue.length === 0) {
    return undefined;
  }

  const serviceName = env.OTEL_SERVICE_NAME?.trim() || defaultServiceName;
  if (!validServiceName(serviceName)) {
    throw new OpenTelemetryConfigurationError();
  }
  const serviceVersion = env.OTEL_SERVICE_VERSION?.trim();
  if (serviceVersion !== undefined && serviceVersion.length > 120) {
    throw new OpenTelemetryConfigurationError();
  }
  const endpoint = parseEndpoint(endpointValue);
  return Object.freeze({
    serviceName,
    ...(serviceVersion === undefined || serviceVersion.length === 0
      ? {}
      : { serviceVersion }),
    tracesEndpoint: exportEndpoint(endpoint, "traces"),
    metricsEndpoint: exportEndpoint(endpoint, "metrics"),
    metricExportIntervalMs: parseMetricExportInterval(
      env.OTEL_METRIC_EXPORT_INTERVAL_MS,
    ),
  });
}

export function createOpenTelemetrySdk(
  config: OpenTelemetryConfig,
): OpenTelemetrySdk {
  const attributes: Record<string, string> = {
    [ATTR_SERVICE_NAME]: config.serviceName,
  };
  if (config.serviceVersion !== undefined) {
    attributes[ATTR_SERVICE_VERSION] = config.serviceVersion;
  }

  const resource = resourceFromAttributes(attributes);
  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: config.tracesEndpoint }),
      ),
    ],
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: config.metricsEndpoint }),
        exportIntervalMillis: config.metricExportIntervalMs,
      }),
    ],
  });
  tracerProvider.register();
  metrics.setGlobalMeterProvider(meterProvider);

  return Object.freeze({
    shutdown: async () => {
      await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
    },
  });
}

export async function startOpenTelemetry(
  config: OpenTelemetryConfig | undefined,
): Promise<OpenTelemetrySdk | undefined> {
  if (config === undefined) return undefined;
  const sdk = createOpenTelemetrySdk(config);
  return sdk;
}
