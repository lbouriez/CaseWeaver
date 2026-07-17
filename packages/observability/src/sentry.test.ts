import { describe, expect, it, vi } from "vitest";

import { createDiagnosticEvent } from "./diagnostics.js";
import {
  createSentryDiagnosticSink,
  projectSentryExternalEvent,
  resolveSentryConfig,
  type SentryConfig,
  SentryConfigurationError,
  type SentryEventTransport,
} from "./sentry.js";

const config: SentryConfig = {
  dsn: "https://public-key@sentry.example.test/42",
  environment: "test",
  release: "2026.07.16",
  errorSampleRatio: 1,
  flushTimeoutMs: 100,
};

describe("Sentry diagnostic sink", () => {
  it("is opt-in and validates only deployment-owned configuration", () => {
    expect(resolveSentryConfig({})).toBeUndefined();
    expect(
      resolveSentryConfig({
        SENTRY_DSN: config.dsn,
        SENTRY_ENVIRONMENT: "production",
        SENTRY_RELEASE: "2026.07.16",
        SENTRY_ERROR_SAMPLE_RATIO: "0.25",
        SENTRY_FLUSH_TIMEOUT_MS: "500",
      }),
    ).toEqual({
      ...config,
      environment: "production",
      errorSampleRatio: 0.25,
      flushTimeoutMs: 500,
    });
    expect(() =>
      resolveSentryConfig({ SENTRY_DSN: "http://key@sentry.example.test/42" }),
    ).toThrow(SentryConfigurationError);
    expect(() =>
      resolveSentryConfig({
        SENTRY_DSN: config.dsn,
        SENTRY_ERROR_SAMPLE_RATIO: "2",
      }),
    ).toThrow(SentryConfigurationError);
  });

  it("exports only allow-listed codes and counters", () => {
    const event = createDiagnosticEvent({
      name: "repository.checkout.failed",
      severity: "error",
      attributes: {
        failureCode: "repository.checkoutFailed",
        outcome: "failed",
        retryCount: 2,
        detail: "private free text",
        workspaceId: "workspace-private",
        prompt: "private prompt",
        result: "private model result",
        sourceUrl: "https://private.example/source",
        repositoryPath: "C:\\private\\checkout",
        externalSecretLocator: "vault://private/secret",
        request: { headers: { authorization: "Bearer private-token" } },
      },
    });

    const projected = projectSentryExternalEvent(event);
    const serialized = JSON.stringify(projected);
    expect(projected).toEqual({
      name: "repository.checkout.failed",
      severity: "error",
      tags: {
        "caseweaver.event": "repository.checkout.failed",
        "caseweaver.severity": "error",
        "caseweaver.failure_code": "repository.checkoutFailed",
        "caseweaver.outcome": "failed",
      },
      measurements: { "caseweaver.retry_count": 2 },
    });
    for (const prohibited of [
      "private prompt",
      "private free text",
      "private model result",
      "private.example",
      "private\\checkout",
      "vault://",
      "private-token",
      "workspace-private",
    ]) {
      expect(serialized).not.toContain(prohibited);
    }
  });

  it("does not invoke accessors while projecting a third-party event", () => {
    let allowListedAccessorRead = false;
    const attributes = Object.create({
      operation: "automation.inheritedOperation",
    }) as Record<string, unknown>;
    Object.defineProperty(attributes, "failureCode", {
      enumerable: true,
      get: () => {
        allowListedAccessorRead = true;
        return "automation.privateFailure";
      },
    });
    Object.defineProperty(attributes, "outcome", {
      enumerable: true,
      get: () => {
        allowListedAccessorRead = true;
        return "automation.safeLookingSentinel";
      },
    });
    Object.defineProperty(attributes, "retryCount", {
      enumerable: true,
      get: () => {
        allowListedAccessorRead = true;
        return 3;
      },
    });

    const projected = projectSentryExternalEvent({
      name: "analysis.failed",
      occurredAt: "2026-07-16T00:00:00.000Z",
      severity: "error",
      attributes: attributes as never,
    });

    expect(allowListedAccessorRead).toBe(false);
    expect(projected.tags).not.toHaveProperty("caseweaver.failure_code");
    expect(projected.tags).not.toHaveProperty("caseweaver.operation");
    expect(projected.tags).not.toHaveProperty("caseweaver.outcome");
    expect(projected.measurements).toEqual({});
    expect(JSON.stringify(projected)).not.toContain("automation-private");
    expect(JSON.stringify(projected)).not.toContain("safeLookingSentinel");
    expect(JSON.stringify(projected)).not.toContain("inheritedOperation");
  });

  it("does not transport deployment settings or untrusted nested event content", () => {
    const captured: unknown[] = [];
    const deploymentConfig: SentryConfig = {
      dsn: "https://automation-dsn@sentry.example.test/42",
      environment: "automation",
      release: "2026.07.16",
      errorSampleRatio: 0.37,
      flushTimeoutMs: 500,
    };
    const sink = createSentryDiagnosticSink(deploymentConfig, () => ({
      capture: (event) => captured.push(event),
      flush: async () => undefined,
    }));
    const error = new Error("automation-private-error-message");
    error.stack = "automation-private-error-stack";

    sink.record({
      name: "analysis.failed",
      occurredAt: "2026-07-16T00:00:00.000Z",
      severity: "error",
      attributes: {
        failureCode: "analysis.failed",
        prompt: "automation-private-prompt",
        nested: {
          result: "automation-private-result",
          error: {
            message: error.message,
            stack: error.stack,
            cause: "automation-private-cause",
          },
        },
      } as never,
    });

    const serialized = JSON.stringify(captured);
    expect(serialized).toContain("analysis.failed");
    for (const prohibited of [
      "automation-dsn",
      "0.37",
      "automation-private-prompt",
      "automation-private-result",
      "automation-private-error-message",
      "automation-private-error-stack",
      "automation-private-cause",
    ]) {
      expect(serialized).not.toContain(prohibited);
    }
  });

  it("is best effort when capture or flush fails", async () => {
    const capture = vi.fn(() => {
      throw new Error("private transport failure");
    });
    const flush = vi.fn(async () => {
      throw new Error("private flush failure");
    });
    const transport: SentryEventTransport = { capture, flush };
    const sink = createSentryDiagnosticSink(config, () => transport);

    expect(() =>
      sink.record(
        createDiagnosticEvent({
          name: "analysis.failed",
          severity: "error",
          attributes: { failureCode: "analysis.failed" },
        }),
      ),
    ).not.toThrow();
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(100);
  });
});
