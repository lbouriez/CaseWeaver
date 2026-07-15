import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  diagnosticExportLimits,
  generateDiagnosticExport,
  serializeDiagnosticExport,
  toDiagnosticExportStatus,
  transitionDiagnosticExport,
  type DiagnosticExportRequest,
  type DiagnosticExportRequestStore,
} from "./diagnostics-export.js";

const timestamp = "2026-07-15T12:00:00.000Z";

function request(
  status: DiagnosticExportRequest["status"] = "requested",
): DiagnosticExportRequest {
  return {
    id: "diagnostic-export-1",
    workspaceId: "workspace-1",
    requestedByPrincipalId: "principal-1",
    status,
    eventCutoffAt: timestamp,
    maximumEvents: diagnosticExportLimits().maximumEvents,
    createdAt: timestamp,
    expiresAt: "2026-07-16T12:00:00.000Z",
  };
}

class GenerationStore implements DiagnosticExportRequestStore {
  public current = request("requested");

  public async request() {
    return { request: this.current, replayed: false } as const;
  }
  public async find() {
    return this.current;
  }
  public async claimGeneration() {
    this.current = { ...this.current, status: "generating" };
    return this.current;
  }
  public async markReady() {
    throw new Error("not reached");
  }
  public async markFailed(input: {
    readonly failureCode:
      | "source.unavailable"
      | "content.tooLarge"
      | "storage.unavailable";
  }) {
    this.current = {
      ...this.current,
      status: "failed",
      failureCode: input.failureCode,
    };
  }
  public async expireDue() {
    return 0;
  }
  public async claimDeletion() {
    return [];
  }
  public async markDeleted() {}
}

