import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import {
  auditEventId,
  causationId,
  correlationId,
  createEnvelope,
  outboxEnvelopeId,
  principalId,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";

import {
  PostgresDiagnosticExportArtifactStore,
  PostgresDiagnosticExportSource,
} from "./diagnostic-export-artifact-store.js";
import { PostgresDiagnosticExportDispatchStore } from "./diagnostic-export-dispatch-store.js";
import { PostgresDiagnosticExportStore } from "./diagnostic-export-store.js";

const databaseUrl = process.env.DATABASE_URL;
if (
  databaseUrl === undefined ||
  !new URL(databaseUrl).pathname.toLowerCase().includes("test")
) {
  throw new Error(
    "Diagnostic export tests require a disposable test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const digest = (character: string) => character.repeat(64);
const request = (
  overrides: Partial<{
    readonly id: string;
    readonly workspaceId: string;
    readonly expiresAt: string;
  }> = {},
) => ({
  id: "diagnostic-export-1",
  workspaceId: "workspace-a",
  requestedByPrincipalId: "principal-a",
  status: "requested" as const,
  eventCutoffAt: "2026-07-15T12:00:00.000Z",
  maximumEvents: 1_000,
  createdAt: "2026-07-15T12:00:00.000Z",
  expiresAt: "2030-07-16T12:00:00.000Z",
  ...overrides,
});

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE workspaces RESTART IDENTITY CASCADE");
  await pool.query(
    "INSERT INTO workspaces (id) VALUES ('workspace-a'), ('workspace-b')",
  );
  await pool.query(
    "INSERT INTO principals (id, workspace_id) VALUES ('principal-a', 'workspace-a'), ('principal-b', 'workspace-b')",
  );
});

function store(): {
  readonly client: PrismaClient;
  readonly value: PostgresDiagnosticExportStore;
} {
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  return { client, value: new PostgresDiagnosticExportStore(client) };
}

function requireSingle<T>(values: readonly T[]): T {
  const [value] = values;
  if (value === undefined)
    throw new Error("Expected exactly one claimed export.");
  return value;
}

describe("PostgresDiagnosticExportStore", () => {
  it("commits the request, worker envelope, and success audit atomically", async () => {
    const value = store();
    try {
      const accepted = await value.value.requestAndEnqueueAndRecord({
        request: request(),
        idempotencyKeyDigest: digest("a"),
        requestDigest: digest("b"),
        envelope: createEnvelope<"diagnostics.export.generate.v1">({
          id: outboxEnvelopeId("outbox-diagnostic-export-1"),
          kind: "command",
          type: "diagnostics.export.generate.v1",
          schemaVersion: 1,
          workspaceId: workspaceId("workspace-a"),
          occurredAt: utcInstant("2026-07-15T12:00:00.000Z"),
          correlationId: correlationId("correlation-1"),
          causationId: causationId("causation-1"),
          payload: { exportId: "diagnostic-export-1" },
        }),
        audit: {
          id: auditEventId("audit-diagnostic-export-1"),
          workspaceId: workspaceId("workspace-a"),
          actorPrincipalId: principalId("principal-a"),
          action: "admin.diagnostics.export.requested",
          targetId: "diagnostic-export-1",
          targetType: "diagnostic_export",
          permission: "diagnostics.export",
          outcome: "succeeded",
          origin: "admin_ui",
          occurredAt: utcInstant("2026-07-15T12:00:00.000Z"),
          requestId: "request-1",
          correlationId: "correlation-1",
          idempotencyKeyDigest: digest("a"),
        },
      });
      expect(accepted.replayed).toBe(false);
      await expect(
        value.client.outboxEnvelope.findUnique({
          where: { id: "outbox-diagnostic-export-1" },
        }),
      ).resolves.toMatchObject({ type: "diagnostics.export.generate.v1" });
      await expect(
        value.client.auditEvent.findUnique({
          where: { id: "audit-diagnostic-export-1" },
        }),
      ).resolves.toMatchObject({
        action: "admin.diagnostics.export.requested",
      });
      const dispatch = new PostgresDiagnosticExportDispatchStore(value.client);
      const claimed = await dispatch.claim({
        limit: 1,
        leaseMs: 30_000,
        now: "2026-07-15T12:00:01.000Z",
      });
      expect(claimed).toMatchObject([
        {
          envelope: {
            type: "diagnostics.export.generate.v1",
            payload: { exportId: "diagnostic-export-1" },
          },
        },
      ]);
      await dispatch.acknowledge({
        claim: requireSingle(claimed),
        deliveredAt: "2026-07-15T12:00:02.000Z",
      });
      await expect(
        dispatch.claim({
          limit: 1,
          leaseMs: 30_000,
          now: "2026-07-15T12:00:03.000Z",
        }),
      ).resolves.toEqual([]);

      await expect(
        value.value.requestAndEnqueueAndRecord({
          request: request({ id: "diagnostic-export-2" }),
          idempotencyKeyDigest: digest("c"),
          requestDigest: digest("d"),
          envelope: createEnvelope<"diagnostics.export.generate.v1">({
            id: outboxEnvelopeId("outbox-diagnostic-export-2"),
            kind: "command",
            type: "diagnostics.export.generate.v1",
            schemaVersion: 1,
            workspaceId: workspaceId("workspace-a"),
            occurredAt: utcInstant("2026-07-15T12:00:00.000Z"),
            correlationId: correlationId("correlation-2"),
            causationId: causationId("causation-2"),
            payload: { exportId: "diagnostic-export-2" },
          }),
          audit: {
            id: auditEventId("audit-diagnostic-export-2"),
            workspaceId: workspaceId("workspace-missing"),
            actorPrincipalId: principalId("principal-a"),
            action: "admin.diagnostics.export.requested",
            targetId: "diagnostic-export-2",
            targetType: "diagnostic_export",
            permission: "diagnostics.export",
            outcome: "succeeded",
            origin: "admin_ui",
            occurredAt: utcInstant("2026-07-15T12:00:00.000Z"),
          },
        }),
      ).rejects.toThrow();
      await expect(
        value.value.find({
          workspaceId: "workspace-a",
          exportId: "diagnostic-export-2",
        }),
      ).resolves.toBeUndefined();
      await expect(
        value.client.outboxEnvelope.findUnique({
          where: { id: "outbox-diagnostic-export-2" },
        }),
      ).resolves.toBeNull();
    } finally {
      await value.client.$disconnect();
    }
  });

  it("persists an idempotent workspace-scoped request without exposing private artifact state", async () => {
    const value = store();
    try {
      const first = await value.value.request({
        request: request(),
        idempotencyKeyDigest: digest("a"),
        requestDigest: digest("b"),
      });
      const replay = await value.value.request({
        request: request(),
        idempotencyKeyDigest: digest("a"),
        requestDigest: digest("b"),
      });
      expect(first.replayed).toBe(false);
      expect(replay).toMatchObject({
        replayed: true,
        request: { id: "diagnostic-export-1" },
      });
      await expect(
        value.value.request({
          request: request(),
          idempotencyKeyDigest: digest("a"),
          requestDigest: digest("c"),
        }),
      ).rejects.toMatchObject({ code: "administration.idempotencyConflict" });
      await expect(
        value.value.find({
          workspaceId: "workspace-b",
          exportId: "diagnostic-export-1",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await value.client.$disconnect();
    }
  });

  it("leases generation, retains private locator only internally, and expiry deletion is fenced", async () => {
    const value = store();
    try {
      await value.value.request({
        request: request(),
        idempotencyKeyDigest: digest("a"),
        requestDigest: digest("b"),
      });
      const claimed = await value.value.claimGeneration({
        workspaceId: "workspace-a",
        exportId: "diagnostic-export-1",
        now: "2026-07-15T12:01:00.000Z",
      });
      expect(claimed?.status).toBe("generating");
      await value.value.markReady({
        workspaceId: "workspace-a",
        exportId: "diagnostic-export-1",
        locator: { storageKey: "private/never-public" },
        artifact: {
          contentSha256: digest("d"),
          byteLength: 8,
          contentType: "application/json",
          eventCount: 1,
          generatedAt: "2026-07-15T12:02:00.000Z",
        },
      });
      const ready = await value.value.find({
        workspaceId: "workspace-a",
        exportId: "diagnostic-export-1",
      });
      expect(ready).toMatchObject({
        status: "ready",
        artifactLocator: { storageKey: "private/never-public" },
      });
      await expect(
        value.value.expireDue({ now: "2031-01-01T00:00:00.000Z", limit: 10 }),
      ).resolves.toBe(1);
      const deletion = await value.value.claimDeletion({
        now: "2031-01-01T00:00:01.000Z",
        limit: 10,
      });
      expect(deletion).toHaveLength(1);
      await value.value.markDeleted({
        workspaceId: "workspace-a",
        exportId: "diagnostic-export-1",
        claimToken: requireSingle(deletion).claimToken,
      });
      await expect(
        value.value.find({
          workspaceId: "workspace-a",
          exportId: "diagnostic-export-1",
        }),
      ).resolves.toMatchObject({ status: "deleted" });
    } finally {
      await value.client.$disconnect();
    }
  });

  it("allows failed exports to expire and delete, while rejecting a stale deletion claim", async () => {
    const value = store();
    try {
      await value.value.request({
        request: request(),
        idempotencyKeyDigest: digest("a"),
        requestDigest: digest("b"),
      });
      await value.value.claimGeneration({
        workspaceId: "workspace-a",
        exportId: "diagnostic-export-1",
        now: "2026-07-15T12:01:00.000Z",
      });
      await value.value.markFailed({
        workspaceId: "workspace-a",
        exportId: "diagnostic-export-1",
        failureCode: "source.unavailable",
      });
      await expect(
        value.value.expireDue({ now: "2031-01-01T00:00:00.000Z", limit: 1 }),
      ).resolves.toBe(1);
      const deletion = await value.value.claimDeletion({
        now: "2031-01-01T00:00:01.000Z",
        limit: 1,
      });
      expect(deletion).toHaveLength(1);
      await expect(
        value.value.markDeleted({
          workspaceId: "workspace-a",
          exportId: "diagnostic-export-1",
          claimToken: "stale-claim",
        }),
      ).rejects.toThrow("claim");
      await value.value.markDeleted({
        workspaceId: "workspace-a",
        exportId: "diagnostic-export-1",
        claimToken: requireSingle(deletion).claimToken,
      });
      const deleted = await value.value.find({
        workspaceId: "workspace-a",
        exportId: "diagnostic-export-1",
      });
      expect(deleted).toMatchObject({ status: "deleted" });
      expect(deleted).not.toHaveProperty("failureCode");
      expect(deleted).not.toHaveProperty("artifactLocator");
    } finally {
      await value.client.$disconnect();
    }
  });

  it("rejects unbounded maintenance scans before issuing a claim query", async () => {
    const value = store();
    try {
      await expect(
        value.value.expireDue({
          now: "2031-01-01T00:00:00.000Z",
          limit: 0,
        }),
      ).rejects.toThrow("limit");
      await expect(
        value.value.claimDeletion({
          now: "2031-01-01T00:00:00.000Z",
          limit: 101,
        }),
      ).rejects.toThrow("limit");
    } finally {
      await value.client.$disconnect();
    }
  });

  it("stores bounded private bytes, rejects cross-workspace locators, and exports only audit-safe fields", async () => {
    const value = store();
    try {
      await value.value.request({
        request: request(),
        idempotencyKeyDigest: digest("a"),
        requestDigest: digest("b"),
      });
      await value.value.claimGeneration({
        workspaceId: "workspace-a",
        exportId: "diagnostic-export-1",
        now: "2026-07-15T12:01:00.000Z",
      });
      const artifacts = new PostgresDiagnosticExportArtifactStore(value.client);
      const locator = await artifacts.write({
        handle: { workspaceId: "workspace-a", exportId: "diagnostic-export-1" },
        content: new TextEncoder().encode('{"safe":true}'),
        contentType: "application/json",
        signal: new AbortController().signal,
      });
      const chunks: Uint8Array[] = [];
      for await (const chunk of await artifacts.open({
        handle: { workspaceId: "workspace-a", exportId: "diagnostic-export-1" },
        locator,
        signal: new AbortController().signal,
      }))
        chunks.push(chunk);
      expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe(
        '{"safe":true}',
      );
      await expect(
        artifacts.open({
          handle: {
            workspaceId: "workspace-b",
            exportId: "diagnostic-export-1",
          },
          locator,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("denied");
      await expect(
        artifacts.open({
          handle: {
            workspaceId: "workspace-a",
            exportId: "diagnostic-export-1",
          },
          locator: { storageKey: "https://attacker.invalid/artifact" },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("denied");
      await expect(
        artifacts.delete({
          handle: {
            workspaceId: "workspace-b",
            exportId: "diagnostic-export-1",
          },
          locator,
        }),
      ).rejects.toThrow("denied");
      await expect(
        artifacts.open({
          handle: {
            workspaceId: "workspace-a",
            exportId: "diagnostic-export-1",
          },
          locator,
          signal: new AbortController().signal,
        }),
      ).resolves.toBeDefined();
      await expect(
        artifacts.write({
          handle: {
            workspaceId: "workspace-a",
            exportId: "diagnostic-export-1",
          },
          content: new Uint8Array(1_048_577),
          contentType: "application/json",
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("bound");

      await value.client.auditEvent.create({
        data: {
          id: "audit-1",
          workspaceId: "workspace-a",
          action: "admin.diagnostics.export",
          targetId: "sensitive-target-id",
          targetType: "diagnostics",
          outcome: "succeeded",
          permission: "diagnostics.export",
          reasonCode: "source.unavailable",
          requestId: "sensitive-request",
          correlationId: "sensitive-correlation",
          userAgent: "sensitive-agent",
          occurredAt: new Date("2026-07-15T12:00:00.000Z"),
        },
      });
      const events = await new PostgresDiagnosticExportSource(
        value.client,
      ).snapshot({
        workspaceId: "workspace-a",
        cutoffAt: "2026-07-15T12:01:00.000Z",
        maximumEvents: 10,
      });
      expect(events).toEqual([
        expect.objectContaining({
          name: "administration.audit",
          attributes: {
            action: "admin.diagnostics.export",
            outcome: "succeeded",
            targetType: "diagnostics",
            permission: "diagnostics.export",
            reasonCode: "source.unavailable",
          },
        }),
      ]);
      expect(JSON.stringify(events)).not.toMatch(
        /sensitive-target|sensitive-request|sensitive-correlation|sensitive-agent/u,
      );
    } finally {
      await value.client.$disconnect();
    }
  });

  it("enforces artifact byte integrity at the database boundary", async () => {
    const value = store();
    try {
      await value.value.request({
        request: request(),
        idempotencyKeyDigest: digest("a"),
        requestDigest: digest("b"),
      });
      await expect(value.client.$executeRaw`
        INSERT INTO administration_diagnostic_export_artifacts (
          workspace_id, export_id, content, content_sha256, byte_length, content_type
        ) VALUES (
          ${"workspace-a"}, ${"diagnostic-export-1"}, ${Buffer.from("two")},
          ${digest("a")}, ${1}, ${"application/json"}
        )
      `).rejects.toThrow();
      await expect(value.client.$executeRaw`
        INSERT INTO administration_diagnostic_export_artifacts (
          workspace_id, export_id, content, content_sha256, byte_length, content_type
        ) VALUES (
          ${"workspace-a"}, ${"diagnostic-export-1"}, ${Buffer.alloc(1_048_577)},
          ${digest("a")}, ${1_048_577}, ${"application/json"}
        )
      `).rejects.toThrow();
    } finally {
      await value.client.$disconnect();
    }
  });
});
