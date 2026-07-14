import { randomUUID } from "node:crypto";
import {
  type Clock,
  type ExecutionContext,
  type IdGenerator,
  RetryDeadLetter,
} from "@caseweaver/application";
import {
  analysisJobId,
  caseSnapshotId,
  causationId,
  correlationId,
  createEnvelope,
  outboxEnvelopeId,
  principalId,
  requestId,
  sha256Digest,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createPostgresPersistence } from "../index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("PostgreSQL integration tests require DATABASE_URL.");
}

const pool = new Pool({ connectionString: databaseUrl });

async function resetDatabase(): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      retention_work_items,
      privacy_tombstones,
      ai_operation_costs,
      ai_operations,
      ai_model_binding_versions,
      ai_model_bindings,
      ai_provider_instance_versions,
      ai_provider_instances,
      ai_catalog_models,
      ai_catalog_snapshots,
      analysis_attempts,
      analysis_jobs,
      analysis_identities,
      analysis_profile_versions,
      analysis_profiles,
      evidence,
      analysis_results,
      case_snapshots,
      external_references,
      connector_capabilities,
      connector_registrations,
      workspace_role_assignments,
      principals,
      idempotency_records,
      resource_leases,
      outbox_envelopes,
      audit_events,
      workspaces
    RESTART IDENTITY CASCADE
  `);
}

async function seedRunningJob(): Promise<void> {
  const hash = "a".repeat(64);
  await pool.query(`
    INSERT INTO workspaces (id) VALUES ('workspace-operations');
    INSERT INTO principals (id, workspace_id)
      VALUES ('principal-operations', 'workspace-operations');
    INSERT INTO workspace_role_assignments (workspace_id, principal_id, role)
      VALUES ('workspace-operations', 'principal-operations', 'administrator');
    INSERT INTO connector_registrations (id, workspace_id, lifecycle)
      VALUES ('connector-operations', 'workspace-operations', 'active');
    INSERT INTO external_references (
      id, workspace_id, connector_registration_id, kind, external_id
    ) VALUES (
      'reference-operations', 'workspace-operations',
      'connector-operations', 'case', 'external-operations'
    );
    INSERT INTO case_snapshots (
      id, workspace_id, external_reference_id, lifecycle, snapshot_hash,
      snapshot, observed_at
    ) VALUES (
      'snapshot-operations', 'workspace-operations', 'reference-operations',
      'active', '${hash}',
      '{"id":"snapshot-operations","revision":"r1","capturedAt":"2026-07-14T00:00:00.000Z","title":"secret subject","summary":"secret case content","contentHash":"${hash}","messages":[]}',
      '2026-07-14T00:00:00.000Z'
    );
    INSERT INTO analysis_profiles (id, workspace_id, lifecycle)
      VALUES ('profile-operations', 'workspace-operations', 'active');
    INSERT INTO analysis_profile_versions (
      id, workspace_id, analysis_profile_id, version, definition_hash, definition
    ) VALUES (
      'profile-version-operations', 'workspace-operations',
      'profile-operations', 1, '${hash}', '{}'
    );
    INSERT INTO analysis_identities (
      id, workspace_id, identity_hash, analysis_profile_version_id, case_snapshot_id
    ) VALUES (
      'identity-operations', 'workspace-operations', '${hash}',
      'profile-version-operations', 'snapshot-operations'
    );
    INSERT INTO analysis_jobs (
      id, workspace_id, analysis_identity_id, run_ordinal, state
    ) VALUES (
      'job-operations', 'workspace-operations', 'identity-operations', 0, 'running'
    );
    INSERT INTO analysis_attempts (
      id, workspace_id, analysis_job_id, attempt_ordinal, state, started_at,
      lease_expires_at, stages
    ) VALUES (
      'attempt-operations', 'workspace-operations', 'job-operations', 0,
      'running', NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '5 minutes', '[]'
    );
  `);
}

beforeEach(async () => {
  await resetDatabase();
  await seedRunningJob();
});

afterAll(async () => {
  await pool.end();
});

describe("PBI-013 PostgreSQL operations", () => {
  it("persists W3C trace context through the durable outbox", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      const envelope = createEnvelope({
        id: outboxEnvelopeId("e301c9f5-9064-5c8d-8b5b-a68d1528e554"),
        kind: "command",
        type: "retention.purge.v1",
        schemaVersion: 1,
        workspaceId: workspaceId("workspace-operations"),
        occurredAt: utcInstant("2026-07-14T18:00:00.000Z"),
        correlationId: correlationId("correlation-trace"),
        causationId: causationId("causation-trace"),
        traceContext: {
          traceparent:
            "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        },
        payload: { workItemId: "work-item-trace" },
      });
      await persistence.unitOfWork.transaction((transaction) =>
        persistence.outboxStore.append(transaction, envelope),
      );
      const claimed = await persistence.unitOfWork.transaction((transaction) =>
        persistence.outboxStore.claim(transaction, {
          limit: 1,
          leaseMs: 1_000,
          now: utcInstant("2026-07-14T18:00:00.000Z"),
        }),
      );
      expect(claimed[0]?.envelope.traceContext).toEqual(envelope.traceContext);
    } finally {
      await persistence.close();
    }
  });

  it("authorizes, audits, and idempotently retries a dead letter", async () => {
    await pool.query(`
      UPDATE analysis_attempts
      SET state = 'failed', finished_at = NOW(),
          error_code = 'provider.timeout', error_retryable = true
      WHERE id = 'attempt-operations';
      UPDATE analysis_jobs SET state = 'failed' WHERE id = 'job-operations';
    `);
    const persistence = createPostgresPersistence({ databaseUrl });
    const ids: IdGenerator = { next: () => randomUUID() };
    const clock: Clock = {
      now: () => utcInstant("2026-07-14T18:00:00.000Z"),
    };
    const context: ExecutionContext = {
      requestId: requestId("request-operations"),
      workspaceId: workspaceId("workspace-operations"),
      principalId: principalId("principal-operations"),
      correlationId: correlationId("correlation-operations"),
      signal: new AbortController().signal,
    };
    const retry = new RetryDeadLetter(
      persistence.unitOfWork,
      persistence.operationsStore,
      persistence.outboxStore,
      persistence.auditStore,
      persistence.authorizationGuard,
      ids,
      clock,
    );
    const mutation = {
      idempotencyKeyDigest: sha256Digest("c".repeat(64)),
      requestDigest: sha256Digest("d".repeat(64)),
    };
    try {
      const first = await retry.execute(
        analysisJobId("job-operations"),
        mutation,
        context,
      );
      const replay = await retry.execute(
        analysisJobId("job-operations"),
        mutation,
        context,
      );

      expect(first.analysisJobId).toBeDefined();
      expect(replay).toEqual({
        analysisJobId: first.analysisJobId,
        replayed: true,
      });
      const audit = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM audit_events WHERE action = 'operations.deadLetter.retry'",
      );
      const outbox = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM outbox_envelopes WHERE type = 'analysis.execute.v1'",
      );
      expect(audit.rows[0]?.count).toBe("1");
      expect(outbox.rows[0]?.count).toBe("1");
    } finally {
      await persistence.close();
    }
  });

  it("fences an expired attempt before requeueing its exact analysis job", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      const recovered = await persistence.unitOfWork.transaction(
        (transaction) =>
          persistence.operationsStore.recoverExpiredJob(transaction, {
            workspaceId: workspaceId("workspace-operations"),
            analysisJobId: analysisJobId("job-operations"),
            fencingToken: 7n,
            occurredAt: utcInstant("2026-07-14T18:00:00.000Z"),
          }),
      );
      expect(recovered).toMatchObject({
        id: "job-operations",
        state: "queued",
      });
      const attempt = await pool.query<{
        state: string;
        error_code: string;
        recovery_fencing_token: string;
      }>(
        "SELECT state, error_code, recovery_fencing_token FROM analysis_attempts WHERE id = 'attempt-operations'",
      );
      expect(attempt.rows).toEqual([
        {
          state: "failed",
          error_code: "operations.leaseExpired",
          recovery_fencing_token: "7",
        },
      ]);
    } finally {
      await persistence.close();
    }
  });

  it("returns exact numeric costs by immutable analysis attribution", async () => {
    const hash = "b".repeat(64);
    await pool.query(`
      INSERT INTO ai_catalog_snapshots (
        id, upstream_url, upstream_commit_sha, fetched_at, sha256, raw_entries
      ) VALUES (
        'catalog-1', 'https://pricing.example.test', 'commit-1',
        '2026-07-14T00:00:00.000Z', '${hash}', '{}'
      );
      INSERT INTO ai_catalog_models (
        id, catalog_snapshot_id, canonical_model, provider, supported_roles,
        capabilities, raw_entry
      ) VALUES (
        'catalog-model-1', 'catalog-1', 'model-1', 'provider-1',
        '["analysis"]', '{}', '{}'
      );
      INSERT INTO ai_provider_instances (
        id, workspace_id, provider_type, lifecycle
      ) VALUES (
        'provider-1', 'workspace-operations', 'test', 'active'
      );
      INSERT INTO ai_provider_instance_versions (
        id, workspace_id, provider_instance_id, version, endpoint, wire_api,
        parameters, secret_reference
      ) VALUES (
        'provider-version-1', 'workspace-operations', 'provider-1', 1,
        'https://provider.example.test', 'test', '{}', 'test:secret'
      );
      INSERT INTO ai_model_bindings (id, workspace_id, role, lifecycle)
        VALUES ('binding-1', 'workspace-operations', 'analysis', 'active');
      INSERT INTO ai_model_binding_versions (
        id, workspace_id, model_binding_id, version, provider_instance_version_id,
        catalog_snapshot_id, catalog_model_id, canonical_model, wire_api,
        parameters, capabilities, secret_reference
      ) VALUES (
        'binding-version-1', 'workspace-operations', 'binding-1', 1,
        'provider-version-1', 'catalog-1', 'catalog-model-1', 'model-1',
        'test', '{}', '{}', 'test:secret'
      );
      INSERT INTO ai_operations (
        id, workspace_id, analysis_job_id, role, operation_kind,
        model_binding_version_id, provider_instance_version_id,
        catalog_snapshot_id, configured_model, status, started_at
      ) VALUES (
        'operation-operations', 'workspace-operations', 'job-operations',
        'analysis', 'generation', 'binding-version-1', 'provider-version-1', 'catalog-1',
        'model-1', 'succeeded', '2026-07-14T18:00:00.000Z'
      );
      INSERT INTO ai_operation_costs (
        id, workspace_id, operation_id, calculated_amount, currency,
        calculation_status, price_inputs
      ) VALUES (
        'cost-operations', 'workspace-operations', 'operation-operations',
        0.123456789012345678, 'USD', 'known', '{}'
      );
    `);
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      const rows = await persistence.unitOfWork.transaction((transaction) =>
        persistence.operationsStore.queryCostAttribution(transaction, {
          workspaceId: workspaceId("workspace-operations"),
          analysisJobId: analysisJobId("job-operations"),
          limit: 10,
        }),
      );
      expect(rows).toEqual([
        expect.objectContaining({
          operationId: "operation-operations",
          analysisJobId: "job-operations",
          calculatedAmount: "0.123456789012345678",
          currency: "USD",
        }),
      ]);
    } finally {
      await persistence.close();
    }
  });

  it("purges snapshot content while retaining a privacy tombstone hash", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      const result = await persistence.unitOfWork.transaction((transaction) =>
        persistence.operationsStore.purgeCaseSnapshot(transaction, {
          workspaceId: workspaceId("workspace-operations"),
          caseSnapshotId: caseSnapshotId("snapshot-operations"),
          actorPrincipalId: principalId("principal-operations"),
          reason: "privacy request",
          occurredAt: utcInstant("2026-07-14T18:00:00.000Z"),
        }),
      );
      expect(result.kind).toBe("purged");
      const snapshot = await pool.query<{
        snapshot: unknown;
        lifecycle: string;
      }>(
        "SELECT snapshot, lifecycle FROM case_snapshots WHERE id = 'snapshot-operations'",
      );
      expect(snapshot.rows[0]).toEqual({
        lifecycle: "tombstoned",
        snapshot: expect.not.objectContaining({
          title: "secret subject",
          summary: "secret case content",
        }),
      });
      const tombstones = await pool.query<{ snapshot_hash: string }>(
        "SELECT snapshot_hash FROM privacy_tombstones WHERE case_snapshot_id = 'snapshot-operations'",
      );
      expect(tombstones.rows[0]?.snapshot_hash).toBe("a".repeat(64));
    } finally {
      await persistence.close();
    }
  });
});
