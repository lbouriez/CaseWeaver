import { createHash } from "node:crypto";

import type {
  AnalysisExecution,
  AnalysisExecutionStore,
  AnalysisProfile,
  AnalysisResultRecord,
  AnalysisStageStatus,
  CaseSnapshotTombstoneStore,
  ImmutableCaseSnapshot,
} from "@caseweaver/analysis";
import {
  caseSnapshotTombstoneSchema,
  immutableCaseSnapshotSchema,
} from "@caseweaver/analysis";
import type { UnitOfWork } from "@caseweaver/application";
import type { EnvelopeFor } from "@caseweaver/domain";
import type { Prisma } from "@prisma/client";

import type { PostgresTransactionLookup } from "../index.js";

type AnalysisUnitOfWork = UnitOfWork & PostgresTransactionLookup;

interface ClaimRow {
  readonly analysis_job_id: string;
  readonly workspace_id: string;
  readonly analysis_identity_id: string;
  readonly state: string;
  readonly profile_definition: Prisma.JsonValue;
  readonly snapshot: Prisma.JsonValue;
  readonly snapshot_lifecycle: string;
  readonly tombstoned_by_principal_id: string | null;
  readonly tombstoned_at: Date | null;
  readonly tombstone_reason: string | null;
}

interface CaseSnapshotRow {
  readonly snapshot: Prisma.JsonValue;
  readonly lifecycle: string;
  readonly tombstoned_by_principal_id: string | null;
  readonly tombstoned_at: Date | null;
  readonly tombstone_reason: string | null;
}

interface OrdinalRow {
  readonly next_ordinal: number;
}

interface JobRow {
  readonly state: string;
  readonly analysis_identity_id: string;
}

export class PostgresAnalysisExecutionStoreError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "analysis.cancelled"
      | "analysis.executionConflict"
      | "analysis.invalidCompletion" = "analysis.executionConflict",
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "PostgresAnalysisExecutionStoreError";
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new PostgresAnalysisExecutionStoreError(
      "Analysis execution was cancelled.",
      "analysis.cancelled",
    );
  }
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        "Analysis persistence cannot store a non-finite number.",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Analysis persistence cannot store a non-JSON value.");
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(canonicalJson(value)) as Prisma.InputJsonValue;
}

function immutableJson(value: Prisma.JsonValue): unknown {
  return freezeJson(JSON.parse(canonicalJson(value)));
}

function isJsonObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeJson));
  }
  if (value !== null && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value as Readonly<Record<string, unknown>>).map(
          ([key, item]) => [key, freezeJson(item)],
        ),
      ),
    );
  }
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function attemptId(analysisJobId: string, ordinal: number): string {
  return `analysis-attempt-${digest(`${analysisJobId}:${ordinal}`)}`;
}

function evidenceId(
  analysisResultId: string,
  evidenceKey: string,
  ordinal: number,
): string {
  return `evidence-${digest(`${analysisResultId}:${ordinal}:${evidenceKey}`)}`;
}

function snapshotFromRow(row: CaseSnapshotRow): ImmutableCaseSnapshot {
  const payload = immutableJson(row.snapshot);
  if (!isJsonObject(payload) || "tombstone" in payload) {
    throw new PostgresAnalysisExecutionStoreError(
      "Case snapshot payload must not contain mutable tombstone metadata.",
      "analysis.invalidCompletion",
    );
  }
  if (row.lifecycle === "tombstoned") {
    const tombstone = caseSnapshotTombstoneSchema.parse({
      actorPrincipalId: row.tombstoned_by_principal_id,
      tombstonedAt: row.tombstoned_at?.toISOString(),
      reason: row.tombstone_reason,
    });
    return freezeJson(
      immutableCaseSnapshotSchema.parse({ ...payload, tombstone }),
    ) as ImmutableCaseSnapshot;
  }
  if (
    row.tombstoned_by_principal_id !== null ||
    row.tombstoned_at !== null ||
    row.tombstone_reason !== null
  ) {
    throw new PostgresAnalysisExecutionStoreError(
      "An active case snapshot contains tombstone metadata.",
      "analysis.invalidCompletion",
    );
  }
  return freezeJson(
    immutableCaseSnapshotSchema.parse(payload),
  ) as ImmutableCaseSnapshot;
}

