import type {
  ApplicationTransaction,
  CostAttributionQuery,
  CostAttributionRecord,
  DeadLetterRecord,
  OperationsStore,
  RetentionWorkItem,
} from "@caseweaver/application";
import {
  type AnalysisJob,
  analysisIdentityId,
  analysisJobId,
  type UtcInstant,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import type { Prisma } from "@prisma/client";

import type { PostgresTransactionLookup } from "../index.js";

type OperationsUnitOfWork = PostgresTransactionLookup;

interface JobRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly analysis_identity_id: string;
  readonly run_ordinal: number;
  readonly state: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface DeadLetterRow {
  readonly job_id: string;
  readonly analysis_identity_id: string;
  readonly finished_at: Date;
  readonly error_code: string;
  readonly error_retryable: boolean;
  readonly attempt_ordinal: number;
}

interface CostRow {
  readonly operation_id: string;
  readonly parent_operation_id: string | null;
  readonly analysis_job_id: string | null;
  readonly connector_instance_id: string | null;
  readonly source_id: string | null;
  readonly role: string;
  readonly configured_model: string;
  readonly started_at: Date;
  readonly finished_at: Date | null;
  readonly status: string;
  readonly calculated_amount: string | null;
  readonly currency: string | null;
  readonly provider_reported_amount: string | null;
  readonly calculation_status: string;
}

interface SnapshotRow {
  readonly id: string;
  readonly external_reference_id: string;
  readonly snapshot_hash: string;
  readonly snapshot: Prisma.JsonValue;
}

interface StoredWorkItemRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly storage_key: string | null;
}

interface ClaimedWorkItemRow extends StoredWorkItemRow {
  readonly fencing_token: bigint;
}

interface CompletedWorkItemRow {
  readonly target_kind: "attachmentBlob" | "attachmentDerivative";
  readonly target_id: string;
}

function toJob(row: JobRow): AnalysisJob {
  if (
    row.state !== "queued" &&
    row.state !== "running" &&
    row.state !== "completed" &&
    row.state !== "failed" &&
    row.state !== "cancelled"
  ) {
    throw new Error("Persisted operational job state is invalid.");
  }
  return Object.freeze({
    id: analysisJobId(row.id),
    workspaceId: workspaceId(row.workspace_id),
    analysisIdentityId: analysisIdentityId(row.analysis_identity_id),
    runOrdinal: row.run_ordinal,
    state: row.state,
    createdAt: utcInstant(row.created_at),
    updatedAt: utcInstant(row.updated_at),
  });
}

