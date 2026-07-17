import { describe, expect, it } from "vitest";

import {
  createOpenTelemetrySdk,
  OpenTelemetryConfigurationError,
  resolveOpenTelemetryConfig,
} from "./otel.js";

describe("OpenTelemetry configuration", () => {
  it("is absent rather than replaced by fake telemetry without an endpoint", () => {
    expect(resolveOpenTelemetryConfig({}, "caseweaver-worker")).toBeUndefined();
    expect(
      resolveOpenTelemetryConfig(
        {
          OTEL_SDK_DISABLED: "true",
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel",
        },
        "caseweaver-worker",
      ),
    ).toBeUndefined();
  });

  it("builds a real SDK configuration with signal-specific collector paths", async () => {
    const config = resolveOpenTelemetryConfig(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test/otel/",
        OTEL_METRIC_EXPORT_INTERVAL_MS: "60000",
        OTEL_EXPORTER_OTLP_HEADERS:
          "Authorization=Bearer deployment-secret,X-Tenant=collector",
        OTEL_TRACE_SAMPLE_RATIO: "0.1",
        OTEL_SERVICE_NAME: "caseweaver-standalone",
        OTEL_SERVICE_VERSION: "2026.7.14",
      },
      "caseweaver-worker",
    );

    expect(config).toEqual({
      serviceName: "caseweaver-standalone",
      serviceVersion: "2026.7.14",
      tracesEndpoint: "https://collector.example.test/otel/v1/traces",
      metricsEndpoint: "https://collector.example.test/otel/v1/metrics",
      headers: {
        Authorization: "Bearer deployment-secret",
        "X-Tenant": "collector",
      },
      metricExportIntervalMs: 60_000,
      traceSampleRatio: 0.1,
    });
    const sdk = createOpenTelemetrySdk(config);
    expect(sdk).toBeDefined();
    await sdk.shutdown();
  });

  it.each([
    { OTEL_SDK_DISABLED: "yes" },
    { OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://collector.example.test" },
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:secret@collector.example.test",
    },
    {
      OTEL_EXPORTER_OTLP_ENDPOINT:
        "https://collector.example.test?token=private",
    },
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test",
      OTEL_METRIC_EXPORT_INTERVAL_MS: "10",
    },
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test",
      OTEL_EXPORTER_OTLP_HEADERS:
        "Authorization=Bearer token,authorization=duplicate",
    },
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test",
      OTEL_TRACE_SAMPLE_RATIO: "1.1",
    },
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test",
      OTEL_EXPORTER_OTLP_HEADERS:
        "X-Collector=accepted\r\nAuthorization=Bearer private-token",
    },
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test",
      OTEL_TRACE_SAMPLE_RATIO: "-0.01",
    },
  ])("rejects unsafe OpenTelemetry configuration", (environment) => {
    expect(() =>
      resolveOpenTelemetryConfig(environment, "caseweaver-worker"),
    ).toThrow(OpenTelemetryConfigurationError);
  });
});