function ensureCompletionMatchesExecution(input: {
  readonly execution: AnalysisExecution;
  readonly result: AnalysisResultRecord;
  readonly event: EnvelopeFor<"analysis.completed.v1">;
}): void {
  const { execution, result, event } = input;
  if (
    result.workspaceId !== execution.workspaceId ||
    result.analysisJobId !== execution.analysisJobId ||
    result.analysisIdentityId !== execution.analysisIdentityId ||
    result.analysisAttemptId !== execution.analysisAttemptId ||
    event.workspaceId !== execution.workspaceId ||
    event.payload.analysisJobId !== execution.analysisJobId ||
    event.payload.analysisResultId !== result.id
  ) {
    throw new PostgresAnalysisExecutionStoreError(
      "Analysis completion does not match its claimed execution.",
      "analysis.invalidCompletion",
    );
  }
}

/**
 * Durable analysis execution store. Each method owns a short database
 * transaction; the completion transaction inserts the immutable result,
 * selected evidence, terminal attempt/job states, and completion outbox event.
 */
export class PostgresAnalysisExecutionStore implements AnalysisExecutionStore {
  public constructor(private readonly unitOfWork: AnalysisUnitOfWork) {}

  public async claim(
    command: EnvelopeFor<"analysis.execute.v1">,
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "claimed"; readonly execution: AnalysisExecution }
    | { readonly kind: "completed"; readonly resultId: string }
    | { readonly kind: "alreadyRunning" }
    | { readonly kind: "notFound" }
  > {
    assertNotAborted(signal);
    return this.unitOfWork.transaction(async (transaction) => {
      const database = this.unitOfWork.get(transaction);
      const rows = await database.$queryRaw<readonly ClaimRow[]>`
        SELECT
          job.id AS analysis_job_id,
          job.workspace_id,
          job.analysis_identity_id,
          job.state,
          profile.definition AS profile_definition,
          snapshot.snapshot,
          snapshot.lifecycle AS snapshot_lifecycle,
          snapshot.tombstoned_by_principal_id,
          snapshot.tombstoned_at,
          snapshot.tombstone_reason
        FROM analysis_jobs AS job
        JOIN analysis_identities AS identity
          ON identity.workspace_id = job.workspace_id
          AND identity.id = job.analysis_identity_id
        JOIN analysis_profile_versions AS profile
          ON profile.workspace_id = identity.workspace_id
          AND profile.id = identity.analysis_profile_version_id
        JOIN case_snapshots AS snapshot
          ON snapshot.workspace_id = identity.workspace_id
          AND snapshot.id = identity.case_snapshot_id
        WHERE job.workspace_id = ${command.workspaceId}
          AND job.id = ${command.payload.analysisJobId}
          AND job.analysis_identity_id = ${command.payload.analysisIdentityId}
        FOR UPDATE OF job
      `;
      const row = rows[0];
      if (row === undefined) return { kind: "notFound" };

      const completed = await database.analysisResult.findUnique({
        where: {
          workspaceId_analysisJobId: {
            workspaceId: row.workspace_id,
            analysisJobId: row.analysis_job_id,
          },
        },
        select: { id: true },
      });
      if (completed !== null) {
        return { kind: "completed", resultId: completed.id };
      }
      if (row.state === "running") return { kind: "alreadyRunning" };
      if (row.state !== "queued") return { kind: "notFound" };

      const ordinals = await database.$queryRaw<readonly OrdinalRow[]>`
        SELECT COALESCE(MAX(attempt_ordinal), -1)::integer + 1 AS next_ordinal
        FROM analysis_attempts
        WHERE workspace_id = ${row.workspace_id}
          AND analysis_job_id = ${row.analysis_job_id}
      `;
      const nextOrdinal = ordinals[0]?.next_ordinal;
      if (nextOrdinal === undefined) {
        throw new PostgresAnalysisExecutionStoreError(
          "Analysis attempt ordinal was not available.",
        );
      }
      const now = new Date();
      const leaseExpiresAt = new Date(now.getTime() + 15 * 60 * 1_000);
      const id = attemptId(row.analysis_job_id, nextOrdinal);
      const updated = await database.analysisJob.updateMany({
        where: {
          id: row.analysis_job_id,
          workspaceId: row.workspace_id,
          state: "queued",
        },
        data: { state: "running", updatedAt: now },
      });
      if (updated.count !== 1) return { kind: "alreadyRunning" };
      await database.analysisAttempt.create({
        data: {
          id,
          workspaceId: row.workspace_id,
          analysisJobId: row.analysis_job_id,
          attemptOrdinal: nextOrdinal,
          state: "running",
          startedAt: now,
          leaseExpiresAt,
          recoveryFencingToken: 0n,
          stages: [],
        },
      });
      assertNotAborted(signal);
      return {
        kind: "claimed",
        execution: Object.freeze({
          workspaceId: row.workspace_id,
          analysisJobId: row.analysis_job_id,
          analysisIdentityId: row.analysis_identity_id,
          analysisAttemptId: id,
          snapshot: snapshotFromRow({
            snapshot: row.snapshot,
            lifecycle: row.snapshot_lifecycle,
            tombstoned_by_principal_id: row.tombstoned_by_principal_id,
            tombstoned_at: row.tombstoned_at,
            tombstone_reason: row.tombstone_reason,
          }),
          profile: immutableJson(row.profile_definition) as AnalysisProfile,
        }),
      };
    });
  }

