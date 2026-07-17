import { describe, expect, it } from "vitest";

import { redactOpenTelemetrySpanAttributes } from "./tracing.js";

describe("OpenTelemetry span attribute redaction", () => {
  it("keeps only bounded operational attributes", () => {
    expect(
      redactOpenTelemetrySpanAttributes({
        "caseweaver.envelope_type": "analysis.trigger.v2",
        "caseweaver.workspace_id": "workspace-1",
        "caseweaver.retry_count": 2,
        "caseweaver.cache_hit": true,
        "caseweaver.failure_code": "analysis.failed",
        "caseweaver.repository_path": "C:\\private\\checkout",
        "caseweaver.source_url": "https://private.example/source",
        "caseweaver.prompt": "private prompt",
        "caseweaver.output": "private model result",
        "caseweaver.headers": "Bearer private-token",
        arbitrary: "private free text",
      }),
    ).toEqual({
      "caseweaver.envelope_type": "analysis.trigger.v2",
      "caseweaver.workspace_id": "workspace-1",
      "caseweaver.retry_count": 2,
      "caseweaver.cache_hit": true,
      "caseweaver.failure_code": "analysis.failed",
    });
  });

  it("drops malformed values rather than exporting them", () => {
    expect(
      redactOpenTelemetrySpanAttributes({
        "caseweaver.envelope_type": "private source text",
        "caseweaver.workspace_id": "private workspace text",
        "caseweaver.retry_count": -1,
        "caseweaver.cache_hit": "true" as never,
      }),
    ).toEqual({});
  });
});
