import { describe, expect, it } from "vitest";

import {
  createDiagnosticEvent,
  createDiagnosticExport,
  REDACTED_DIAGNOSTIC_VALUE,
} from "./diagnostics.js";
import { InMemoryDiagnosticSink } from "./fakes.js";

describe("diagnostic redaction", () => {
  it("preserves identifiers and failure codes while removing nested secrets and content", () => {
    const event = createDiagnosticEvent({
      name: "queue.job.failed",
      occurredAt: new Date("2026-07-14T18:00:00.000Z"),
      severity: "error",
      attributes: {
        workspaceId: "workspace-1",
        jobId: "job-1",
        failureCode: "queue.leaseExpired",
        token: "private-token",
        analysisPrompt: "private analysis prompt",
        providerResponse: "private provider response",
        attachmentContent: "private attachment",
        failureMessage: "private error detail",
        request: {
          headers: { authorization: "Bearer private-token" },
          body: { prompt: "private prompt" },
        },
        nested: {
          response: "private provider response",
          publicState: "retrying",
        },
      },
    });

    expect(event.attributes).toEqual({
      workspaceId: "workspace-1",
      jobId: "job-1",
      failureCode: "queue.leaseExpired",
      token: REDACTED_DIAGNOSTIC_VALUE,
      analysisPrompt: REDACTED_DIAGNOSTIC_VALUE,
      providerResponse: REDACTED_DIAGNOSTIC_VALUE,
      attachmentContent: REDACTED_DIAGNOSTIC_VALUE,
      failureMessage: REDACTED_DIAGNOSTIC_VALUE,
      request: REDACTED_DIAGNOSTIC_VALUE,
      nested: {
        response: REDACTED_DIAGNOSTIC_VALUE,
        publicState: "retrying",
      },
    });
  });

  it("does not read accessors or Error messages while producing an export", () => {
    let accessorRead = false;
    const attributes = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(attributes, "prompt", {
      enumerable: true,
      get: () => {
        accessorRead = true;
        return "private prompt";
      },
    });
    const providerError = new Error("provider key private-token rejected");
    providerError.name = "private-token";
    attributes.error = providerError;

    const sink = new InMemoryDiagnosticSink();
    sink.recordInput({
      name: "provider.call.failed",
      severity: "error",
      attributes,
    });
    const exported = createDiagnosticExport(
      sink,
      new Date("2026-07-14T18:00:00.000Z"),
    );
    const serialized = JSON.stringify(exported);

    expect(accessorRead).toBe(false);
    expect(serialized).toContain("provider.call.failed");
    expect(serialized).toContain(REDACTED_DIAGNOSTIC_VALUE);
    expect(serialized).not.toContain("private-token");
    expect(serialized).not.toContain("private prompt");
  });

  it("defensively redacts events supplied by a diagnostic source", () => {
    const exported = createDiagnosticExport(
      {
        snapshot: () => [
          {
            name: "worker.failure",
            occurredAt: "2026-07-14T18:00:00.000Z",
            severity: "error" as const,
            attributes: {
              error: { message: "private failure" },
              attemptId: "attempt-1",
            } as never,
          },
        ],
      },
      new Date("2026-07-14T18:01:00.000Z"),
    );

    expect(exported.events[0]).toMatchObject({
      attributes: {
        error: { message: REDACTED_DIAGNOSTIC_VALUE },
        attemptId: "attempt-1",
      },
    });
  });
});
