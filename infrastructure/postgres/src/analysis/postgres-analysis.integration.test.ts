import type {
  AnalysisExecution,
  AnalysisResultRecord,
} from "@caseweaver/analysis";
import { ForceRerunAnalysis, type IdGenerator } from "@caseweaver/application";
import {
  analysisIdentityId,
  analysisJobId,
  analysisResultId,
  causationId,
  correlationId,
  createEnvelope,
  outboxEnvelopeId,
  principalId,
  requestId,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { Pool } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { createPostgresPersistence } from "../index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error(
    "PostgreSQL integration tests require DATABASE_URL for a disposable test database.",
  );
}
if (!new URL(databaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error(
    "PostgreSQL integration DATABASE_URL must name a test database.",
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const snapshot = {
  id: "snapshot-1",
  revision: "revision-1",
  capturedAt: "2026-07-14T15:00:00.000Z",
  title: "Service cannot connect",
  summary: "The customer cannot connect after a configuration change.",
  contentHash: "a".repeat(64),
  messages: [],
};
const profile = {
  id: "profile-1",
  version: "profile-version-1",
  analysisBindingVersionId: "analysis-binding-1",
  prompt: {
    template: {
      id: "analysis-prompt-1",
      version: "1",
      systemInstruction: "Analyze the case.",
    },
    schemaVersion: "case-analysis.v1",
    budgets: {
      case: { maximumCharacters: 10_000, maximumTokens: 2_000 },
      attachments: { maximumCharacters: 10_000, maximumTokens: 2_000 },
      knowledge: { maximumCharacters: 10_000, maximumTokens: 2_000 },
      repository: { maximumCharacters: 10_000, maximumTokens: 2_000 },
    },
  },
  retrieval: {
    policy: "disabled",
    profileId: "retrieval-profile-1",
    profileVersion: "1",
    collectionIds: ["collection-1"],
    maximumQueryCharacters: 4_000,
  },
  attachments: { policy: "disabled" },
  repository: {
    policy: "disabled",
    maximumContextCharacters: 4_000,
    maximumEvidenceCharacters: 4_000,
  },
  generation: {
    maximumInputTokens: 4_000,
    maximumOutputTokens: 1_000,
    budget: { currency: "USD", hard: false },
  },
  repair: { maximumAttempts: 0, maximumInputCharacters: 4_000 },
};

async function resetDatabase(): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      publication_attempts,
      publication_intents,
      evidence,
      analysis_results,
      analysis_attempts,
      analysis_jobs,
      analysis_identities,
      analysis_profile_versions,
      analysis_profiles,
      attachments,
      knowledge_items,
      case_snapshots,
      external_references,
      connector_capabilities,
      connector_registrations,
      credential_registrations,
      workspace_role_assignments,
      audit_events,
      principals,
      idempotency_records,
      inbox_messages,
      outbox_envelopes,
      resource_leases,
      installation_state,
      workspaces
    RESTART IDENTITY CASCADE
  `);
}

async function seedAnalysisJob(jobId = "analysis-job-1"): Promise<void> {
  await pool.query("INSERT INTO workspaces (id) VALUES ('workspace-1')");
  await pool.query(
    "INSERT INTO principals (id, workspace_id) VALUES ('principal-1', 'workspace-1')",
  );
  await pool.query(
    "INSERT INTO connector_registrations (id, workspace_id, lifecycle) VALUES ('connector-1', 'workspace-1', 'active')",
  );
  await pool.query(
    "INSERT INTO external_references (id, workspace_id, connector_registration_id, kind, external_id) VALUES ('case-reference-1', 'workspace-1', 'connector-1', 'case', 'external-case-1')",
  );
  await pool.query(
    `INSERT INTO case_snapshots (
      id, workspace_id, external_reference_id, lifecycle, snapshot_hash, snapshot, observed_at
    ) VALUES ('snapshot-1', 'workspace-1', 'case-reference-1', 'active', $1, $2::jsonb, $3)`,
    [snapshot.contentHash, JSON.stringify(snapshot), snapshot.capturedAt],
  );
  await pool.query(
    "INSERT INTO analysis_profiles (id, workspace_id, lifecycle) VALUES ('profile-1', 'workspace-1', 'active')",
  );
  await pool.query(
    `INSERT INTO analysis_profile_versions (
      id, workspace_id, analysis_profile_id, version, definition_hash, definition
    ) VALUES ('profile-version-1', 'workspace-1', 'profile-1', 1, $1, $2::jsonb)`,
    ["b".repeat(64), JSON.stringify(profile)],
  );
  await pool.query(
    "INSERT INTO analysis_identities (id, workspace_id, identity_hash, analysis_profile_version_id, case_snapshot_id) VALUES ('analysis-identity-1', 'workspace-1', $1, 'profile-version-1', 'snapshot-1')",
    ["c".repeat(64)],
  );
  await pool.query(
    "INSERT INTO analysis_jobs (id, workspace_id, analysis_identity_id, run_ordinal, state) VALUES ($1, 'workspace-1', 'analysis-identity-1', 0, 'queued')",
    [jobId],
  );
}

function command(jobId = "analysis-job-1") {
  return createEnvelope({
    id: outboxEnvelopeId(`outbox-command-${jobId}`),
    kind: "command",
    type: "analysis.execute.v1",
    schemaVersion: 1,
    workspaceId: workspaceId("workspace-1"),
    occurredAt: utcInstant("2026-07-14T15:00:00.000Z"),
    correlationId: correlationId("correlation-1"),
    causationId: causationId("causation-1"),
    payload: {
      analysisJobId: analysisJobId(jobId),
      analysisIdentityId: analysisIdentityId("analysis-identity-1"),
    },
  });
}

function result(
  execution: AnalysisExecution,
  id = "analysis-result-1",
): AnalysisResultRecord {
  return {
    id: analysisResultId(id),
    workspaceId: execution.workspaceId,
    analysisJobId: execution.analysisJobId,
    analysisIdentityId: execution.analysisIdentityId,
    analysisAttemptId: execution.analysisAttemptId,
    caseSnapshotId: "snapshot-1",
    caseRevision: "revision-1",
    analysisProfileId: "profile-1",
    analysisProfileVersion: "profile-version-1",
    analysisBindingVersionId: "analysis-binding-1",
    promptTemplate: profile.prompt.template,
    promptHash: "d".repeat(64),
    outputSchemaVersion: "case-analysis.v1",
    selectedEvidenceHashes: [],
    evidence: [],
    output: {
      summary: "The configuration likely caused the incident.",
      probableCauses: [],
      investigation: [],
      recommendedActions: [],
      evidence: [],
      unansweredQuestions: [],
      confidence: "medium",
    },
    stages: [
      { stage: "attachments", status: "skipped", policy: "disabled" },
      { stage: "retrieval", status: "skipped", policy: "disabled" },
      { stage: "repository", status: "skipped", policy: "disabled" },
      { stage: "prompt", status: "completed" },
      { stage: "generation", status: "completed" },
      { stage: "validation", status: "completed" },
    ],
    operationIds: [],
    createdAt: "2026-07-14T15:01:00.000Z",
  };
}

function rerunIds(): IdGenerator {
  let sequence = 0;
  return {
    next(kind) {
      sequence += 1;
      return `${kind}-rerun-${sequence}`;
    },
  };
}

function completedEvent(
  jobId: string,
  resultId: ReturnType<typeof analysisResultId>,
  id = "outbox-completed-1",
) {
  return createEnvelope({
    id: outboxEnvelopeId(id),
    kind: "domainEvent",
    type: "analysis.completed.v1",
    schemaVersion: 1,
    workspaceId: workspaceId("workspace-1"),
    occurredAt: utcInstant("2026-07-14T15:01:00.000Z"),
    correlationId: correlationId("correlation-1"),
    causationId: causationId("causation-1"),
    payload: {
      analysisJobId: analysisJobId(jobId),
      analysisResultId: resultId,
    },
  });
}

beforeAll(async () => resetDatabase());

describe("PBI-011 PostgreSQL analysis execution store", () => {
  it("atomically stores a completed result, terminal states, and completed-event outbox record", async () => {
    await resetDatabase();
    await seedAnalysisJob();
    const persistence = createPostgresPersistence({ databaseUrl });

    try {
      const claim = await persistence.analysisExecutionStore.claim(
        command(),
        new AbortController().signal,
      );
      expect(claim.kind).toBe("claimed");
      if (claim.kind !== "claimed")
        throw new Error("Expected claimed analysis.");
      const storedResult = result(claim.execution);
      await persistence.analysisExecutionStore.complete(
        {
          execution: claim.execution,
          result: storedResult,
          event: completedEvent("analysis-job-1", storedResult.id),
        },
        new AbortController().signal,
      );

      const job = await pool.query<{ state: string }>(
        "SELECT state FROM analysis_jobs WHERE id = 'analysis-job-1'",
      );
      const attempt = await pool.query<{
        state: string;
        stages: unknown;
      }>(
        "SELECT state, stages FROM analysis_attempts WHERE analysis_job_id = 'analysis-job-1'",
      );
      const stored = await pool.query<{
        record: AnalysisResultRecord;
        result_hash: string;
      }>(
        "SELECT record, result_hash FROM analysis_results WHERE id = 'analysis-result-1'",
      );
      const outbox = await pool.query<{
        type: string;
        kind: string;
        payload: unknown;
      }>(
        "SELECT type, kind, payload FROM outbox_envelopes WHERE id = 'outbox-completed-1'",
      );

      expect(job.rows).toEqual([{ state: "completed" }]);
      expect(attempt.rows[0]).toMatchObject({ state: "succeeded" });
      expect(stored.rows[0]?.record).toMatchObject({
        id: "analysis-result-1",
        analysisAttemptId: claim.execution.analysisAttemptId,
      });
      expect(stored.rows[0]?.result_hash).toMatch(/^[a-f0-9]{64}$/u);
      expect(outbox.rows).toEqual([
        {
          type: "analysis.completed.v1",
          kind: "domainEvent",
          payload: {
            analysisJobId: "analysis-job-1",
            analysisResultId: "analysis-result-1",
          },
        },
      ]);
    } finally {
      await persistence.close();
    }
  });

  it("rolls back the result and terminal transitions when the completed-event outbox insert fails", async () => {
    await resetDatabase();
    await seedAnalysisJob();
    const persistence = createPostgresPersistence({ databaseUrl });

    try {
      await pool.query(
        `INSERT INTO outbox_envelopes (
          id, workspace_id, kind, type, schema_version, occurred_at,
          correlation_id, causation_id, payload, available_at
        ) VALUES (
          'outbox-completed-1', 'workspace-1', 'domainEvent', 'analysis.completed.v1', 1, $1,
          'correlation-1', 'causation-1', $2::jsonb, $1
        )`,
        [
          "2026-07-14T15:01:00.000Z",
          JSON.stringify({
            analysisJobId: "another-job",
            analysisResultId: "another-result",
          }),
        ],
      );
      const claim = await persistence.analysisExecutionStore.claim(
        command(),
        new AbortController().signal,
      );
      expect(claim.kind).toBe("claimed");
      if (claim.kind !== "claimed")
        throw new Error("Expected claimed analysis.");
      const storedResult = result(claim.execution);

      await expect(
        persistence.analysisExecutionStore.complete(
          {
            execution: claim.execution,
            result: storedResult,
            event: completedEvent("analysis-job-1", storedResult.id),
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow();

      const job = await pool.query<{ state: string }>(
        "SELECT state FROM analysis_jobs WHERE id = 'analysis-job-1'",
      );
      const attempt = await pool.query<{ state: string }>(
        "SELECT state FROM analysis_attempts WHERE analysis_job_id = 'analysis-job-1'",
      );
      const results = await pool.query(
        "SELECT id FROM analysis_results WHERE analysis_job_id = 'analysis-job-1'",
      );
      const events = await pool.query(
        "SELECT id FROM outbox_envelopes WHERE type = 'analysis.completed.v1'",
      );

      expect(job.rows).toEqual([{ state: "running" }]);
      expect(attempt.rows).toEqual([{ state: "running" }]);
      expect(results.rows).toHaveLength(0);
      expect(events.rows).toEqual([{ id: "outbox-completed-1" }]);
    } finally {
      await persistence.close();
    }
  });

  it("records a required-stage failure without a result or completed event", async () => {
    await resetDatabase();
    await seedAnalysisJob();
    const persistence = createPostgresPersistence({ databaseUrl });

    try {
      const claim = await persistence.analysisExecutionStore.claim(
        command(),
        new AbortController().signal,
      );
      expect(claim.kind).toBe("claimed");
      if (claim.kind !== "claimed")
        throw new Error("Expected claimed analysis.");

      await persistence.analysisExecutionStore.fail(
        {
          execution: claim.execution,
          outcome: "failed",
          stages: [
            {
              stage: "retrieval",
              status: "failed",
              policy: "required",
              error: {
                code: "analysis.stageFailed",
                retryable: true,
              },
            },
          ],
          error: { code: "analysis.stageFailed", retryable: true },
        },
        new AbortController().signal,
      );

      const job = await pool.query<{ state: string }>(
        "SELECT state FROM analysis_jobs WHERE id = 'analysis-job-1'",
      );
      const attempt = await pool.query<{
        state: string;
        error_code: string;
        error_retryable: boolean;
      }>(
        `SELECT state, error_code, error_retryable
         FROM analysis_attempts
         WHERE analysis_job_id = 'analysis-job-1'`,
      );
      const results = await pool.query(
        "SELECT id FROM analysis_results WHERE analysis_job_id = 'analysis-job-1'",
      );
      const events = await pool.query(
        "SELECT id FROM outbox_envelopes WHERE type = 'analysis.completed.v1'",
      );

      expect(job.rows).toEqual([{ state: "failed" }]);
      expect(attempt.rows).toEqual([
        {
          state: "failed",
          error_code: "analysis.stageFailed",
          error_retryable: true,
        },
      ]);
      expect(results.rows).toHaveLength(0);
      expect(events.rows).toHaveLength(0);
    } finally {
      await persistence.close();
    }
  });

  it("tombstones a snapshot with immutable audit metadata while preserving its captured content", async () => {
    await resetDatabase();
    await seedAnalysisJob();
    const persistence = createPostgresPersistence({ databaseUrl });
    const tombstone = {
      actorPrincipalId: "principal-1",
      tombstonedAt: "2026-07-14T15:05:00.000Z",
      reason: "Source case was deleted under the retention policy.",
    };

    try {
      await expect(
        persistence.caseSnapshotTombstoneStore.tombstone({
          workspaceId: "workspace-1",
          caseSnapshotId: "snapshot-1",
          tombstone,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        kind: "tombstoned",
        snapshot: {
          title: snapshot.title,
          summary: snapshot.summary,
          contentHash: snapshot.contentHash,
          tombstone,
        },
      });
      await expect(
        persistence.caseSnapshotTombstoneStore.tombstone({
          workspaceId: "workspace-1",
          caseSnapshotId: "snapshot-1",
          tombstone: {
            ...tombstone,
            reason: "A later caller must not replace the original reason.",
          },
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        kind: "alreadyTombstoned",
        snapshot: { tombstone },
      });

      const stored = await pool.query<{
        lifecycle: string;
        snapshot: typeof snapshot;
        snapshot_hash: string;
        tombstoned_by_principal_id: string;
        tombstoned_at: Date;
        tombstone_reason: string;
      }>(
        `SELECT
          lifecycle,
          snapshot,
          snapshot_hash,
          tombstoned_by_principal_id,
          tombstoned_at,
          tombstone_reason
        FROM case_snapshots
        WHERE id = 'snapshot-1'`,
      );
      expect(stored.rows).toEqual([
        {
          lifecycle: "tombstoned",
          snapshot,
          snapshot_hash: snapshot.contentHash,
          tombstoned_by_principal_id: "principal-1",
          tombstoned_at: new Date(tombstone.tombstonedAt),
          tombstone_reason: tombstone.reason,
        },
      ]);
      await expect(
        pool.query(
          "UPDATE case_snapshots SET tombstone_reason = 'replacement' WHERE id = 'snapshot-1'",
        ),
      ).rejects.toThrow("Case snapshot tombstones are immutable");

      const claim = await persistence.analysisExecutionStore.claim(
        command(),
        new AbortController().signal,
      );
      expect(claim).toMatchObject({
        kind: "claimed",
        execution: {
          snapshot: {
            title: snapshot.title,
            summary: snapshot.summary,
            tombstone,
          },
        },
      });
    } finally {
      await persistence.close();
    }
  });

  it("force-reruns in a new job and attempt without replacing the completed result", async () => {
    await resetDatabase();
    await seedAnalysisJob();
    const persistence = createPostgresPersistence({ databaseUrl });

    try {
      const firstClaim = await persistence.analysisExecutionStore.claim(
        command(),
        new AbortController().signal,
      );
      expect(firstClaim.kind).toBe("claimed");
      if (firstClaim.kind !== "claimed")
        throw new Error("Expected the initial analysis to be claimed.");
      const firstResult = result(firstClaim.execution);
      await persistence.analysisExecutionStore.complete(
        {
          execution: firstClaim.execution,
          result: firstResult,
          event: completedEvent("analysis-job-1", firstResult.id),
        },
        new AbortController().signal,
      );

      const rerun = await new ForceRerunAnalysis(
        persistence.unitOfWork,
        persistence.analysisRequestStore,
        persistence.outboxStore,
        persistence.auditStore,
        { require: async () => undefined },
        rerunIds(),
        { now: () => utcInstant("2026-07-14T15:02:00.000Z") },
      ).execute(
        { analysisIdentityId: analysisIdentityId("analysis-identity-1") },
        {
          requestId: requestId("request-force-rerun-1"),
          workspaceId: workspaceId("workspace-1"),
          principalId: principalId("principal-1"),
          correlationId: correlationId("correlation-force-rerun-1"),
          signal: new AbortController().signal,
        },
      );
      expect(rerun).toMatchObject({
        analysisIdentityId: "analysis-identity-1",
        runOrdinal: 1,
        state: "queued",
      });

      const rerunClaim = await persistence.analysisExecutionStore.claim(
        command(rerun.id),
        new AbortController().signal,
      );
      expect(rerunClaim.kind).toBe("claimed");
      if (rerunClaim.kind !== "claimed")
        throw new Error("Expected the rerun analysis to be claimed.");
      const rerunResult = result(rerunClaim.execution, "analysis-result-2");
      await persistence.analysisExecutionStore.complete(
        {
          execution: rerunClaim.execution,
          result: rerunResult,
          event: completedEvent(rerun.id, rerunResult.id, "outbox-completed-2"),
        },
        new AbortController().signal,
      );

      const jobs = await pool.query<{
        id: string;
        run_ordinal: number;
        state: string;
      }>(
        `SELECT id, run_ordinal, state
         FROM analysis_jobs
         WHERE analysis_identity_id = 'analysis-identity-1'
         ORDER BY run_ordinal`,
      );
      const attempts = await pool.query<{
        analysis_job_id: string;
        attempt_ordinal: number;
        state: string;
      }>(
        `SELECT analysis_job_id, attempt_ordinal, state
         FROM analysis_attempts
         WHERE analysis_job_id IN ('analysis-job-1', $1)
         ORDER BY analysis_job_id`,
        [rerun.id],
      );
      const results = await pool.query<{
        id: string;
        analysis_job_id: string;
        record: AnalysisResultRecord;
      }>(
        `SELECT id, analysis_job_id, record
         FROM analysis_results
         WHERE analysis_job_id IN ('analysis-job-1', $1)
         ORDER BY analysis_job_id`,
        [rerun.id],
      );

      expect(jobs.rows).toEqual([
        { id: "analysis-job-1", run_ordinal: 0, state: "completed" },
        { id: rerun.id, run_ordinal: 1, state: "completed" },
      ]);
      expect(attempts.rows).toEqual([
        {
          analysis_job_id: "analysis-job-1",
          attempt_ordinal: 0,
          state: "succeeded",
        },
        {
          analysis_job_id: rerun.id,
          attempt_ordinal: 0,
          state: "succeeded",
        },
      ]);
      expect(results.rows).toMatchObject([
        {
          id: "analysis-result-1",
          analysis_job_id: "analysis-job-1",
          record: { id: "analysis-result-1" },
        },
        {
          id: "analysis-result-2",
          analysis_job_id: rerun.id,
          record: { id: "analysis-result-2" },
        },
      ]);
    } finally {
      await persistence.close();
    }
  });
});