  public async complete(
    input: {
      readonly execution: AnalysisExecution;
      readonly result: AnalysisResultRecord;
      readonly event: EnvelopeFor<"analysis.completed.v1">;
    },
    signal: AbortSignal,
  ): Promise<void> {
    assertNotAborted(signal);
    ensureCompletionMatchesExecution(input);
    await this.unitOfWork.transaction(async (transaction) => {
      const database = this.unitOfWork.get(transaction);
      const rows = await database.$queryRaw<readonly JobRow[]>`
        SELECT state, analysis_identity_id
        FROM analysis_jobs
        WHERE id = ${input.execution.analysisJobId}
          AND workspace_id = ${input.execution.workspaceId}
        FOR UPDATE
      `;
      const job = rows[0];
      if (
        job === undefined ||
        job.analysis_identity_id !== input.execution.analysisIdentityId
      ) {
        throw new PostgresAnalysisExecutionStoreError(
          "Analysis job does not match the claimed execution.",
        );
      }
      const existing = await database.analysisResult.findUnique({
        where: {
          workspaceId_analysisJobId: {
            workspaceId: input.execution.workspaceId,
            analysisJobId: input.execution.analysisJobId,
          },
        },
        select: { id: true },
      });
      if (existing !== null && existing.id === input.result.id) return;
      if (existing !== null || job.state !== "running") {
        throw new PostgresAnalysisExecutionStoreError(
          "Analysis job is no longer available for completion.",
        );
      }

      const now = new Date();
      await database.analysisResult.create({
        data: {
          id: input.result.id,
          workspaceId: input.result.workspaceId,
          analysisJobId: input.result.analysisJobId,
          resultHash: digest(canonicalJson(input.result)),
          record: jsonValue(input.result),
          createdAt: new Date(input.result.createdAt),
        },
      });
      if (input.result.evidence.length > 0) {
        await database.evidence.createMany({
          data: input.result.evidence.map((evidence, ordinal) => ({
            id: evidenceId(input.result.id, evidence.id, ordinal),
            workspaceId: input.result.workspaceId,
            analysisResultId: input.result.id,
            evidenceHash: evidence.contentHash,
            record: jsonValue(evidence),
            createdAt: now,
          })),
        });
      }
      const attempt = await database.analysisAttempt.updateMany({
        where: {
          id: input.execution.analysisAttemptId,
          workspaceId: input.execution.workspaceId,
          analysisJobId: input.execution.analysisJobId,
          state: "running",
        },
        data: {
          state: "succeeded",
          finishedAt: now,
          stages: jsonValue(input.result.stages),
        },
      });
      if (attempt.count !== 1) {
        throw new PostgresAnalysisExecutionStoreError(
          "Analysis attempt is no longer running.",
        );
      }
      const completed = await database.analysisJob.updateMany({
        where: {
          id: input.execution.analysisJobId,
          workspaceId: input.execution.workspaceId,
          state: "running",
        },
        data: { state: "completed", updatedAt: now },
      });
      if (completed.count !== 1) {
        throw new PostgresAnalysisExecutionStoreError(
          "Analysis job is no longer running.",
        );
      }
      await database.outboxEnvelope.create({
        data: {
          id: input.event.id,
          workspaceId: input.event.workspaceId,
          kind: input.event.kind,
          type: input.event.type,
          schemaVersion: input.event.schemaVersion,
          occurredAt: new Date(input.event.occurredAt),
          correlationId: input.event.correlationId,
          causationId: input.event.causationId,
          payload: jsonValue(input.event.payload),
          availableAt: new Date(input.event.occurredAt),
        },
      });
    });
  }