describe("diagnostic export contracts", () => {
  it("maps an unavailable source to a fixed failed state without invoking storage or exposing a locator", async () => {
    const store = new GenerationStore();
    let wrote = false;
    const status = await generateDiagnosticExport(
      store,
      {
        snapshot: async () => {
          throw new Error("raw sensitive source failure");
        },
      },
      {
        write: async () => {
          wrote = true;
          return { storageKey: "must-not-leak" };
        },
        open: async () => {
          throw new Error("not reached");
        },
        delete: async () => undefined,
      },
      { sha256: async () => "a".repeat(64) },
      { now: () => timestamp },
      {
        workspaceId: "workspace-1",
        exportId: "diagnostic-export-1",
        signal: new AbortController().signal,
      },
    );

    expect(status).toEqual({
      id: "diagnostic-export-1",
      status: "failed",
      eventCutoffAt: timestamp,
      expiresAt: "2026-07-16T12:00:00.000Z",
      failureCode: "source.unavailable",
    });
    expect(wrote).toBe(false);
    expect(JSON.stringify(status)).not.toContain("storageKey");
  });

  it("best-effort deletes a private artifact when its fenced ready transition loses the claim", async () => {
    const store = new GenerationStore();
    let deleted: string | undefined;
    const status = await generateDiagnosticExport(
      store,
      {
        snapshot: async () => [
          {
            name: "diagnostic.event",
            occurredAt: timestamp,
            severity: "info" as const,
            attributes: {},
          },
        ],
      },
      {
        write: async () => ({ storageKey: "private/unreachable-artifact" }),
        open: async () => {
          throw new Error("not reached");
        },
        delete: async ({ locator }) => {
          deleted = locator.storageKey;
        },
      },
      { sha256: async () => "b".repeat(64) },
      { now: () => timestamp },
      {
        workspaceId: "workspace-1",
        exportId: "diagnostic-export-1",
        signal: new AbortController().signal,
      },
    );

    expect(deleted).toBe("private/unreachable-artifact");
    expect(status).toMatchObject({
      id: "diagnostic-export-1",
      status: "failed",
      failureCode: "storage.unavailable",
    });
    expect(JSON.stringify(status)).not.toContain("unreachable-artifact");
  });

  it("returns the durable terminal state when expiry wins a generation failure race", async () => {
    const store = new GenerationStore();
    store.markFailed = async () => {
      store.current = { ...store.current, status: "expired" };
    };
    const status = await generateDiagnosticExport(
      store,
      {
        snapshot: async () => [
          {
            name: "diagnostic.event",
            occurredAt: timestamp,
            severity: "info" as const,
            attributes: {},
          },
        ],
      },
      {
        write: async () => {
          throw new Error("storage unavailable");
        },
        open: async () => {
          throw new Error("not reached");
        },
        delete: async () => undefined,
      },
      { sha256: async () => "c".repeat(64) },
      { now: () => timestamp },
      {
        workspaceId: "workspace-1",
        exportId: "diagnostic-export-1",
        signal: new AbortController().signal,
      },
    );

    expect(status).toMatchObject({
      id: "diagnostic-export-1",
      status: "expired",
    });
    expect(status).not.toHaveProperty("failureCode");
  });

  it("serializes stable bounded JSON and redacts defense-in-depth sensitive fields", () => {
    const exportFile = serializeDiagnosticExport({
      cutoffAt: timestamp,
      generatedAt: timestamp,
      events: [
        {
          name: "administration.export",
          occurredAt: timestamp,
          severity: "info",
          attributes: {
            workspaceId: "workspace-1",
            authorization: "Bearer should-not-leak",
            nested: { promptText: "protected", jobId: "job-1" },
          },
        },
      ],
    });
    const content = new TextDecoder().decode(exportFile.content);
    expect(content).toContain('"authorization":"[Redacted]"');
    expect(content).toContain('"promptText":"[Redacted]"');
    expect(content).toContain('"workspaceId":"workspace-1"');
    expect(content).not.toContain("Bearer should-not-leak");
    expect(exportFile).toMatchObject({
      eventCount: 1,
      contentType: "application/json",
    });
  });

  it("rejects unbounded event input and byte overflow", () => {
    const limit = diagnosticExportLimits();
    expect(() =>
      serializeDiagnosticExport({
        cutoffAt: timestamp,
        generatedAt: timestamp,
        events: Array.from({ length: limit.maximumEvents + 1 }, () => ({
          name: "diagnostic.event",
          occurredAt: timestamp,
          severity: "info" as const,
          attributes: {},
        })),
      }),
    ).toThrow("event limit");
    expect(() =>
      serializeDiagnosticExport({
        cutoffAt: timestamp,
        generatedAt: timestamp,
        events: [
          {
            name: "diagnostic.event",
            occurredAt: timestamp,
            severity: "info",
            attributes: { safe: "x".repeat(limit.maximumBytes) },
          },
        ],
      }),
    ).toThrow("byte limit");
  });

  it("orders events deterministically rather than trusting source iteration order", () => {
    const input = {
      cutoffAt: timestamp,
      generatedAt: timestamp,
      events: [
        {
          name: "diagnostic.z",
          occurredAt: "2026-07-15T12:00:02.000Z",
          severity: "warn" as const,
          attributes: { sequence: 2 },
        },
        {
          name: "diagnostic.a",
          occurredAt: "2026-07-15T12:00:01.000Z",
          severity: "info" as const,
          attributes: { sequence: 1 },
        },
      ],
    };
    const content = new TextDecoder().decode(
      serializeDiagnosticExport(input).content,
    );
    expect(content.indexOf("diagnostic.a")).toBeLessThan(
      content.indexOf("diagnostic.z"),
    );
  });

  it("serializes equivalent event and attribute input byte-for-byte consistently", () => {
    const first = serializeDiagnosticExport({
      cutoffAt: timestamp,
      generatedAt: timestamp,
      events: [
        {
          name: "diagnostic.second",
          occurredAt: "2026-07-15T12:00:01.000Z",
          severity: "info",
          attributes: { z: 2, a: { b: true, a: false } },
        },
        {
          name: "diagnostic.first",
          occurredAt: timestamp,
          severity: "warn",
          attributes: { b: "two", a: "one" },
        },
      ],
    });
    const second = serializeDiagnosticExport({
      cutoffAt: timestamp,
      generatedAt: timestamp,
      events: [
        {
          name: "diagnostic.first",
          occurredAt: timestamp,
          severity: "warn",
          attributes: { a: "one", b: "two" },
        },
        {
          name: "diagnostic.second",
          occurredAt: "2026-07-15T12:00:01.000Z",
          severity: "info",
          attributes: { a: { a: false, b: true }, z: 2 },
        },
      ],
    });

    expect(first.content).toEqual(second.content);
  });

  it("recursively redacts sensitive key variants and caps deeply nested attributes", () => {
    let deep: Record<string, unknown> = { leaf: "must-not-leak" };
    for (let index = 0; index < 15; index += 1) {
      deep = { [`level${index}`]: deep };
    }
    const content = new TextDecoder().decode(
      serializeDiagnosticExport({
        cutoffAt: timestamp,
        generatedAt: timestamp,
        events: [
          {
            name: "diagnostic.redaction",
            occurredAt: timestamp,
            severity: "warn",
            attributes: {
              access_token: "must-not-leak",
              nested: [
                { requestBody: "must-not-leak" },
                { private_key: "must-not-leak" },
              ],
              deep: deep as never,
            },
          },
        ],
      }).content,
    );

    expect(content).toContain('"access_token":"[Redacted]"');
    expect(content).toContain('"requestBody":"[Redacted]"');
    expect(content).toContain('"private_key":"[Redacted]"');
    expect(content).toContain('"[Redacted]"');
    expect(content).not.toContain("must-not-leak");
  });

  it("allows only durable export lifecycle transitions and hides artifact locators from DTOs", () => {
    const ready = transitionDiagnosticExport(
      transitionDiagnosticExport(request(), "generating"),
      "ready",
      {
        artifact: {
          contentSha256: createHash("sha256").update("artifact").digest("hex"),
          byteLength: 8,
          contentType: "application/json",
          eventCount: 1,
          generatedAt: timestamp,
        },
      },
    );
    expect(toDiagnosticExportStatus(ready)).toEqual({
      id: "diagnostic-export-1",
      status: "ready",
      eventCutoffAt: timestamp,
      expiresAt: "2026-07-16T12:00:00.000Z",
      generatedAt: timestamp,
    });
    expect(() => transitionDiagnosticExport(ready, "generating")).toThrow(
      "transition",
    );
    expect(() =>
      transitionDiagnosticExport(
        transitionDiagnosticExport(request(), "generating"),
        "ready",
      ),
    ).toThrow("requires artifact");
  });

  it("does not permit terminal metadata on the wrong lifecycle state", () => {
    const artifact = {
      contentSha256: createHash("sha256").update("artifact").digest("hex"),
      byteLength: 8,
      contentType: "application/json" as const,
      eventCount: 1,
      generatedAt: timestamp,
    };
    const generating = transitionDiagnosticExport(request(), "generating");

    expect(() =>
      transitionDiagnosticExport(generating, "failed", {
        artifact,
        failureCode: "storage.unavailable",
      }),
    ).toThrow(/only a ready/iu);
    expect(() =>
      transitionDiagnosticExport(generating, "ready", {
        artifact,
        failureCode: "storage.unavailable",
      }),
    ).toThrow(/only a failed/iu);
    expect(
      toDiagnosticExportStatus({ ...generating, artifact } as never),
    ).toEqual({
      id: "diagnostic-export-1",
      status: "generating",
      eventCutoffAt: timestamp,
      expiresAt: "2026-07-16T12:00:00.000Z",
    });
  });

  it("projects an explicit public status allowlist even if persistence supplies locator-like fields", () => {
    const ready = transitionDiagnosticExport(
      transitionDiagnosticExport(request(), "generating"),
      "ready",
      {
        artifact: {
          contentSha256: createHash("sha256").update("artifact").digest("hex"),
          byteLength: 8,
          contentType: "application/json",
          eventCount: 1,
          generatedAt: timestamp,
          objectKey: "private/diagnostics/diagnostic-export-1.json",
          signedDownloadUrl: "https://storage.example/private",
          handle: {
            workspaceId: "workspace-1",
            exportId: "diagnostic-export-1",
          },
        } as never,
      },
    );

    const dto = toDiagnosticExportStatus(ready);
    expect(dto).toEqual({
      id: "diagnostic-export-1",
      status: "ready",
      eventCutoffAt: timestamp,
      expiresAt: "2026-07-16T12:00:00.000Z",
      generatedAt: timestamp,
    });
    expect(JSON.stringify(dto)).not.toMatch(
      /objectKey|signedDownloadUrl|handle|workspaceId/u,
    );
  });
});
