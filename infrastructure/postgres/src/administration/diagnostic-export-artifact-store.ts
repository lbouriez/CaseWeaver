import { createHash } from "node:crypto";

import type {
  DiagnosticExportArtifactHandle,
  DiagnosticExportArtifactLocator,
  DiagnosticExportArtifactStore,
  DiagnosticExportSource,
  RedactedDiagnosticExportEvent,
} from "@caseweaver/administration";
import type { PrismaClient } from "@prisma/client";

const maximumBytes = 1_048_576;
const chunkBytes = 64 * 1024;

function requireIdentifier(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)) {
    throw new RangeError(`Diagnostic export ${field} is invalid.`);
  }
  return value;
}

function locatorFor(
  handle: DiagnosticExportArtifactHandle,
): DiagnosticExportArtifactLocator {
  return Object.freeze({
    storageKey: `postgresql:diagnostic-export:${handle.workspaceId}:${handle.exportId}`,
  });
}

function verifyLocator(
  handle: DiagnosticExportArtifactHandle,
  locator: DiagnosticExportArtifactLocator,
): void {
  if (locator.storageKey !== locatorFor(handle).storageKey) {
    throw new Error("Diagnostic export artifact access was denied.");
  }
}

function asUtc(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new RangeError("Diagnostic export cutoff is invalid.");
  }
  return date;
}

function safeValue(value: string | null, maximum = 120): string | null {
  if (
    value === null ||
    value.length === 0 ||
    value.length > maximum ||
    !/^[A-Za-z0-9_.:-]+$/u.test(value)
  ) {
    return null;
  }
  return value;
}

/**
 * PBI-016 private artifact adapter. Bytes never leave PostgreSQL except through
 * the authorized API stream; this does not reuse attachment/object-storage paths.
 */
export class PostgresDiagnosticExportArtifactStore
  implements DiagnosticExportArtifactStore
{
  public constructor(private readonly client: PrismaClient) {}

  public async write(
    input: Parameters<DiagnosticExportArtifactStore["write"]>[0],
  ): Promise<DiagnosticExportArtifactLocator> {
    if (input.signal.aborted)
      throw input.signal.reason ?? new Error("Aborted.");
    const handle = {
      workspaceId: requireIdentifier(input.handle.workspaceId, "workspace ID"),
      exportId: requireIdentifier(input.handle.exportId, "ID"),
    };
    if (
      input.contentType !== "application/json" ||
      input.content.byteLength > maximumBytes
    ) {
      throw new RangeError("Diagnostic export artifact exceeds its bound.");
    }
    const exportState =
      await this.client.administrationDiagnosticExport.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: handle.workspaceId,
            id: handle.exportId,
          },
        },
        select: { status: true },
      });
    if (exportState?.status !== "generating") {
      throw new Error("Diagnostic export artifact write was denied.");
    }
    const content = Buffer.from(input.content);
    const contentSha256 = createHash("sha256").update(content).digest("hex");
    await this.client.administrationDiagnosticExportArtifact.upsert({
      where: { workspaceId_exportId: handle },
      create: {
        ...handle,
        content,
        contentSha256,
        byteLength: content.byteLength,
        contentType: "application/json",
      },
      update: {
        content,
        contentSha256,
        byteLength: content.byteLength,
        contentType: "application/json",
      },
    });
    return locatorFor(handle);
  }

  public async open(
    input: Parameters<DiagnosticExportArtifactStore["open"]>[0],
  ): Promise<AsyncIterable<Uint8Array>> {
    if (input.signal.aborted)
      throw input.signal.reason ?? new Error("Aborted.");
    const handle = {
      workspaceId: requireIdentifier(input.handle.workspaceId, "workspace ID"),
      exportId: requireIdentifier(input.handle.exportId, "ID"),
    };
    verifyLocator(handle, input.locator);
    const artifact =
      await this.client.administrationDiagnosticExportArtifact.findUnique({
        where: { workspaceId_exportId: handle },
        select: { content: true, byteLength: true, contentType: true },
      });
    if (
      artifact === null ||
      artifact.contentType !== "application/json" ||
      artifact.byteLength !== artifact.content.byteLength ||
      artifact.byteLength > maximumBytes
    ) {
      throw new Error("Diagnostic export artifact was not found.");
    }
    const content = new Uint8Array(artifact.content);
    return (async function* (): AsyncIterable<Uint8Array> {
      for (let offset = 0; offset < content.byteLength; offset += chunkBytes) {
        if (input.signal.aborted)
          throw input.signal.reason ?? new Error("Aborted.");
        yield content.slice(
          offset,
          Math.min(offset + chunkBytes, content.byteLength),
        );
      }
    })();
  }

  public async delete(
    input: Parameters<DiagnosticExportArtifactStore["delete"]>[0],
  ): Promise<void> {
    const handle = {
      workspaceId: requireIdentifier(input.handle.workspaceId, "workspace ID"),
      exportId: requireIdentifier(input.handle.exportId, "ID"),
    };
    verifyLocator(handle, input.locator);
    await this.client.administrationDiagnosticExportArtifact.deleteMany({
      where: handle,
    });
  }
}

/**
 * Exports only server-owned audit codes. It deliberately omits IDs, hashes,
 * client metadata, free text, payloads, URLs, traces, and diagnostic content.
 */
export class PostgresDiagnosticExportSource implements DiagnosticExportSource {
  public constructor(private readonly client: PrismaClient) {}

  public async snapshot(
    input: Parameters<DiagnosticExportSource["snapshot"]>[0],
  ): Promise<readonly RedactedDiagnosticExportEvent[]> {
    const workspaceId = requireIdentifier(input.workspaceId, "workspace ID");
    if (
      !Number.isInteger(input.maximumEvents) ||
      input.maximumEvents < 1 ||
      input.maximumEvents > 1_000
    ) {
      throw new RangeError("Diagnostic export event limit is invalid.");
    }
    const rows = await this.client.auditEvent.findMany({
      where: { workspaceId, occurredAt: { lte: asUtc(input.cutoffAt) } },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: input.maximumEvents,
      select: {
        action: true,
        outcome: true,
        targetType: true,
        permission: true,
        reasonCode: true,
        occurredAt: true,
      },
    });
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          name: "administration.audit",
          occurredAt: row.occurredAt.toISOString(),
          severity:
            row.outcome === "failed" || row.outcome === "denied"
              ? "warn"
              : "info",
          attributes: Object.freeze({
            action: safeValue(row.action),
            outcome: safeValue(row.outcome),
            targetType: safeValue(row.targetType),
            permission: safeValue(row.permission),
            reasonCode: safeValue(row.reasonCode),
          }),
        }),
      ),
    );
  }
}