function asDate(value: UtcInstant): Date {
  return new Date(value);
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function asObject(value: Prisma.JsonValue): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function stringField(
  value: Readonly<Record<string, unknown>>,
  field: string,
  fallback: string,
): string {
  const candidate = value[field];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : fallback;
}

function toWorkItem(row: StoredWorkItemRow): RetentionWorkItem {
  return Object.freeze({
    id: row.id,
    workspaceId: workspaceId(row.workspace_id),
    ...(row.storage_key === null ? {} : { storageKey: row.storage_key }),
  });
}

/**
 * SQL is intentionally scoped to operational tables. All identifiers and
 * values are bound parameters; no queue payload or sensitive content is
 * inspected to determine operator-visible state.
 */
export class PostgresOperationsStore implements OperationsStore {
  public constructor(private readonly transactions: OperationsUnitOfWork) {}

  public async lockAction(
    transaction: ApplicationTransaction,
    input: Parameters<OperationsStore["lockAction"]>[1],
  ): Promise<void> {
    await this.transactions.get(transaction).$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          ${`${input.workspaceId}:${input.action}:${input.keyDigest}`},
          0
        )
      )
    `;
  }

  public async findAction(
    transaction: ApplicationTransaction,
    input: Parameters<OperationsStore["findAction"]>[1],
  ) {
    const row = await this.transactions
      .get(transaction)
      .idempotencyRecord.findUnique({
        where: {
          workspaceId_operation_keyDigest: {
            workspaceId: input.workspaceId,
            operation: input.action,
            keyDigest: input.keyDigest,
          },
        },
      });
    return row === null
      ? undefined
      : Object.freeze({
          requestDigest: row.requestDigest as Parameters<
            OperationsStore["recordAction"]
          >[1]["requestDigest"],
          resourceId: row.resourceId,
        });
  }

  public async recordAction(
    transaction: ApplicationTransaction,
    input: Parameters<OperationsStore["recordAction"]>[1],
  ): Promise<void> {
    await this.transactions.get(transaction).idempotencyRecord.create({
      data: {
        workspaceId: input.workspaceId,
        operation: input.action,
        keyDigest: input.keyDigest,
        requestDigest: input.requestDigest,
        resourceId: input.resourceId,
        createdAt: asDate(input.occurredAt),
      },
    });
  }

  public async inspectDeadLetters(
    transaction: ApplicationTransaction,
    input: Parameters<OperationsStore["inspectDeadLetters"]>[1],
  ): Promise<readonly DeadLetterRecord[]> {
    const rows = await this.transactions.get(transaction).$queryRaw<
      readonly DeadLetterRow[]
    >`
      SELECT
        job.id AS job_id,
        job.analysis_identity_id,
        attempt.finished_at,
        attempt.error_code,
        attempt.error_retryable,
        attempt.attempt_ordinal
      FROM analysis_jobs AS job
      JOIN LATERAL (
        SELECT finished_at, error_code, error_retryable, attempt_ordinal
        FROM analysis_attempts
        WHERE workspace_id = job.workspace_id
          AND analysis_job_id = job.id
          AND state = 'failed'
        ORDER BY attempt_ordinal DESC
        LIMIT 1
      ) AS attempt ON TRUE
      WHERE job.workspace_id = ${input.workspaceId}
        AND job.state = 'failed'
      ORDER BY attempt.finished_at DESC, job.id
      LIMIT ${input.limit}
    `;
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          jobId: analysisJobId(row.job_id),
          analysisIdentityId: analysisIdentityId(row.analysis_identity_id),
          failedAt: utcInstant(row.finished_at),
          failureCode: row.error_code,
          retryable: row.error_retryable,
          attemptOrdinal: row.attempt_ordinal,
        }),
      ),
    );
  }

  public async retryDeadLetter(
    transaction: ApplicationTransaction,
    input: Parameters<OperationsStore["retryDeadLetter"]>[1],
  ): Promise<AnalysisJob | undefined> {
    const database = this.transactions.get(transaction);
    const failed = await database.$queryRaw<readonly JobRow[]>`
      SELECT
        id, workspace_id, analysis_identity_id, run_ordinal, state,
        created_at, updated_at
      FROM analysis_jobs
      WHERE workspace_id = ${input.workspaceId}
        AND id = ${input.failedJobId}
        AND state = 'failed'
        AND EXISTS (
          SELECT 1
          FROM analysis_attempts
          WHERE workspace_id = ${input.workspaceId}
            AND analysis_job_id = ${input.failedJobId}
            AND state = 'failed'
        )
      FOR UPDATE
    `;
    const prior = failed[0];
    if (prior === undefined) return undefined;
    const ordinal = await database.$queryRaw<
      readonly { readonly next_ordinal: number }[]
    >`
      SELECT COALESCE(MAX(run_ordinal), -1)::integer + 1 AS next_ordinal
      FROM analysis_jobs
      WHERE workspace_id = ${input.workspaceId}
        AND analysis_identity_id = ${prior.analysis_identity_id}
    `;
    const next = ordinal[0]?.next_ordinal;
    if (next === undefined) throw new Error("Retry ordinal was unavailable.");
    const created = await database.$queryRaw<readonly JobRow[]>`
      INSERT INTO analysis_jobs (
        id, workspace_id, analysis_identity_id, run_ordinal, state,
        created_at, updated_at
      )
      VALUES (
        ${input.replacementJobId}, ${input.workspaceId},
        ${prior.analysis_identity_id}, ${next}, 'queued',
        ${asDate(input.occurredAt)}, ${asDate(input.occurredAt)}
      )
      RETURNING
        id, workspace_id, analysis_identity_id, run_ordinal, state,
        created_at, updated_at
    `;
    const job = created[0];
    return job === undefined ? undefined : toJob(job);
  }

  public async cancelJob(
    transaction: ApplicationTransaction,
    input: Parameters<OperationsStore["cancelJob"]>[1],
  ): Promise<AnalysisJob | undefined> {
    const database = this.transactions.get(transaction);
    const rows = await database.$queryRaw<readonly JobRow[]>`
      SELECT
        id, workspace_id, analysis_identity_id, run_ordinal, state,
        created_at, updated_at
      FROM analysis_jobs
      WHERE workspace_id = ${input.workspaceId}
        AND id = ${input.analysisJobId}
        AND state IN ('queued', 'running')
      FOR UPDATE
    `;
    const job = rows[0];
    if (job === undefined) return undefined;
    await database.$executeRaw`
      UPDATE analysis_attempts
      SET
        state = 'cancelled',
        finished_at = ${asDate(input.occurredAt)},
        error_code = 'operations.cancelled',
        error_retryable = false
      WHERE workspace_id = ${input.workspaceId}
        AND analysis_job_id = ${input.analysisJobId}
        AND state = 'running'
    `;
    const updated = await database.$queryRaw<readonly JobRow[]>`
      UPDATE analysis_jobs
      SET state = 'cancelled', updated_at = ${asDate(input.occurredAt)}
      WHERE workspace_id = ${input.workspaceId}
        AND id = ${input.analysisJobId}
        AND state IN ('queued', 'running')
      RETURNING
        id, workspace_id, analysis_identity_id, run_ordinal, state,
        created_at, updated_at
    `;
    const cancelled = updated[0];
    return cancelled === undefined ? undefined : toJob(cancelled);
  }

  public async recoverExpiredJob(
    transaction: ApplicationTransaction,
    input: Parameters<OperationsStore["recoverExpiredJob"]>[1],
  ): Promise<AnalysisJob | undefined> {
    const rows = await this.transactions.get(transaction).$queryRaw<
      readonly JobRow[]
    >`
      WITH expired_attempt AS (
        UPDATE analysis_attempts
        SET
          state = 'failed',
          finished_at = ${asDate(input.occurredAt)},
          error_code = 'operations.leaseExpired',
          error_retryable = true,
          recovery_fencing_token = ${input.fencingToken}
        WHERE workspace_id = ${input.workspaceId}
          AND analysis_job_id = ${input.analysisJobId}
          AND state = 'running'
          AND lease_expires_at <= NOW()
          AND recovery_fencing_token < ${input.fencingToken}
        RETURNING analysis_job_id
      )
      UPDATE analysis_jobs AS job
      SET state = 'queued', updated_at = ${asDate(input.occurredAt)}
      FROM expired_attempt
      WHERE job.workspace_id = ${input.workspaceId}
        AND job.id = expired_attempt.analysis_job_id
        AND job.state = 'running'
      RETURNING
        job.id, job.workspace_id, job.analysis_identity_id, job.run_ordinal,
        job.state, job.created_at, job.updated_at
    `;
    const recovered = rows[0];
    return recovered === undefined ? undefined : toJob(recovered);
  }

  public async queryCostAttribution(
    transaction: ApplicationTransaction,
    query: CostAttributionQuery & { readonly workspaceId: string },
  ): Promise<readonly CostAttributionRecord[]> {
    const rows = await this.transactions.get(transaction).$queryRaw<
      readonly CostRow[]
    >`
      SELECT
        operation.id AS operation_id,
        operation.parent_operation_id,
        operation.analysis_job_id,
        operation.connector_instance_id,
        operation.source_id,
        operation.role,
        operation.configured_model,
        operation.started_at,
        operation.finished_at,
        operation.status,
        cost.calculated_amount::text AS calculated_amount,
        cost.currency,
        cost.provider_reported_amount::text AS provider_reported_amount,
        cost.calculation_status
      FROM ai_operations AS operation
      JOIN ai_operation_costs AS cost
        ON cost.workspace_id = operation.workspace_id
        AND cost.operation_id = operation.id
      WHERE operation.workspace_id = ${query.workspaceId}
        AND (${query.analysisJobId ?? null}::text IS NULL
          OR operation.analysis_job_id = ${query.analysisJobId ?? null})
        AND (${query.connectorInstanceId ?? null}::text IS NULL
          OR operation.connector_instance_id = ${query.connectorInstanceId ?? null})
        AND (${query.role ?? null}::text IS NULL
          OR operation.role = ${query.role ?? null})
        AND (${query.startedAfter === undefined ? null : asDate(query.startedAfter)}::timestamptz IS NULL
          OR operation.started_at >= ${query.startedAfter === undefined ? null : asDate(query.startedAfter)})
        AND (${query.startedBefore === undefined ? null : asDate(query.startedBefore)}::timestamptz IS NULL
          OR operation.started_at < ${query.startedBefore === undefined ? null : asDate(query.startedBefore)})
      ORDER BY operation.started_at DESC, operation.id DESC
      LIMIT ${query.limit}
    `;
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          operationId: row.operation_id,
          ...(row.parent_operation_id === null
            ? {}
            : { parentOperationId: row.parent_operation_id }),
          ...(row.analysis_job_id === null
            ? {}
            : { analysisJobId: analysisJobId(row.analysis_job_id) }),
          ...(row.connector_instance_id === null
            ? {}
            : { connectorInstanceId: row.connector_instance_id }),
          ...(row.source_id === null ? {} : { sourceId: row.source_id }),
          role: row.role,
          configuredModel: row.configured_model,
          startedAt: utcInstant(row.started_at),
          ...(row.finished_at === null
            ? {}
            : { finishedAt: utcInstant(row.finished_at) }),
          status: row.status,
          ...(row.calculated_amount === null
            ? {}
            : { calculatedAmount: row.calculated_amount }),
          ...(row.currency === null ? {} : { currency: row.currency }),
          ...(row.provider_reported_amount === null
            ? {}
            : { providerReportedAmount: row.provider_reported_amount }),
          calculationStatus: row.calculation_status,
        }),
      ),
    );
  }

  public async purgeCaseSnapshot(
    transaction: ApplicationTransaction,
    input: Parameters<OperationsStore["purgeCaseSnapshot"]>[1],
  ): Promise<
    | { readonly kind: "notFound" }
    | {
        readonly kind: "purged" | "alreadyPurged";
        readonly workItems: readonly RetentionWorkItem[];
      }
  > {
    const database = this.transactions.get(transaction);
    const existingTombstone = await database.$queryRaw<
      readonly { readonly id: string }[]
    >`
      SELECT id
      FROM privacy_tombstones
      WHERE workspace_id = ${input.workspaceId}
        AND case_snapshot_id = ${input.caseSnapshotId}
      FOR UPDATE
    `;
    if (existingTombstone[0] !== undefined) {
      return { kind: "alreadyPurged", workItems: [] };
    }
    const snapshots = await database.$queryRaw<readonly SnapshotRow[]>`
      SELECT id, external_reference_id, snapshot_hash, snapshot
      FROM case_snapshots
      WHERE workspace_id = ${input.workspaceId}
        AND id = ${input.caseSnapshotId}
      FOR UPDATE
    `;
    const snapshot = snapshots[0];
    if (snapshot === undefined) return { kind: "notFound" };

    const payload = asObject(snapshot.snapshot);
    const tombstoneSnapshot = {
      id: snapshot.id,
      revision: stringField(payload, "revision", "purged"),
      capturedAt: stringField(
        payload,
        "capturedAt",
        asDate(input.occurredAt).toISOString(),
      ),
      title: "[Purged for privacy]",
      summary: "[Purged for privacy]",
      contentHash: snapshot.snapshot_hash,
      messages: [],
    };
    await database.caseSnapshot.update({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: input.caseSnapshotId,
        },
      },
      data: {
        lifecycle: "tombstoned",
        snapshot: json(tombstoneSnapshot),
        tombstonedByPrincipalId: input.actorPrincipalId,
        tombstonedAt: asDate(input.occurredAt),
        tombstoneReason: input.reason,
      },
    });
    await database.$executeRaw`
      INSERT INTO privacy_tombstones (
        id, workspace_id, case_snapshot_id, snapshot_hash,
        actor_principal_id, reason, purged_at
      )
      VALUES (
        ${`privacy:${input.caseSnapshotId}`},
        ${input.workspaceId},
        ${input.caseSnapshotId},
        ${snapshot.snapshot_hash},
        ${input.actorPrincipalId},
        ${input.reason},
        ${asDate(input.occurredAt)}
      )
    `;
    await database.$executeRaw`
      UPDATE analysis_results
      SET record = jsonb_build_object(
        'privacyPurged', true,
        'caseSnapshotId', ${input.caseSnapshotId}::text
      )
      WHERE workspace_id = ${input.workspaceId}
        AND analysis_job_id IN (
          SELECT job.id
          FROM analysis_jobs AS job
          JOIN analysis_identities AS identity
            ON identity.workspace_id = job.workspace_id
            AND identity.id = job.analysis_identity_id
          WHERE identity.workspace_id = ${input.workspaceId}
            AND identity.case_snapshot_id = ${input.caseSnapshotId}
        )
    `;
    await database.$executeRaw`
      UPDATE evidence
      SET record = jsonb_build_object(
        'privacyPurged', true,
        'caseSnapshotId', ${input.caseSnapshotId}::text
      )
      WHERE workspace_id = ${input.workspaceId}
        AND analysis_result_id IN (
          SELECT result.id
          FROM analysis_results AS result
          JOIN analysis_jobs AS job
            ON job.workspace_id = result.workspace_id
            AND job.id = result.analysis_job_id
          JOIN analysis_identities AS identity
            ON identity.workspace_id = job.workspace_id
            AND identity.id = job.analysis_identity_id
          WHERE identity.workspace_id = ${input.workspaceId}
            AND identity.case_snapshot_id = ${input.caseSnapshotId}
        )
    `;

    const blobs = await database.$queryRaw<
      readonly { readonly id: string; readonly storage_key: string | null }[]
    >`
      SELECT blob.id, blob.storage_key
      FROM attachments AS attachment
      JOIN attachment_blobs AS blob
        ON blob.workspace_id = attachment.workspace_id
        AND blob.id = attachment.blob_id
      WHERE attachment.workspace_id = ${input.workspaceId}
        AND attachment.external_reference_id = ${snapshot.external_reference_id}
    `;
    const derivatives = await database.$queryRaw<
      readonly { readonly id: string; readonly storage_key: string | null }[]
    >`
      SELECT DISTINCT derivative.id, derivative.output_storage_key AS storage_key
      FROM attachment_derivative_sources AS source
      JOIN attachments AS attachment
        ON attachment.workspace_id = source.workspace_id
        AND attachment.id = source.attachment_id
      JOIN attachment_derivatives AS derivative
        ON derivative.workspace_id = source.workspace_id
        AND derivative.id = source.attachment_derivative_id
      WHERE source.workspace_id = ${input.workspaceId}
        AND attachment.external_reference_id = ${snapshot.external_reference_id}
    `;
    const workItems: RetentionWorkItem[] = [];
    for (const blob of blobs) {
      const rows = await database.$queryRaw<readonly StoredWorkItemRow[]>`
        INSERT INTO retention_work_items (
          id, workspace_id, target_kind, target_id, storage_key, reason, state
        )
        VALUES (
          ${`privacy:attachmentBlob:${blob.id}`},
          ${input.workspaceId}, 'attachmentBlob', ${blob.id},
          ${blob.storage_key}, 'privacy', 'queued'
        )
        ON CONFLICT (workspace_id, target_kind, target_id) DO NOTHING
        RETURNING id, workspace_id, storage_key
      `;
      if (rows[0] !== undefined) workItems.push(toWorkItem(rows[0]));
    }
    for (const derivative of derivatives) {
      const rows = await database.$queryRaw<readonly StoredWorkItemRow[]>`
        INSERT INTO retention_work_items (
          id, workspace_id, target_kind, target_id, storage_key, reason, state
        )
        VALUES (
          ${`privacy:attachmentDerivative:${derivative.id}`},
          ${input.workspaceId}, 'attachmentDerivative', ${derivative.id},
          ${derivative.storage_key}, 'privacy', 'queued'
        )
        ON CONFLICT (workspace_id, target_kind, target_id) DO NOTHING
        RETURNING id, workspace_id, storage_key
      `;
      if (rows[0] !== undefined) workItems.push(toWorkItem(rows[0]));
    }
    await database.$executeRaw`
      UPDATE attachments
      SET
        content_hash = NULL,
        blob_id = NULL,
        byte_length = NULL,
        sanitized_filename = NULL,
        retention_state = 'deleted',
        retention_claim_id = NULL,
        retention_claimed_at = NULL,
        retention_claim_expires_at = NULL,
        retention_deleted_at = ${asDate(input.occurredAt)}
      WHERE workspace_id = ${input.workspaceId}
        AND external_reference_id = ${snapshot.external_reference_id}
    `;
    return { kind: "purged", workItems: Object.freeze(workItems) };
  }

  public async queueExpiredRetention(
    transaction: ApplicationTransaction,
    input: Parameters<OperationsStore["queueExpiredRetention"]>[1],
  ): Promise<readonly RetentionWorkItem[]> {
    const database = this.transactions.get(transaction);
    const remainingDerivativeLimit = Math.max(0, input.limit);
    const blobs = await database.$queryRaw<
      readonly { readonly id: string; readonly storage_key: string | null }[]
    >`
      SELECT id, storage_key
      FROM attachment_blobs
      WHERE workspace_id = ${input.workspaceId}
        AND retention_state = 'active'
        AND retention_expires_at IS NOT NULL
        AND retention_expires_at <= NOW()
      ORDER BY retention_expires_at, id
      LIMIT ${input.limit}
      FOR UPDATE SKIP LOCKED
    `;
    const workItems: RetentionWorkItem[] = [];
    for (const blob of blobs) {
      const rows = await database.$queryRaw<readonly StoredWorkItemRow[]>`
        INSERT INTO retention_work_items (
          id, workspace_id, target_kind, target_id, storage_key, reason, state
        )
        VALUES (
          ${`retention:attachmentBlob:${blob.id}`},
          ${input.workspaceId}, 'attachmentBlob', ${blob.id},
          ${blob.storage_key}, 'retention', 'queued'
        )
        ON CONFLICT (workspace_id, target_kind, target_id) DO NOTHING
        RETURNING id, workspace_id, storage_key
      `;
      if (rows[0] !== undefined) workItems.push(toWorkItem(rows[0]));
    }
    const derivativeLimit = Math.max(
      0,
      remainingDerivativeLimit - blobs.length,
    );
    if (derivativeLimit > 0) {
      const derivatives = await database.$queryRaw<
        readonly { readonly id: string; readonly storage_key: string | null }[]
      >`
        SELECT id, output_storage_key AS storage_key
        FROM attachment_derivatives
        WHERE workspace_id = ${input.workspaceId}
          AND retention_state = 'active'
          AND retention_expires_at IS NOT NULL
          AND retention_expires_at <= NOW()
        ORDER BY retention_expires_at, id
        LIMIT ${derivativeLimit}
        FOR UPDATE SKIP LOCKED
      `;
      for (const derivative of derivatives) {
        const rows = await database.$queryRaw<readonly StoredWorkItemRow[]>`
          INSERT INTO retention_work_items (
            id, workspace_id, target_kind, target_id, storage_key, reason, state
          )
          VALUES (
            ${`retention:attachmentDerivative:${derivative.id}`},
            ${input.workspaceId}, 'attachmentDerivative', ${derivative.id},
            ${derivative.storage_key}, 'retention', 'queued'
          )
          ON CONFLICT (workspace_id, target_kind, target_id) DO NOTHING
          RETURNING id, workspace_id, storage_key
        `;
        if (rows[0] !== undefined) workItems.push(toWorkItem(rows[0]));
      }
    }
    return Object.freeze(workItems);
  }

  public async claimRetentionWork(
    transaction: ApplicationTransaction,
    input: Parameters<OperationsStore["claimRetentionWork"]>[1],
  ) {
    const rows = await this.transactions.get(transaction).$queryRaw<
      readonly ClaimedWorkItemRow[]
    >`
      UPDATE retention_work_items
      SET
        state = 'running',
        fencing_token = fencing_token + 1,
        claimed_until = NOW() + INTERVAL '15 minutes'
      WHERE workspace_id = ${input.workspaceId}
        AND id = ${input.workItemId}
        AND (
          state = 'queued'
          OR (state = 'running' AND claimed_until <= NOW())
        )
      RETURNING id, workspace_id, storage_key, fencing_token
    `;
    const claimed = rows[0];
    return claimed === undefined
      ? undefined
      : Object.freeze({
          ...toWorkItem(claimed),
          fencingToken: claimed.fencing_token,
        });
  }

  public async completeRetentionWork(
    transaction: ApplicationTransaction,
    input: Parameters<OperationsStore["completeRetentionWork"]>[1],
  ): Promise<boolean> {
    const database = this.transactions.get(transaction);
    const rows = await database.$queryRaw<readonly CompletedWorkItemRow[]>`
      UPDATE retention_work_items
      SET
        state = 'completed',
        claimed_until = NULL,
        completed_at = ${asDate(input.occurredAt)}
      WHERE workspace_id = ${input.workspaceId}
        AND id = ${input.workItemId}
        AND state = 'running'
        AND fencing_token = ${input.fencingToken}
      RETURNING target_kind, target_id
    `;
    const completed = rows[0];
    if (completed === undefined) return false;
    if (completed.target_kind === "attachmentBlob") {
      await database.$executeRaw`
        UPDATE attachment_blobs
        SET
          storage_key = NULL,
          retention_state = 'deleted',
          retention_claim_id = NULL,
          retention_claimed_at = NULL,
          retention_claim_expires_at = NULL,
          retention_deleted_at = ${asDate(input.occurredAt)}
        WHERE workspace_id = ${input.workspaceId}
          AND id = ${completed.target_id}
      `;
    } else {
      await database.$executeRaw`
        UPDATE attachment_derivatives
        SET
          output_storage_key = NULL,
          retention_state = 'deleted',
          retention_claim_id = NULL,
          retention_claimed_at = NULL,
          retention_claim_expires_at = NULL,
          retention_deleted_at = ${asDate(input.occurredAt)}
        WHERE workspace_id = ${input.workspaceId}
          AND id = ${completed.target_id}
      `;
    }
    return true;
  }

  public async releaseRetentionWork(
    transaction: ApplicationTransaction,
    input: Parameters<OperationsStore["releaseRetentionWork"]>[1],
  ): Promise<void> {
    await this.transactions.get(transaction).$executeRaw`
      UPDATE retention_work_items
      SET state = 'queued', claimed_until = NULL
      WHERE workspace_id = ${input.workspaceId}
        AND id = ${input.workItemId}
        AND state = 'running'
        AND fencing_token = ${input.fencingToken}
    `;
  }
}
