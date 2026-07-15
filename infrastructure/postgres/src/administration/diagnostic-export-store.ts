import { randomUUID } from "node:crypto";

import {
  IdempotencyConflictError,
  type DiagnosticExportRequest,
  type DiagnosticExportRequestMutationStore,
  type DiagnosticExportRequestStore,
} from "@caseweaver/administration";
import type { EnvelopeFor } from "@caseweaver/domain";
import type { AuditRecord } from "@caseweaver/security";
import type {
  AdministrationDiagnosticExport,
  Prisma,
  PrismaClient,
} from "@prisma/client";

const operation = "diagnostics.export";
const claimLeaseMs = 300_000;

function requireMaintenanceLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new RangeError(
      "Diagnostic export maintenance limit must be between 1 and 100.",
    );
  }
  return value;
}

interface ExportRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly requested_by_principal_id: string;
  readonly status: string;
  readonly event_cutoff_at: Date;
  readonly maximum_events: number;
  readonly expires_at: Date;
  readonly artifact_storage_key: string | null;
  readonly content_sha256: string | null;
  readonly byte_length: number | null;
  readonly content_type: string | null;
  readonly event_count: number | null;
  readonly generated_at: Date | null;
  readonly failure_code: string | null;
  readonly created_at: Date;
}

type RequestDatabase = PrismaClient | Prisma.TransactionClient;
type DiagnosticRequestInput = Parameters<
  DiagnosticExportRequestStore["request"]
>[0];
type DiagnosticRequestResult = Readonly<{
  readonly request: DiagnosticExportRequest;
  readonly replayed: boolean;
}>;

function asDate(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new RangeError("Diagnostic export timestamp is invalid.");
  }
  return parsed;
}

function asRequest(row: ExportRow): DiagnosticExportRequest {
  if (
    ![
      "requested",
      "generating",
      "ready",
      "failed",
      "expired",
      "deleted",
    ].includes(row.status) ||
    !Number.isInteger(row.maximum_events) ||
    row.maximum_events < 1 ||
    row.maximum_events > 1_000
  ) {
    throw new Error("Persisted diagnostic export is invalid.");
  }
  const failureCode = row.failure_code;
  if (
    failureCode !== null &&
    failureCode !== "source.unavailable" &&
    failureCode !== "content.tooLarge" &&
    failureCode !== "storage.unavailable"
  ) {
    throw new Error("Persisted diagnostic export failure is invalid.");
  }
  const hasArtifact = row.artifact_storage_key !== null;
  if (
    hasArtifact &&
    (row.artifact_storage_key === null ||
      row.content_sha256 === null ||
      row.byte_length === null ||
      row.content_type !== "application/json" ||
      row.event_count === null ||
      row.generated_at === null)
  ) {
    throw new Error("Persisted diagnostic export artifact is invalid.");
  }
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspace_id,
    requestedByPrincipalId: row.requested_by_principal_id,
    status: row.status as DiagnosticExportRequest["status"],
    eventCutoffAt: row.event_cutoff_at.toISOString(),
    maximumEvents: row.maximum_events,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    ...(hasArtifact
      ? {
          artifact: {
            contentSha256: row.content_sha256 as string,
            byteLength: row.byte_length as number,
            contentType: "application/json" as const,
            eventCount: row.event_count as number,
            generatedAt: (row.generated_at as Date).toISOString(),
          },
          artifactLocator: { storageKey: row.artifact_storage_key as string },
        }
      : {}),
    ...(failureCode === null
      ? {}
      : {
          failureCode: failureCode as NonNullable<
            DiagnosticExportRequest["failureCode"]
          >,
        }),
  });
}

function fromModel(row: AdministrationDiagnosticExport): ExportRow {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    requested_by_principal_id: row.requestedByPrincipalId,
    status: row.status,
    event_cutoff_at: row.eventCutoffAt,
    maximum_events: row.maximumEvents,
    expires_at: row.expiresAt,
    artifact_storage_key: row.artifactStorageKey,
    content_sha256: row.contentSha256,
    byte_length: row.byteLength,
    content_type: row.contentType,
    event_count: row.eventCount,
    generated_at: row.generatedAt,
    failure_code: row.failureCode,
    created_at: row.createdAt,
  };
}

function outboxRecord(
  envelope: EnvelopeFor<"diagnostics.export.generate.v1">,
): Prisma.OutboxEnvelopeCreateInput {
  return {
    id: envelope.id,
    workspace: { connect: { id: envelope.workspaceId } },
    kind: envelope.kind,
    type: envelope.type,
    schemaVersion: envelope.schemaVersion,
    occurredAt: asDate(envelope.occurredAt),
    correlationId: envelope.correlationId,
    causationId: envelope.causationId,
    ...(envelope.traceContext === undefined
      ? {}
      : {
          traceContext: {
            traceparent: envelope.traceContext.traceparent,
            ...(envelope.traceContext.tracestate === undefined
              ? {}
              : { tracestate: envelope.traceContext.tracestate }),
          },
        }),
    payload: envelope.payload as Prisma.InputJsonValue,
    availableAt: asDate(envelope.occurredAt),
  };
}

