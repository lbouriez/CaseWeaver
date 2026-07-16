import {
  CaptureAnalysisTriggerCase,
  CaptureAndSubmitAnalysisTrigger,
  type Clock,
  type IdGenerator,
  SubmitCapturedAnalysisTrigger,
} from "@caseweaver/application";
import {
  analysisJobId,
  analysisTriggerId,
  analysisTriggerRequestId,
  analysisTriggerVersionId,
  causationId,
  correlationId,
  createEnvelope,
  outboxEnvelopeId,
  principalId,
  sha256Digest,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPostgresPersistence,
  type PostgresTransactionLookup,
} from "../index.js";
import { PostgresAttachmentRepository } from "../attachments/index.js";
import { PostgresAnalysisTriggerRequestStore } from "./index.js";

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
const workspace = "workspace-trigger";
const trigger = "analysis-trigger-1";
const triggerVersion = "analysis-trigger-version-1";
const profile = "analysis-profile-1";
const profileVersion = "analysis-profile-version-1";
const connector = "connector-case-source-1";
const configurationVersion = "connector-configuration-version-1";
const actor = "principal-trigger";
const firstDigest = sha256Digest("a".repeat(64));
const secondDigest = sha256Digest("b".repeat(64));
const thirdDigest = sha256Digest("c".repeat(64));
const clock: Clock = { now: () => utcInstant("2026-07-15T19:00:00.000Z") };
const profileDefinition = {
  id: profile,
  version: profileVersion,
  analysisBindingVersionId: "analysis-binding-trigger-1",
  prompt: {
    template: {
      id: "analysis-prompt-trigger-1",
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
    profileId: "retrieval-profile-trigger-1",
    profileVersion: "1",
    collectionIds: ["collection-trigger-1"],
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

function submissionIds(): IdGenerator {
  let sequence = 0;
  return {
    next(kind) {
      sequence += 1;
      return `${kind}-trigger-submission-${sequence}`;
    },
  };
}

async function resetDatabase(): Promise<void> {
  await pool.query("TRUNCATE TABLE workspaces RESTART IDENTITY CASCADE");
}

async function seedTrigger(): Promise<void> {
  await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [workspace]);
  await pool.query(
    "INSERT INTO principals (id, workspace_id) VALUES ($1, $2)",
    [actor, workspace],
  );
  await pool.query(
    `INSERT INTO connector_registrations (id, workspace_id, lifecycle)
     VALUES ($1, $2, 'active')`,
    [connector, workspace],
  );
  await pool.query(
    `INSERT INTO connector_capabilities (
       workspace_id, connector_registration_id, capability
     ) VALUES ($1, $2, 'caseSource')`,
    [workspace, connector],
  );
  await pool.query(
    `INSERT INTO administration_descriptor_revisions (
       kind, type, version, descriptor, descriptor_hash
     ) VALUES (
       'connector', 'trigger-test-connector', 'v1',
       '{"connectorCapabilities":["caseSource"]}'::jsonb, repeat('a', 64)
     ) ON CONFLICT (kind, type, version) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO administration_configurations (
       id, workspace_id, resource_type, lifecycle, current_version_id
     ) VALUES ($1, $2, 'connector-instances', 'active', NULL)`,
    [connector, workspace],
  );
  await pool.query(
    `INSERT INTO administration_configuration_versions (
       id, workspace_id, configuration_id, version, settings, secret_references,
       descriptor_kind, descriptor_type, descriptor_version
     ) VALUES (
       $1, $2, $3, 1, '{}'::jsonb, '[]'::jsonb,
       'connector', 'trigger-test-connector', 'v1'
     )`,
    [configurationVersion, workspace, connector],
  );
  await pool.query(
    `UPDATE administration_configurations
     SET current_version_id = $1
     WHERE workspace_id = $2 AND id = $3`,
    [configurationVersion, workspace, connector],
  );
  await pool.query(
    `INSERT INTO analysis_profiles (id, workspace_id, lifecycle)
     VALUES ($1, $2, 'active')`,
    [profile, workspace],
  );
  await pool.query(
    `INSERT INTO analysis_profile_versions (
       id, workspace_id, analysis_profile_id, version, definition_hash, definition
     ) VALUES ($1, $2, $3, 1, repeat('b', 64), $4::jsonb)`,
    [profileVersion, workspace, profile, JSON.stringify(profileDefinition)],
  );
  await pool.query(
    `INSERT INTO analysis_triggers (id, workspace_id, lifecycle)
     VALUES ($1, $2, 'disabled')`,
    [trigger, workspace],
  );
  await pool.query(
    `INSERT INTO analysis_trigger_versions (
       id, workspace_id, analysis_trigger_id, version,
       analysis_profile_version_id, connector_registration_id,
       connector_configuration_version_id
     ) VALUES ($1, $2, $3, 1, $4, $5, $6)`,
    [
      triggerVersion,
      workspace,
      trigger,
      profileVersion,
      connector,
      configurationVersion,
    ],
  );
  await pool.query(
    `UPDATE analysis_triggers
     SET lifecycle = 'active', current_version_id = $1
     WHERE workspace_id = $2 AND id = $3`,
    [triggerVersion, workspace, trigger],
  );
}

function createInput(
  id: string,
  input: Readonly<{
    readonly requestDigest?: ReturnType<typeof sha256Digest>;
    readonly idempotencyKeyDigest?: ReturnType<typeof sha256Digest>;
    readonly expectedTriggerVersionId?: ReturnType<
      typeof analysisTriggerVersionId
    >;
  }> = {},
) {
  return {
    id: analysisTriggerRequestId(id),
    workspaceId: workspaceId(workspace),
    actorPrincipalId: principalId(actor),
    triggerId: analysisTriggerId(trigger),
    ...(input.expectedTriggerVersionId === undefined
      ? {}
      : { expectedTriggerVersionId: input.expectedTriggerVersionId }),
    source: "webhook" as const,
    occurrenceKey: "delivery-1",
    target: {
      connectorInstanceId: connector,
      resourceType: "case",
      externalId: "external-case-1",
    },
    idempotencyKeyDigest: input.idempotencyKeyDigest ?? firstDigest,
    requestDigest: input.requestDigest ?? firstDigest,
    occurredAt: clock.now(),
  };
}

function triggerCommand(
  request: Awaited<
    ReturnType<PostgresAnalysisTriggerRequestStore["createOrFind"]>
  >["request"],
) {
  return createEnvelope({
    id: outboxEnvelopeId(`outbox-${request.id}`),
    kind: "command",
    type: "analysis.trigger.v2",
    schemaVersion: 1,
    workspaceId: request.workspaceId,
    occurredAt: clock.now(),
    correlationId: correlationId("correlation-trigger-1"),
    causationId: causationId("causation-trigger-1"),
    payload: {
      triggerRequestId: request.id,
      triggerId: request.triggerId,
      triggerVersionId: request.triggerVersionId,
      connectorRegistrationId: request.connectorRegistrationId,
      connectorConfigurationVersionId: request.connectorConfigurationVersionId,
      source: request.source,
      ...(request.occurrenceKey === undefined
        ? {}
        : { occurrenceKey: request.occurrenceKey }),
      target: request.target,
    },
  });
}

function snapshot() {
  return {
    revision: "case-revision-1",
    capturedAt: utcInstant("2026-07-15T19:00:01.000Z"),
    title: "Case title",
    summary: "Case summary",
    contentHash: secondDigest,
    messages: [
      {
        id: "message-1",
        content: "Normalized case body",
        contentHash: firstDigest,
      },
    ],
  };
}

async function seedVerifiedAttachmentEvidence(): Promise<{
  readonly attachmentId: string;
  readonly derivativeId: string;
  readonly outputContentHash: string;
}> {
  const attachmentReference = "attachment-reference-trigger-1";
  const attachmentId = "attachment-trigger-1";
  const outputContentHash = "d".repeat(64);
  const identityValue = {
    workspaceId: workspace,
    accessPolicyHash: "e".repeat(64),
    contentSha256: "f".repeat(64),
    processor: "text",
    processorVersion: "1",
    securityPolicyVersion: "1",
    normalizationVersion: "1",
  };
  const identity = {
    ...identityValue,
    key: createHash("sha256")
      .update(JSON.stringify(identityValue))
      .digest("hex"),
  };
  await pool.query(
    `INSERT INTO external_references (
       id, workspace_id, connector_registration_id, kind, external_id
     ) VALUES ($1, $2, $3, 'attachment', 'attachment-external-1')`,
    [attachmentReference, workspace, connector],
  );
  const repository = new PostgresAttachmentRepository(pool, 60_000);
  const claimed = await repository.claimDerivative(identity);
  if (claimed.kind !== "claimed") {
    throw new Error("Expected attachment derivative claim.");
  }
  const derivativeId = `attachment-derivative:${identity.key}`;
  await repository.completeDerivative({
    claimId: claimed.claimId,
    derivative: {
      id: derivativeId,
      identity,
      status: "completed",
      output: {
        workspaceId: workspace,
        storageBackendId: "storage-test",
        key: "derivative-output-trigger-1",
      },
      mimeType: "text/plain",
      outputContentHash,
      outputByteLength: 10,
    },
  });
  await repository.recordAttachment({
    id: attachmentId,
    workspaceId: workspace,
    sourceReferenceId: attachmentReference,
    storage: {
      workspaceId: workspace,
      storageBackendId: "storage-test",
      key: "source-output-trigger-1",
    },
    sha256: identity.contentSha256,
    byteLength: 10,
    detectedMimeType: "text/plain",
    observedAt: "2026-07-15T19:00:00.000Z",
  });
  await repository.recordDerivativeSource({
    workspaceId: workspace,
    derivativeId,
    attachmentId,
    sourceJobId: "attachment-source-job-1",
  });
  return { attachmentId, derivativeId, outputContentHash };
}

beforeEach(async () => {
  await resetDatabase();
  await seedTrigger();
});

afterAll(async () => {
  await pool.end();
});

describe("PostgreSQL versioned analysis trigger request store", () => {
  it("pins active trigger configuration, deduplicates ingress, and fences immutable snapshot capture", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    const store = new PostgresAnalysisTriggerRequestStore(
      persistence.unitOfWork as PostgresTransactionLookup,
    );

    try {
      const created = await persistence.unitOfWork.transaction((transaction) =>
        store.createOrFind(
          transaction,
          createInput("trigger-request-1", {
            expectedTriggerVersionId: analysisTriggerVersionId(triggerVersion),
          }),
        ),
      );
      const replayed = await persistence.unitOfWork.transaction((transaction) =>
        store.createOrFind(
          transaction,
          createInput("trigger-request-different", {
            expectedTriggerVersionId: analysisTriggerVersionId(triggerVersion),
          }),
        ),
      );
      expect(created).toMatchObject({
        kind: "created",
        request: {
          id: "trigger-request-1",
          triggerId: trigger,
          triggerVersionId: triggerVersion,
          analysisProfileVersionId: profileVersion,
          connectorRegistrationId: connector,
          connectorConfigurationVersionId: configurationVersion,
        },
      });
      expect(replayed).toEqual({ kind: "replayed", request: created.request });
      const command = triggerCommand(created.request);
      const claim = await persistence.unitOfWork.transaction((transaction) =>
        store.claimCapture(transaction, { command, leaseMs: 10_000 }),
      );
      expect(claim.kind).toBe("claimed");
      if (claim.kind !== "claimed") throw new Error("Expected capture claim.");

      const caseSnapshot = await persistence.unitOfWork.transaction(
        (transaction) =>
          store.persistCapture(transaction, {
            claim: claim.claim,
            snapshot: snapshot(),
          }),
      );
      expect(caseSnapshot).toMatch(/^case-snapshot:/u);
      const repeatedClaim = await persistence.unitOfWork.transaction(
        (transaction) =>
          store.claimCapture(transaction, { command, leaseMs: 10_000 }),
      );
      expect(repeatedClaim).toEqual({
        kind: "captured",
        caseSnapshotId: caseSnapshot,
        request: created.request,
      });

      const stored = await pool.query<{
        state: string;
        analysis_profile_version_id: string;
        connector_configuration_version_id: string;
        snapshot: { messages: readonly { content: string }[] };
      }>(
        `SELECT request.state, request.analysis_profile_version_id,
                request.connector_configuration_version_id, snapshot.snapshot
         FROM analysis_trigger_requests AS request
         JOIN case_snapshots AS snapshot
           ON snapshot.workspace_id = request.workspace_id
          AND snapshot.id = request.case_snapshot_id
         WHERE request.workspace_id = $1 AND request.id = $2`,
        [workspace, "trigger-request-1"],
      );
      expect(stored.rows).toEqual([
        {
          state: "captured",
          analysis_profile_version_id: profileVersion,
          connector_configuration_version_id: configurationVersion,
          snapshot: expect.objectContaining({
            messages: [
              expect.objectContaining({ content: "Normalized case body" }),
            ],
          }),
        },
      ]);
    } finally {
      await persistence.close();
    }
  });

  it("appends only verified attachment derivatives in the new snapshot transaction", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    const store = new PostgresAnalysisTriggerRequestStore(
      persistence.unitOfWork as PostgresTransactionLookup,
    );
    try {
      const evidence = await seedVerifiedAttachmentEvidence();
      const created = await persistence.unitOfWork.transaction((transaction) =>
        store.createOrFind(
          transaction,
          createInput("trigger-request-evidence"),
        ),
      );
      const command = triggerCommand(created.request);
      const claim = await persistence.unitOfWork.transaction((transaction) =>
        store.claimCapture(transaction, { command, leaseMs: 10_000 }),
      );
      if (claim.kind !== "claimed") throw new Error("Expected capture claim.");
      const caseSnapshot = await persistence.unitOfWork.transaction(
        (transaction) =>
          store.persistCapture(transaction, {
            claim: claim.claim,
            snapshot: {
              ...snapshot(),
              attachmentReferences: [
                {
                  connectorRegistrationId: connector,
                  resourceType: "attachment",
                  externalId: "attachment-external-1",
                },
              ],
            },
          }),
      );

      await expect(
        pool.query(
          `SELECT attachment_id, attachment_derivative_id, output_content_hash
           FROM case_snapshot_attachment_references
           WHERE workspace_id = $1 AND case_snapshot_id = $2`,
          [workspace, caseSnapshot],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            attachment_id: evidence.attachmentId,
            attachment_derivative_id: evidence.derivativeId,
            output_content_hash: evidence.outputContentHash,
          },
        ],
      });
      await expect(
        pool.query(
          `UPDATE case_snapshot_attachment_references
           SET output_content_hash = repeat('0', 64)
           WHERE workspace_id = $1 AND case_snapshot_id = $2`,
          [workspace, caseSnapshot],
        ),
      ).rejects.toThrow(/append-only/u);
    } finally {
      await persistence.close();
    }
  });

  it("rejects a scheduled immutable revision that is no longer the active trigger revision", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    const store = new PostgresAnalysisTriggerRequestStore(
      persistence.unitOfWork as PostgresTransactionLookup,
    );

    try {
      await expect(
        persistence.unitOfWork.transaction((transaction) =>
          store.createOrFind(
            transaction,
            createInput("trigger-request-unavailable", {
              idempotencyKeyDigest: thirdDigest,
              expectedTriggerVersionId: analysisTriggerVersionId(
                "analysis-trigger-version-unavailable",
              ),
            }),
          ),
        ),
      ).rejects.toMatchObject({
        code: "analysis.trigger.configurationUnavailable",
        retryable: false,
      });
      await expect(
        pool.query(
          `SELECT id
           FROM analysis_trigger_requests
           WHERE workspace_id = $1 AND id = 'trigger-request-unavailable'`,
          [workspace],
        ),
      ).resolves.toMatchObject({ rows: [] });
    } finally {
      await persistence.close();
    }
  });

  it("derives one PBI-011 request from retained inputs and appends its immutable job link", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    const store = new PostgresAnalysisTriggerRequestStore(
      persistence.unitOfWork as PostgresTransactionLookup,
    );

    try {
      const created = await persistence.unitOfWork.transaction((transaction) =>
        store.createOrFind(
          transaction,
          createInput("trigger-request-submit", {
            idempotencyKeyDigest: thirdDigest,
            requestDigest: thirdDigest,
            expectedTriggerVersionId: analysisTriggerVersionId(triggerVersion),
          }),
        ),
      );
      const command = triggerCommand(created.request);
      const claim = await persistence.unitOfWork.transaction((transaction) =>
        store.claimCapture(transaction, { command, leaseMs: 10_000 }),
      );
      if (claim.kind !== "claimed") throw new Error("Expected capture claim.");
      await persistence.unitOfWork.transaction((transaction) =>
        store.persistCapture(transaction, {
          claim: claim.claim,
          snapshot: snapshot(),
        }),
      );

      const prepared = await persistence.unitOfWork.transaction((transaction) =>
        store.prepareAnalysisSubmission(transaction, { command }),
      );
      expect(prepared).toMatchObject({
        kind: "ready",
        submission: {
          request: {
            id: "trigger-request-submit",
            actorPrincipalId: actor,
            analysisProfileVersionId: profileVersion,
          },
          command: {
            analysisProfileVersionId: profileVersion,
            caseSnapshotId: expect.stringMatching(/^case-snapshot:/u),
          },
        },
      });
      if (prepared.kind !== "ready")
        throw new Error("Expected ready submission.");

      const job = analysisJobId("analysis-job-trigger-1");
      await pool.query(
        `INSERT INTO analysis_identities (
           id, workspace_id, identity_hash, analysis_profile_version_id, case_snapshot_id
         ) VALUES ($1, $2, $3, $4, $5)`,
        [
          "analysis-identity-trigger-1",
          workspace,
          prepared.submission.command.identityHash,
          profileVersion,
          prepared.submission.command.caseSnapshotId,
        ],
      );
      await pool.query(
        `INSERT INTO analysis_jobs (
           id, workspace_id, analysis_identity_id, run_ordinal, state
         ) VALUES ($1, $2, $3, 0, 'queued')`,
        [job, workspace, "analysis-identity-trigger-1"],
      );
      await persistence.unitOfWork.transaction((transaction) =>
        store.bindAnalysisJob(transaction, {
          workspaceId: workspaceId(workspace),
          triggerRequestId: created.request.id,
          analysisJobId: job,
          occurredAt: clock.now(),
        }),
      );
      await expect(
        persistence.unitOfWork.transaction((transaction) =>
          store.prepareAnalysisSubmission(transaction, { command }),
        ),
      ).resolves.toEqual({ kind: "submitted", analysisJobId: job });
      await expect(
        pool.query(
          `UPDATE analysis_trigger_request_analyses
           SET analysis_job_id = 'another-job'
           WHERE workspace_id = $1 AND analysis_trigger_request_id = $2`,
          [workspace, created.request.id],
        ),
      ).rejects.toThrow("append-only");
    } finally {
      await persistence.close();
    }
  });

  it("atomically captures, submits, audits, and retries one durable analysis request", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    const store = new PostgresAnalysisTriggerRequestStore(
      persistence.unitOfWork as PostgresTransactionLookup,
    );
    let captureCalls = 0;
    const capture = {
      capture: async () => {
        captureCalls += 1;
        return snapshot();
      },
    };

    try {
      const created = await persistence.unitOfWork.transaction((transaction) =>
        store.createOrFind(
          transaction,
          createInput("trigger-request-atomic-submit", {
            idempotencyKeyDigest: thirdDigest,
            requestDigest: thirdDigest,
            expectedTriggerVersionId: analysisTriggerVersionId(triggerVersion),
          }),
        ),
      );
      const command = triggerCommand(created.request);
      const submit = new SubmitCapturedAnalysisTrigger(
        persistence.unitOfWork,
        store,
        {
          store: persistence.analysisRequestStore,
          outbox: persistence.outboxStore,
          audit: persistence.auditStore,
          ids: submissionIds(),
          clock,
        },
      );
      const workflow = new CaptureAndSubmitAnalysisTrigger(
        new CaptureAnalysisTriggerCase(
          persistence.unitOfWork,
          store,
          capture,
          clock,
        ),
        submit,
      );

      const first = await workflow.execute(
        command,
        new AbortController().signal,
      );
      expect(first).toMatchObject({ replayed: false });
      expect(first).toHaveProperty("analysisJobId");

      const committed = await pool.query<{
        readonly analysis_jobs: string;
        readonly analysis_execute_commands: string;
        readonly analysis_request_audits: string;
        readonly analysis_request_idempotency: string;
        readonly trigger_job_links: string;
        readonly actor_principal_id: string;
      }>(
        `SELECT
           (SELECT count(*) FROM analysis_jobs WHERE workspace_id = $1) AS analysis_jobs,
           (SELECT count(*) FROM outbox_envelopes
             WHERE workspace_id = $1 AND type = 'analysis.execute.v1') AS analysis_execute_commands,
           (SELECT count(*) FROM audit_events
             WHERE workspace_id = $1 AND action = 'analysis.requested') AS analysis_request_audits,
           (SELECT count(*) FROM idempotency_records
             WHERE workspace_id = $1 AND operation = 'analysis.request') AS analysis_request_idempotency,
           (SELECT count(*) FROM analysis_trigger_request_analyses
             WHERE workspace_id = $1 AND analysis_trigger_request_id = $2) AS trigger_job_links,
           (SELECT actor_principal_id FROM audit_events
             WHERE workspace_id = $1 AND action = 'analysis.requested') AS actor_principal_id`,
        [workspace, created.request.id],
      );
      expect(committed.rows).toEqual([
        {
          analysis_jobs: "1",
          analysis_execute_commands: "1",
          analysis_request_audits: "1",
          analysis_request_idempotency: "1",
          trigger_job_links: "1",
          actor_principal_id: actor,
        },
      ]);

      await expect(
        workflow.execute(command, new AbortController().signal),
      ).resolves.toMatchObject({ kind: "submitted" });
      expect(captureCalls).toBe(1);
      await expect(
        pool.query(
          `SELECT count(*)::text AS count
           FROM outbox_envelopes
           WHERE workspace_id = $1 AND type = 'analysis.execute.v1'`,
          [workspace],
        ),
      ).resolves.toMatchObject({ rows: [{ count: "1" }] });
    } finally {
      await persistence.close();
    }
  });

  it("rolls back the PBI-011 job, outbox, audit, and idempotency record when binding fails", async () => {
    const persistence = createPostgresPersistence({ databaseUrl });
    const store = new PostgresAnalysisTriggerRequestStore(
      persistence.unitOfWork as PostgresTransactionLookup,
    );

    try {
      const created = await persistence.unitOfWork.transaction((transaction) =>
        store.createOrFind(
          transaction,
          createInput("trigger-request-bind-rollback", {
            idempotencyKeyDigest: thirdDigest,
            requestDigest: thirdDigest,
            expectedTriggerVersionId: analysisTriggerVersionId(triggerVersion),
          }),
        ),
      );
      const command = triggerCommand(created.request);
      const claim = await persistence.unitOfWork.transaction((transaction) =>
        store.claimCapture(transaction, { command, leaseMs: 10_000 }),
      );
      if (claim.kind !== "claimed") throw new Error("Expected capture claim.");
      await persistence.unitOfWork.transaction((transaction) =>
        store.persistCapture(transaction, {
          claim: claim.claim,
          snapshot: snapshot(),
        }),
      );

      const failingStore = {
        prepareAnalysisSubmission: store.prepareAnalysisSubmission.bind(store),
        bindAnalysisJob: async () => {
          throw new Error("Injected immutable-link failure.");
        },
      } as never;
      const submit = new SubmitCapturedAnalysisTrigger(
        persistence.unitOfWork,
        failingStore,
        {
          store: persistence.analysisRequestStore,
          outbox: persistence.outboxStore,
          audit: persistence.auditStore,
          ids: submissionIds(),
          clock,
        },
      );

      await expect(
        submit.execute(command, new AbortController().signal),
      ).rejects.toThrow("Injected immutable-link failure.");
      await expect(
        pool.query(
          `SELECT
             (SELECT count(*)::text FROM analysis_jobs WHERE workspace_id = $1) AS analysis_jobs,
             (SELECT count(*)::text FROM outbox_envelopes
               WHERE workspace_id = $1 AND type = 'analysis.execute.v1') AS analysis_execute_commands,
             (SELECT count(*)::text FROM audit_events
               WHERE workspace_id = $1 AND action = 'analysis.requested') AS analysis_request_audits,
             (SELECT count(*)::text FROM idempotency_records
               WHERE workspace_id = $1 AND operation = 'analysis.request') AS analysis_request_idempotency,
             (SELECT count(*)::text FROM analysis_trigger_request_analyses
               WHERE workspace_id = $1 AND analysis_trigger_request_id = $2) AS trigger_job_links`,
          [workspace, created.request.id],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            analysis_jobs: "0",
            analysis_execute_commands: "0",
            analysis_request_audits: "0",
            analysis_request_idempotency: "0",
            trigger_job_links: "0",
          },
        ],
      });
    } finally {
      await persistence.close();
    }
  });

  it("rejects inconsistent pins and prevents disabling a connector used by an active trigger", async () => {
    await expect(
      pool.query(
        `INSERT INTO analysis_trigger_requests (
           id, workspace_id, analysis_trigger_version_id,
           analysis_profile_version_id, connector_registration_id,
           connector_configuration_version_id, source,
           target_connector_instance_id, target_resource_type, target_external_id,
           idempotency_key_digest, request_digest, state
         ) VALUES (
           'invalid-request', $1, $2, $3, $4, 'not-the-pinned-version', 'manual',
           $4, 'case', 'case-1', repeat('a', 64), repeat('b', 64), 'pending'
         )`,
        [workspace, triggerVersion, profileVersion, connector],
      ),
    ).rejects.toThrow(
      "Analysis trigger request configuration pins are invalid",
    );
    await expect(
      pool.query(
        `UPDATE connector_registrations
         SET lifecycle = 'disabled'
         WHERE workspace_id = $1 AND id = $2`,
        [workspace, connector],
      ),
    ).rejects.toThrow("active analysis triggers");
  });
});