  public async fail(
    input: {
      readonly execution: AnalysisExecution;
      readonly outcome: "failed" | "cancelled";
      readonly stages: readonly AnalysisStageStatus[];
      readonly error: { readonly code: string; readonly retryable: boolean };
    },
    _signal: AbortSignal,
  ): Promise<void> {
    await this.unitOfWork.transaction(async (transaction) => {
      const database = this.unitOfWork.get(transaction);
      const rows = await database.$queryRaw<readonly JobRow[]>`
        SELECT state, analysis_identity_id
        FROM analysis_jobs
        WHERE id = ${input.execution.analysisJobId}
          AND workspace_id = ${input.execution.workspaceId}
        FOR UPDATE
      `;
      const job = rows[0];
      if (
        job === undefined ||
        job.analysis_identity_id !== input.execution.analysisIdentityId
      ) {
        return;
      }
      const outcome = job.state === "cancelled" ? "cancelled" : input.outcome;
      const now = new Date();
      const attempt = await database.analysisAttempt.updateMany({
        where: {
          id: input.execution.analysisAttemptId,
          workspaceId: input.execution.workspaceId,
          analysisJobId: input.execution.analysisJobId,
          state: "running",
        },
        data: {
          state: outcome,
          finishedAt: now,
          errorCode: input.error.code,
          errorRetryable: input.error.retryable,
          stages: jsonValue(input.stages),
        },
      });
      if (attempt.count !== 1 || job.state !== "running") return;
      await database.analysisJob.updateMany({
        where: {
          id: input.execution.analysisJobId,
          workspaceId: input.execution.workspaceId,
          state: "running",
        },
        data: { state: outcome, updatedAt: now },
      });
    });
  }
}

/**
 * Retention metadata is held outside the immutable snapshot JSON so an
 * analysis can still be reconstructed from its captured content and hash.
 */
export class PostgresCaseSnapshotTombstoneStore
  implements CaseSnapshotTombstoneStore
{
  public constructor(private readonly unitOfWork: AnalysisUnitOfWork) {}

  public async tombstone(
    input: Parameters<CaseSnapshotTombstoneStore["tombstone"]>[0],
  ): Promise<Awaited<ReturnType<CaseSnapshotTombstoneStore["tombstone"]>>> {
    assertNotAborted(input.signal);
    const tombstone = caseSnapshotTombstoneSchema.parse(input.tombstone);
    return this.unitOfWork.transaction(async (transaction) => {
      const database = this.unitOfWork.get(transaction);
      const rows = await database.$queryRaw<readonly CaseSnapshotRow[]>`
        SELECT
          snapshot,
          lifecycle,
          tombstoned_by_principal_id,
          tombstoned_at,
          tombstone_reason
        FROM case_snapshots
        WHERE workspace_id = ${input.workspaceId}
          AND id = ${input.caseSnapshotId}
        FOR UPDATE
      `;
      const row = rows[0];
      if (row === undefined) return { kind: "notFound" };
      if (row.lifecycle === "tombstoned") {
        return { kind: "alreadyTombstoned", snapshot: snapshotFromRow(row) };
      }
      if (row.lifecycle !== "active") {
        throw new PostgresAnalysisExecutionStoreError(
          "Only active case snapshots may be tombstoned.",
        );
      }

      const updated = await database.caseSnapshot.updateMany({
        where: {
          id: input.caseSnapshotId,
          workspaceId: input.workspaceId,
          lifecycle: "active",
        },
        data: {
          lifecycle: "tombstoned",
          tombstonedByPrincipalId: tombstone.actorPrincipalId,
          tombstonedAt: new Date(tombstone.tombstonedAt),
          tombstoneReason: tombstone.reason,
        },
      });
      if (updated.count !== 1) {
        throw new PostgresAnalysisExecutionStoreError(
          "Case snapshot was unavailable for tombstoning.",
        );
      }
      assertNotAborted(input.signal);
      return {
        kind: "tombstoned",
        snapshot: snapshotFromRow({
          ...row,
          lifecycle: "tombstoned",
          tombstoned_by_principal_id: tombstone.actorPrincipalId,
          tombstoned_at: new Date(tombstone.tombstonedAt),
          tombstone_reason: tombstone.reason,
        }),
      };
    });
  }
}