async function appendAudit(
  database: RequestDatabase,
  record: AuditRecord,
): Promise<void> {
  await database.auditEvent.create({
    data: {
      id: record.id,
      workspaceId: record.workspaceId,
      actorPrincipalId: record.actorPrincipalId,
      action: record.action,
      targetId: record.targetId,
      beforeHash: record.beforeHash,
      afterHash: record.afterHash,
      occurredAt: asDate(record.occurredAt),
      origin: record.origin,
      targetType: record.targetType,
      outcome: record.outcome,
      permission: record.permission,
      reasonCode: record.reasonCode,
      uiActionId: record.uiActionId,
      requestId: record.requestId,
      correlationId: record.correlationId,
      traceId: record.traceId,
      idempotencyKeyDigest: record.idempotencyKeyDigest,
      clientAddress: record.clientAddress,
      userAgent: record.userAgent,
    },
  });
}

/** PostgreSQL durable, workspace-scoped diagnostic export lifecycle store. */
export class PostgresDiagnosticExportStore
  implements DiagnosticExportRequestStore, DiagnosticExportRequestMutationStore
{
  public constructor(private readonly client: PrismaClient) {}

  public async request(
    input: DiagnosticRequestInput,
  ): Promise<DiagnosticRequestResult> {
    return this.client.$transaction((database) =>
      this.requestWithin(database, input),
    );
  }

  public async requestAndEnqueueAndRecord(input: {
    readonly request: DiagnosticExportRequest;
    readonly idempotencyKeyDigest: string;
    readonly requestDigest: string;
    readonly envelope: EnvelopeFor<"diagnostics.export.generate.v1">;
    readonly audit: AuditRecord;
  }): Promise<DiagnosticRequestResult> {
    return this.client.$transaction(async (database) => {
      const result = await this.requestWithin(database, input);
      if (!result.replayed) {
        await database.outboxEnvelope.create({
          data: outboxRecord(input.envelope),
        });
      }
      await appendAudit(database, input.audit);
      return result;
    });
  }

  private async requestWithin(
    database: RequestDatabase,
    input: DiagnosticRequestInput,
  ): Promise<DiagnosticRequestResult> {
    const lockKey = `${input.request.workspaceId}:${operation}:${input.idempotencyKeyDigest}`;
    await database.$queryRaw`
      SELECT 1 AS locked
      FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    `;
    const existing = await database.idempotencyRecord.findUnique({
      where: {
        workspaceId_operation_keyDigest: {
          workspaceId: input.request.workspaceId,
          operation,
          keyDigest: input.idempotencyKeyDigest,
        },
      },
    });
    if (existing !== null) {
      if (existing.requestDigest !== input.requestDigest) {
        throw new IdempotencyConflictError();
      }
      const replay = await database.administrationDiagnosticExport.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.request.workspaceId,
            id: existing.resourceId,
          },
        },
      });
      if (replay === null) {
        throw new Error("Diagnostic export idempotency state is incomplete.");
      }
      return Object.freeze({
        request: asRequest(fromModel(replay)),
        replayed: true,
      });
    }
    const created = await database.administrationDiagnosticExport.create({
      data: {
        id: input.request.id,
        workspaceId: input.request.workspaceId,
        requestedByPrincipalId: input.request.requestedByPrincipalId,
        status: "requested",
        eventCutoffAt: asDate(input.request.eventCutoffAt),
        maximumEvents: input.request.maximumEvents,
        expiresAt: asDate(input.request.expiresAt),
        createdAt: asDate(input.request.createdAt),
      },
    });
    await database.idempotencyRecord.create({
      data: {
        workspaceId: input.request.workspaceId,
        operation,
        keyDigest: input.idempotencyKeyDigest,
        requestDigest: input.requestDigest,
        resourceId: input.request.id,
        createdAt: asDate(input.request.createdAt),
      },
    });
    return Object.freeze({
      request: asRequest(fromModel(created)),
      replayed: false,
    });
  }

  public async find(
    input: Parameters<DiagnosticExportRequestStore["find"]>[0],
  ): Promise<DiagnosticExportRequest | undefined> {
    const row = await this.client.administrationDiagnosticExport.findUnique({
      where: {
        workspaceId_id: { workspaceId: input.workspaceId, id: input.exportId },
      },
    });
    return row === null ? undefined : asRequest(fromModel(row));
  }

  public async claimGeneration(
    input: Parameters<DiagnosticExportRequestStore["claimGeneration"]>[0],
  ): Promise<DiagnosticExportRequest | undefined> {
    const claimToken = randomUUID();
    const now = asDate(input.now);
    const rows = await this.client.$queryRaw<readonly ExportRow[]>`
      UPDATE administration_diagnostic_exports
      SET status = 'generating', generation_claim_token = ${claimToken},
          generation_claimed_until = ${new Date(now.getTime() + claimLeaseMs)},
          generation_attempts = generation_attempts + 1, updated_at = NOW()
      WHERE workspace_id = ${input.workspaceId} AND id = ${input.exportId}
        AND expires_at > ${now}
        AND (status = 'requested' OR (status = 'generating' AND generation_claimed_until <= ${now}))
      RETURNING id, workspace_id, requested_by_principal_id, status, event_cutoff_at,
        maximum_events, expires_at, artifact_storage_key, content_sha256, byte_length,
        content_type, event_count, generated_at, failure_code, created_at
    `;
    const row = rows[0];
    return row === undefined ? undefined : asRequest(row);
  }

  public async markReady(
    input: Parameters<DiagnosticExportRequestStore["markReady"]>[0],
  ): Promise<void> {
    const result = await this.client.administrationDiagnosticExport.updateMany({
      where: {
        workspaceId: input.workspaceId,
        id: input.exportId,
        status: "generating",
        expiresAt: { gt: new Date() },
      },
      data: {
        status: "ready",
        artifactStorageKey: input.locator.storageKey,
        contentSha256: input.artifact.contentSha256,
        byteLength: input.artifact.byteLength,
        contentType: input.artifact.contentType,
        eventCount: input.artifact.eventCount,
        generatedAt: asDate(input.artifact.generatedAt),
        generationClaimToken: null,
        generationClaimedUntil: null,
      },
    });
    if (result.count !== 1)
      throw new Error(
        "Diagnostic export generation claim is no longer active.",
      );
  }

  public async markFailed(
    input: Parameters<DiagnosticExportRequestStore["markFailed"]>[0],
  ): Promise<void> {
    await this.client.administrationDiagnosticExport.updateMany({
      where: {
        workspaceId: input.workspaceId,
        id: input.exportId,
        status: "generating",
      },
      data: {
        status: "failed",
        failureCode: input.failureCode,
        generationClaimToken: null,
        generationClaimedUntil: null,
      },
    });
  }

  public async expireDue(
    input: Parameters<DiagnosticExportRequestStore["expireDue"]>[0],
  ): Promise<number> {
    const limit = requireMaintenanceLimit(input.limit);
    const rows = await this.client.$queryRaw<
      readonly { readonly id: string }[]
    >`
      WITH selected AS (
        SELECT id FROM administration_diagnostic_exports
        WHERE status IN ('requested', 'generating', 'ready', 'failed')
          AND expires_at <= ${asDate(input.now)}
        ORDER BY expires_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED
      )
      UPDATE administration_diagnostic_exports AS export
      SET status = 'expired', generation_claim_token = NULL,
          generation_claimed_until = NULL, updated_at = NOW()
      FROM selected WHERE export.id = selected.id
      RETURNING export.id
    `;
    return rows.length;
  }

  public async claimDeletion(
    input: Parameters<DiagnosticExportRequestStore["claimDeletion"]>[0],
  ): Promise<
    readonly Readonly<{
      readonly request: DiagnosticExportRequest;
      readonly claimToken: string;
    }>[]
  > {
    const limit = requireMaintenanceLimit(input.limit);
    const claimToken = randomUUID();
    const now = asDate(input.now);
    const rows = await this.client.$queryRaw<readonly ExportRow[]>`
      WITH selected AS (
        SELECT id FROM administration_diagnostic_exports
        WHERE status = 'expired' AND (deletion_claimed_until IS NULL OR deletion_claimed_until <= ${now})
        ORDER BY expires_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED
      )
      UPDATE administration_diagnostic_exports AS export
      SET deletion_claim_token = ${claimToken},
          deletion_claimed_until = ${new Date(now.getTime() + claimLeaseMs)},
          deletion_attempts = export.deletion_attempts + 1, updated_at = NOW()
      FROM selected WHERE export.id = selected.id
      RETURNING export.id, export.workspace_id, export.requested_by_principal_id,
        export.status, export.event_cutoff_at, export.maximum_events, export.expires_at,
        export.artifact_storage_key, export.content_sha256, export.byte_length,
        export.content_type, export.event_count, export.generated_at, export.failure_code,
        export.created_at
    `;
    return Object.freeze(
      rows.map((row) => Object.freeze({ request: asRequest(row), claimToken })),
    );
  }

  public async markDeleted(
    input: Parameters<DiagnosticExportRequestStore["markDeleted"]>[0],
  ): Promise<void> {
    const result = await this.client.administrationDiagnosticExport.updateMany({
      where: {
        workspaceId: input.workspaceId,
        id: input.exportId,
        status: "expired",
        deletionClaimToken: input.claimToken,
      },
      data: {
        status: "deleted",
        deletedAt: new Date(),
        artifactStorageKey: null,
        failureCode: null,
        deletionClaimToken: null,
        deletionClaimedUntil: null,
      },
    });
    if (result.count !== 1)
      throw new Error("Diagnostic export deletion claim is no longer active.");
  }
}
