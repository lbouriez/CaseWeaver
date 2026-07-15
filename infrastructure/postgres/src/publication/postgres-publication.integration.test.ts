import {
  analysisJobId,
  causationId,
  correlationId,
  createEnvelope,
  outboxEnvelopeId,
  publicationIntentId,
  sha256Digest,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import {
  createPublicationIdentity,
  InMemoryAnalysisDestination,
  InMemoryPublicationDestinationResolver,
  PublicationExecutor,
  StructuredAnalysisPublicationRenderer,
} from "@caseweaver/publication";
import { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";

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
const now = "2026-07-14T16:00:00.000Z";
const definitionHash = "a".repeat(64);

const profile = {
  id: "publication-profile-1",
  version: "1",
  destination: { connectorInstanceId: "connector-1" },
  renderer: { id: "structured", version: "1", format: "markdown" },
  notices: { disclaimers: [] },
  policy: { mode: "autoPublishInternal", visibility: "internal" },
  limits: { maximumBodyCharacters: 10_000 },
};

const output = {
  summary: "The required service role is missing.",
  probableCauses: [
    {
      statement: "A deployment removed the service role.",
      evidenceIds: [],
      hypothesis: true,
    },
  ],
  investigation: [],
  recommendedActions: [
    {
      statement: "Restore the role.",
      evidenceIds: [],
      hypothesis: true,
    },
  ],
  evidence: [],
  unansweredQuestions: [],
  confidence: "high",
};

async function resetDatabase(): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      webhook_inbox,
      case_analysis_schedule_occurrences,
      case_analysis_schedule_leases,
      case_analysis_schedules,
      publication_attempts,
      publication_intents,
      publication_profile_versions,
      publication_profiles,
      evidence,
      analysis_results,
      analysis_attempts,
      analysis_jobs,
      analysis_identities,
      analysis_profile_versions,
      analysis_profiles,
      case_snapshots,
      external_references,
      connector_capabilities,
      connector_registrations,
      idempotency_records,
      inbox_messages,
      outbox_envelopes,
      resource_leases,
      audit_events,
      principals,
      workspaces
    RESTART IDENTITY CASCADE
  `);
}

async function seedCompletedAnalysis(): Promise<void> {
  await pool.query("INSERT INTO workspaces (id) VALUES ('workspace-1')");
  await pool.query(
    "INSERT INTO connector_registrations (id, workspace_id, lifecycle) VALUES ('connector-1', 'workspace-1', 'active')",
  );
  await pool.query(
    `INSERT INTO connector_capabilities (
       workspace_id, connector_registration_id, capability
     ) VALUES ('workspace-1', 'connector-1', 'analysisDestination')`,
  );
  await pool.query(
    `INSERT INTO external_references (
       id, workspace_id, connector_registration_id, kind, external_id
     ) VALUES ('reference-1', 'workspace-1', 'connector-1', 'case', 'case-1')`,
  );
  await pool.query(
    `INSERT INTO case_snapshots (
       id, workspace_id, external_reference_id, lifecycle, snapshot_hash, observed_at
     ) VALUES ('snapshot-1', 'workspace-1', 'reference-1', 'active', $1, $2)`,
    [definitionHash, now],
  );
  await pool.query(
    `INSERT INTO analysis_profiles (id, workspace_id, lifecycle)
     VALUES ('analysis-profile-1', 'workspace-1', 'active')`,
  );
  await pool.query(
    `INSERT INTO analysis_profile_versions (
       id, workspace_id, analysis_profile_id, version, definition_hash
     ) VALUES ('analysis-profile-version-1', 'workspace-1', 'analysis-profile-1', 1, $1)`,
    [definitionHash],
  );
  await pool.query(
    `INSERT INTO analysis_identities (
       id, workspace_id, identity_hash, analysis_profile_version_id, case_snapshot_id
     ) VALUES (
       'analysis-identity-1', 'workspace-1', $1, 'analysis-profile-version-1', 'snapshot-1'
     )`,
    ["b".repeat(64)],
  );
  await pool.query(
    `INSERT INTO analysis_jobs (
       id, workspace_id, analysis_identity_id, run_ordinal, state
     ) VALUES ('analysis-job-1', 'workspace-1', 'analysis-identity-1', 0, 'completed')`,
  );
  await pool.query(
    `INSERT INTO analysis_results (
       id, workspace_id, analysis_job_id, result_hash, record
     ) VALUES ('analysis-result-1', 'workspace-1', 'analysis-job-1', $1, $2::jsonb)`,
    [definitionHash, JSON.stringify({ output })],
  );
  await pool.query(
    `INSERT INTO publication_profiles (id, workspace_id, lifecycle)
     VALUES ('publication-profile-1', 'workspace-1', 'active')`,
  );
  await pool.query(
    `INSERT INTO publication_profile_versions (
       id, workspace_id, publication_profile_id, version, definition_hash, definition
     ) VALUES (
       'publication-profile-version-1', 'workspace-1', 'publication-profile-1',
       '1', $1, $2::jsonb
     )`,
    [definitionHash, JSON.stringify(profile)],
  );
}

beforeEach(async () => resetDatabase());

describe("PostgreSQL publication and webhook persistence", () => {
  it("rejects a publication profile version without an active destination capability", async () => {
    await pool.query("INSERT INTO workspaces (id) VALUES ('workspace-1')");
    await pool.query(
      `INSERT INTO publication_profiles (id, workspace_id, lifecycle)
       VALUES ('publication-profile-1', 'workspace-1', 'active')`,
    );

    await expect(
      pool.query(
        `INSERT INTO publication_profile_versions (
           id, workspace_id, publication_profile_id, version, definition_hash, definition
         ) VALUES (
           'publication-profile-version-1', 'workspace-1', 'publication-profile-1',
           '1', $1, $2::jsonb
         )`,
        [
          definitionHash,
          JSON.stringify({
            ...profile,
            destination: { connectorInstanceId: "missing-destination" },
          }),
        ],
      ),
    ).rejects.toThrow("active analysis destination");
  });

  it("persists a verified webhook inbox and its trigger outbox exactly once", async () => {
    await pool.query("INSERT INTO workspaces (id) VALUES ('workspace-1')");
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      const event = {
        endpointId: "opaque-endpoint-1",
        workspaceId: "workspace-1",
        connectorInstanceId: "connector-1",
        analysisTriggerId: "trigger-1",
        deliveryKey: "delivery-key-1",
        rawBodyDigest: definitionHash,
        receivedAt: now,
        verification: { eventType: "case.updated", eventId: "event-1" },
        signals: [
          {
            kind: "caseChanged" as const,
            reference: {
              connectorInstanceId: "connector-1",
              resourceType: "case",
              externalId: "case-1",
            },
          },
        ],
      };

      await expect(
        persistence.verifiedWebhookEventStore.persist(event),
      ).resolves.toBe("accepted");
      await expect(
        persistence.verifiedWebhookEventStore.persist(event),
      ).resolves.toBe("duplicate");
      await expect(
        pool.query(
          "SELECT id FROM webhook_inbox WHERE endpoint_id = 'opaque-endpoint-1'",
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        pool.query(
          "SELECT id FROM outbox_envelopes WHERE type = 'analysis.trigger.v1'",
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await persistence.close();
    }
  });

  it("deduplicates ready publication handoff and leases concurrent publication", async () => {
    await seedCompletedAnalysis();
    const persistence = createPostgresPersistence({ databaseUrl });
    try {
      const intent = await persistence.unitOfWork.transaction(
        async (transaction) => {
          const storedProfile =
            await persistence.publicationIntentStore.findProfile(transaction, {
              workspaceId: workspaceId("workspace-1"),
              profileId: "publication-profile-1",
              profileVersion: "1",
            });
          if (storedProfile === undefined)
            throw new Error("Missing seeded profile.");
          return persistence.publicationIntentStore.createOrFindIntent(
            transaction,
            {
              id: publicationIntentId("publication-intent-1"),
              workspaceId: workspaceId("workspace-1"),
              analysisJobId: analysisJobId("analysis-job-1"),
              profile: storedProfile,
              target: {
                connectorInstanceId: "connector-1",
                resourceType: "case",
                externalId: "case-1",
              },
              intentHash: sha256Digest(definitionHash),
              state: "pending",
              occurredAt: utcInstant(now),
            },
          );
        },
      );
      const identity = createPublicationIdentity({
        workspaceId: "workspace-1",
        analysisResultId: "analysis-result-1",
        publicationProfileId: "publication-profile-1",
        publicationProfileVersion: "1",
        destinationConnectorInstanceId: "connector-1",
        target: {
          connectorInstanceId: "connector-1",
          resourceType: "case",
          externalId: "case-1",
        },
      });
      await expect(
        pool.query(
          `SELECT analysis_result_id, identity_hash, publication_marker
           FROM publication_intents
           WHERE id = 'publication-intent-1'`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            analysis_result_id: "analysis-result-1",
            identity_hash: identity.identityHash,
            publication_marker: identity.marker.value,
          },
        ],
      });
      const envelope = createEnvelope({
        id: outboxEnvelopeId(`publication-command:${intent.id}`),
        kind: "command",
        type: "publication.execute.v1",
        schemaVersion: 1,
        workspaceId: workspaceId("workspace-1"),
        occurredAt: utcInstant(now),
        correlationId: correlationId("correlation-1"),
        causationId: causationId("cause-1"),
        payload: { publicationIntentId: intent.id },
      });
      await persistence.unitOfWork.transaction(async (transaction) => {
        await persistence.publicationIntentStore.enqueuePublication(
          transaction,
          envelope,
        );
        await persistence.publicationIntentStore.enqueuePublication(
          transaction,
          envelope,
        );
      });
      await expect(
        pool.query(
          "SELECT id FROM outbox_envelopes WHERE type = 'publication.execute.v1'",
        ),
      ).resolves.toMatchObject({ rowCount: 1 });

      const destination = new InMemoryAnalysisDestination();
      const destinations = new InMemoryPublicationDestinationResolver();
      destinations.register("connector-1", destination);
      const executor = new PublicationExecutor({
        unitOfWork: persistence.unitOfWork,
        store: persistence.publicationExecutionStore,
        leases: persistence.resourceLeaseStore,
        destinations,
        renderer: new StructuredAnalysisPublicationRenderer(),
        clock: { now: () => utcInstant(now) },
        leaseMs: 5_000,
      });
      const signal = new AbortController().signal;

      await Promise.all([
        executor.execute(envelope, signal),
        executor.execute(envelope, signal),
      ]);

      expect(destination.publishRequests).toHaveLength(1);
      await expect(
        pool.query(
          "SELECT state FROM publication_intents WHERE id = 'publication-intent-1'",
        ),
      ).resolves.toMatchObject({ rows: [{ state: "published" }] });
      await expect(
        pool.query(
          "SELECT state FROM publication_attempts WHERE publication_intent_id = 'publication-intent-1'",
        ),
      ).resolves.toMatchObject({ rows: [{ state: "published" }] });
    } finally {
      await persistence.close();
    }
  });
});
