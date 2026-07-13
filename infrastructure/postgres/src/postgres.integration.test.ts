import {
  analysisIdentityId,
  analysisJobId,
  causationId,
  correlationId,
  createEnvelope,
  outboxEnvelopeId,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { Pool } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { createPostgresPersistence } from "./index.js";

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

beforeAll(async () => resetDatabase());

describe("PBI-002 PostgreSQL foundation", () => {
  it("migrates the vector extension and foundational tables", async () => {
    const extension = await pool.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    const table = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'outbox_envelopes'",
    );

    expect(extension.rows).toHaveLength(1);
    expect(table.rows).toHaveLength(1);
  });

  it("prevents a connector reference from crossing workspaces", async () => {
    await resetDatabase();
    await pool.query(
      "INSERT INTO workspaces (id) VALUES ('workspace-a'), ('workspace-b')",
    );
    await pool.query(
      "INSERT INTO connector_registrations (id, workspace_id, lifecycle) VALUES ('connector-a', 'workspace-a', 'active')",
    );

    await expect(
      pool.query(
        "INSERT INTO external_references (id, workspace_id, connector_registration_id, kind, external_id) VALUES ('reference-b', 'workspace-b', 'connector-a', 'case', 'external-1')",
      ),
    ).rejects.toThrow();
  });

  it("rolls back a failed transaction without retaining a workspace", async () => {
    await resetDatabase();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO workspaces (id) VALUES ('rolled-back')");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const result = await pool.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE id = 'rolled-back'",
    );
    expect(result.rows).toHaveLength(0);
  });

  it("uses database-time fencing so only one concurrent lease is current", async () => {
    await resetDatabase();
    await pool.query("INSERT INTO workspaces (id) VALUES ('workspace-lease')");
    const persistence = createPostgresPersistence({ databaseUrl });
    const acquire = () =>
      persistence.unitOfWork.transaction((transaction) =>
        persistence.resourceLeaseStore.acquire(transaction, {
          workspaceId: workspaceId("workspace-lease"),
          resourceType: "analysis",
          resourceKey: "identity-1",
          leaseMs: 25,
        }),
      );

    try {
      const [first, second] = await Promise.all([acquire(), acquire()]);
      const current = first ?? second;
      expect(current).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 35));
      const replacement = await acquire();
      expect(replacement?.fencingToken).toBe(
        (current?.fencingToken ?? 0n) + 1n,
      );
      await expect(
        persistence.unitOfWork.transaction((transaction) =>
          persistence.resourceLeaseStore.complete(transaction, {
            workspaceId: workspaceId("workspace-lease"),
            resourceType: "analysis",
            resourceKey: "identity-1",
            fencingToken: current?.fencingToken ?? 0n,
          }),
        ),
      ).resolves.toBe(false);
    } finally {
      await persistence.close();
    }
  });

  it("claims an expired outbox envelope again with its stable ID", async () => {
    await resetDatabase();
    await pool.query("INSERT INTO workspaces (id) VALUES ('workspace-outbox')");
    const persistence = createPostgresPersistence({ databaseUrl });
    const envelope = createEnvelope({
      id: outboxEnvelopeId("outbox-1"),
      kind: "command",
      type: "analysis.execute.v1",
      schemaVersion: 1,
      workspaceId: workspaceId("workspace-outbox"),
      occurredAt: utcInstant("2026-01-01T00:00:00.000Z"),
      correlationId: correlationId("correlation-1"),
      causationId: causationId("cause-1"),
      payload: {
        analysisJobId: analysisJobId("job-1"),
        analysisIdentityId: analysisIdentityId("identity-1"),
      },
    });

    try {
      await persistence.unitOfWork.transaction((transaction) =>
        persistence.outboxStore.append(transaction, envelope),
      );
      const first = await persistence.unitOfWork.transaction((transaction) =>
        persistence.outboxStore.claim(transaction, {
          limit: 1,
          leaseMs: 25,
          now: utcInstant("2026-01-01T00:00:00.000Z"),
        }),
      );
      expect(first[0]?.envelope.id).toBe(envelope.id);
      await new Promise((resolve) => setTimeout(resolve, 35));
      const recovered = await persistence.unitOfWork.transaction(
        (transaction) =>
          persistence.outboxStore.claim(transaction, {
            limit: 1,
            leaseMs: 25,
            now: utcInstant("2026-01-01T00:00:00.000Z"),
          }),
      );
      expect(recovered[0]?.envelope.id).toBe(envelope.id);
    } finally {
      await persistence.close();
    }
  });

  it("does not give one available outbox envelope to concurrent relays twice", async () => {
    await resetDatabase();
    await pool.query("INSERT INTO workspaces (id) VALUES ('workspace-claim')");
    const persistence = createPostgresPersistence({ databaseUrl });
    const envelope = createEnvelope({
      id: outboxEnvelopeId("outbox-concurrent-1"),
      kind: "command",
      type: "analysis.execute.v1",
      schemaVersion: 1,
      workspaceId: workspaceId("workspace-claim"),
      occurredAt: utcInstant("2026-01-01T00:00:00.000Z"),
      correlationId: correlationId("correlation-1"),
      causationId: causationId("cause-1"),
      payload: {
        analysisJobId: analysisJobId("job-1"),
        analysisIdentityId: analysisIdentityId("identity-1"),
      },
    });

    try {
      await persistence.unitOfWork.transaction((transaction) =>
        persistence.outboxStore.append(transaction, envelope),
      );
      const claim = () =>
        persistence.unitOfWork.transaction((transaction) =>
          persistence.outboxStore.claim(transaction, {
            limit: 1,
            leaseMs: 1_000,
            now: utcInstant("2026-01-01T00:00:00.000Z"),
          }),
        );

      const claims = await Promise.all([claim(), claim()]);

      expect(
        claims.flatMap((claimed) =>
          claimed.map(({ envelope: item }) => item.id),
        ),
      ).toEqual([envelope.id]);
    } finally {
      await persistence.close();
    }
  });
});
