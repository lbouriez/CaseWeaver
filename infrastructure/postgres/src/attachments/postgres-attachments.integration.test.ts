import { createHash } from "node:crypto";

import { createAttachmentPreparationResult } from "@caseweaver/attachments";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  type AttachmentDerivativeIdentity,
  type PersistedAttachmentDerivative,
  PostgresAttachmentClaimOwnershipError,
  PostgresAttachmentOccurrencePreparationStore,
  PostgresAttachmentPreparationAttemptStore,
  PostgresAttachmentPreparationClaimOwnershipError,
  PostgresAttachmentRepository,
  PostgresAttachmentTerminalFailureError,
} from "./index.js";

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
const repository = new PostgresAttachmentRepository(pool, 60_000);
const preparation = new PostgresAttachmentOccurrencePreparationStore(
  pool,
  60_000,
);
const stablePreparation = new PostgresAttachmentPreparationAttemptStore(pool);

function identity(
  input: {
    readonly workspaceId?: string;
    readonly accessPolicyHash?: string;
    readonly processor?: string;
  } = {},
): AttachmentDerivativeIdentity {
  const value = {
    workspaceId: input.workspaceId ?? "attachment-workspace-a",
    accessPolicyHash: input.accessPolicyHash ?? "access-policy-a",
    contentSha256: "a".repeat(64),
    processor: input.processor ?? "vision",
    processorVersion: "processor.v1",
    securityPolicyVersion: "security.v1",
    normalizationVersion: "normalization.v1",
    visionPromptVersion: "prompt.v1",
    visionBindingVersionId: "vision-binding.v1",
  };
  return Object.freeze({
    ...value,
    key: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  });
}

function derivative(
  value: AttachmentDerivativeIdentity,
  outputKey = `derivative-output:${value.key}`,
  operationId?: string,
): PersistedAttachmentDerivative {
  return Object.freeze({
    id: `attachment-derivative:${value.key}`,
    identity: value,
    status: "completed",
    output: {
      workspaceId: value.workspaceId,
      storageBackendId: "storage-test",
      key: outputKey,
    },
    mimeType: "text/plain",
    outputContentHash: "b".repeat(64),
    outputByteLength: 42,
    ...(operationId === undefined ? {} : { operationId }),
  });
}

async function resetAttachments(): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      knowledge_revision_attachment_preparation_attempts,
      case_snapshot_attachment_preparation_attempts,
      attachment_preparation_attempt_evidence,
      attachment_preparation_attempt_occurrences,
      attachment_preparation_attempts,
      analysis_execution_inputs,
      attachment_preparation_evidence,
      attachment_preparation_runs,
      attachment_occurrence_private,
      attachment_occurrences,
      attachment_derivative_failures,
      attachment_derivative_sources,
      attachment_derivatives,
      attachments,
      attachment_blobs
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`
    DELETE FROM external_references
    WHERE workspace_id LIKE 'attachment-workspace-%'
  `);
  await pool.query(`
    DELETE FROM connector_registrations
    WHERE workspace_id LIKE 'attachment-workspace-%'
  `);
}

async function seedWorkspace(
  workspaceId: string,
  sourceReferenceId = `attachment-reference:${workspaceId}`,
): Promise<string> {
  const connectorId = `attachment-connector:${workspaceId}`;
  await pool.query(
    "INSERT INTO workspaces (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
    [workspaceId],
  );
  await seedConnectorProvenance({
    workspaceId,
    connectorId,
    sourceReferenceId,
  });
  return sourceReferenceId;
}

async function seedConnectorProvenance(input: {
  readonly workspaceId: string;
  readonly connectorId: string;
  readonly sourceReferenceId: string;
}): Promise<void> {
  const configurationVersionId = `${input.connectorId}:configuration-v1`;
  await pool.query(
    `INSERT INTO connector_registrations (id, workspace_id, lifecycle)
     VALUES ($1, $2, 'active')
     ON CONFLICT (workspace_id, id) DO NOTHING`,
    [input.connectorId, input.workspaceId],
  );
  await pool.query(
    `INSERT INTO external_references (
       id, workspace_id, connector_registration_id, kind, external_id
     ) VALUES ($1, $2, $3, 'attachment', $4)
     ON CONFLICT (workspace_id, connector_registration_id, kind, external_id)
     DO NOTHING`,
    [
      input.sourceReferenceId,
      input.workspaceId,
      input.connectorId,
      input.sourceReferenceId,
    ],
  );
  await pool.query(
    `INSERT INTO administration_configurations (
       id, workspace_id, resource_type, lifecycle
     ) VALUES ($1, $2, 'connector-instances', 'active')
     ON CONFLICT (workspace_id, id) DO NOTHING`,
    [input.connectorId, input.workspaceId],
  );
  await pool.query(
    `INSERT INTO administration_descriptor_revisions (
       kind, type, version, descriptor, descriptor_hash
     ) VALUES ('connector', 'attachment-preparation-test', 'v1', '{}'::jsonb, $1)
     ON CONFLICT (kind, type, version) DO NOTHING`,
    ["e".repeat(64)],
  );
  await pool.query(
    `INSERT INTO administration_configuration_versions (
       id, workspace_id, configuration_id, version, settings,
       secret_references, descriptor_kind, descriptor_type, descriptor_version
     ) VALUES (
       $1, $2, $3, 1, '{}'::jsonb, '[]'::jsonb,
       'connector', 'attachment-preparation-test', 'v1'
     ) ON CONFLICT (workspace_id, id) DO NOTHING`,
    [configurationVersionId, input.workspaceId, input.connectorId],
  );
  await pool.query(
    `UPDATE administration_configurations
     SET current_version_id = $1
     WHERE workspace_id = $2 AND id = $3`,
    [configurationVersionId, input.workspaceId, input.connectorId],
  );
}

async function recordOccurrence(input: {
  readonly workspaceId: string;
  readonly sourceReferenceId: string;
  readonly id: string;
  readonly ownerId: string;
  readonly required: boolean;
  readonly contentHash?: string;
  readonly connectorRegistrationId?: string;
  readonly connectorConfigurationVersionId?: string;
}): Promise<void> {
  const connectorRegistrationId =
    input.connectorRegistrationId ??
    `attachment-connector:${input.workspaceId}`;
  await preparation.recordOccurrence({
    id: input.id,
    workspaceId: input.workspaceId,
    ownerKind: "caseSnapshot",
    ownerId: input.ownerId,
    connectorRegistrationId,
    connectorConfigurationVersionId:
      input.connectorConfigurationVersionId ??
      `${connectorRegistrationId}:configuration-v1`,
    relation: "inlineImage",
    ordinal: 0,
    attachmentReferenceId: input.sourceReferenceId,
    declared: {
      mediaType: "image/png",
      contentLength: 42,
      contentHash: input.contentHash ?? "a".repeat(64),
    },
    identityHash: "d".repeat(64),
    required: input.required,
    privateLocator: {
      ciphertext: "sealed-attachment-locator",
      cipherVersion: "test-v1",
    },
  });
}

beforeEach(async () => resetAttachments());
afterAll(async () => {
  await resetAttachments();
  await pool.end();
});

describe("PostgreSQL attachment persistence", () => {
  it("reserves a stable attachment before intake and upgrades it exactly once after streaming", async () => {
    const workspaceId = "attachment-workspace-live-reservation";
    await seedWorkspace(workspaceId);
    const reference = {
      connectorInstanceId: `attachment-connector:${workspaceId}`,
      resourceType: "case",
      externalId: "case-42:attachment-0",
    } as const;
    const attachmentId = "attachment-live-reservation";

    await repository.reserveAttachment({
      id: attachmentId,
      workspaceId,
      reference,
      observedAt: "2026-07-17T12:00:00.000Z",
    });
    await expect(
      pool.query(
        `SELECT lifecycle, blob_id, content_hash
         FROM attachments
         WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, attachmentId],
      ),
    ).resolves.toMatchObject({
      rows: [{ lifecycle: "discovered", blob_id: null, content_hash: null }],
    });

    const accepted = {
      workspaceId,
      sourceReference: reference,
      blob: {
        workspaceId,
        storageBackendId: "storage-test",
        key: "source-blob:live-reservation",
      },
      byteLength: 42,
      sha256: "a".repeat(64),
      detectedMimeType: "text/plain",
      declaredMimeType: "text/plain",
    } as const;
    await expect(
      repository.recordReservedAttachment({
        attachmentId,
        attachment: accepted,
        observedAt: "2026-07-17T12:00:01.000Z",
      }),
    ).resolves.toMatchObject({
      id: attachmentId,
      workspaceId,
      sha256: accepted.sha256,
      storage: accepted.blob,
    });
    await expect(
      repository.recordReservedAttachment({
        attachmentId,
        attachment: accepted,
        observedAt: "2026-07-17T12:00:02.000Z",
      }),
    ).resolves.toMatchObject({ id: attachmentId });
    await expect(
      repository.recordReservedAttachment({
        attachmentId,
        attachment: { ...accepted, sha256: "c".repeat(64) },
        observedAt: "2026-07-17T12:00:03.000Z",
      }),
    ).rejects.toThrow(/conflicts/u);
  });

  it("persists two stable occurrences of one derivative and rejects late evidence", async () => {
    const workspaceId = "attachment-workspace-stable-attempt";
    const sourceReferenceId = await seedWorkspace(workspaceId);
    const value = identity({ workspaceId, processor: "vision" });
    const derivativeValue = derivative(value);
    const derivativeClaim = await repository.claimDerivative(value);
    expect(derivativeClaim.kind).toBe("claimed");
    if (derivativeClaim.kind !== "claimed") {
      throw new Error("Expected an attachment derivative claim.");
    }
    await repository.completeDerivative({
      claimId: derivativeClaim.claimId,
      derivative: derivativeValue,
    });
    await repository.recordAttachment({
      id: "stable-attachment-a",
      workspaceId,
      sourceReferenceId,
      storage: {
        workspaceId,
        storageBackendId: "storage-test",
        key: "source-blob:stable-a",
      },
      sha256: value.contentSha256,
      byteLength: 42,
      detectedMimeType: "image/png",
      observedAt: "2026-07-17T12:00:00.000Z",
    });
    await repository.recordDerivativeSource({
      workspaceId,
      derivativeId: derivativeValue.id,
      attachmentId: "stable-attachment-a",
      sourceJobId: "stable-source-job-a",
    });

    const policy = {
      mode: "optional" as const,
      policyVersion: "stable-policy-v1",
      accessPolicyHash: "c".repeat(64),
    };
    const occurrences = [
      {
        identity: "stable-occurrence-a",
        ownerIdentity: "stable-owner-case",
        sourceOrdinal: 0,
        ordinal: 0,
        attachmentId: "stable-attachment-a",
        relation: "description-image",
        required: false,
      },
      {
        identity: "stable-occurrence-b",
        ownerIdentity: "stable-owner-comment",
        sourceOrdinal: 0,
        ordinal: 1,
        attachmentId: "stable-attachment-a",
        relation: "comment-image",
        required: false,
      },
    ] as const;
    const planIdentity = createHash("sha256")
      .update("stable-attempt-plan", "utf8")
      .digest("hex");
    const claim = await stablePreparation.claim({
      subject: { workspaceId, kind: "caseCapture", id: "stable-capture-a" },
      policy,
      planIdentity,
      occurrences,
      signal: new AbortController().signal,
    });
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") {
      throw new Error("Expected a stable preparation claim.");
    }
    const preparationResult = createAttachmentPreparationResult({
      policy,
      derivatives: occurrences.map((occurrence) => ({
        occurrenceIdentity: occurrence.identity,
        derivativeIdentity: derivativeValue.identity.key,
        derivativeContentHash: derivativeValue.outputContentHash,
        searchableText: "private derivative output",
      })),
    });
    await stablePreparation.finalize({
      attempt: claim.attempt,
      result: preparationResult,
      evidence: occurrences.map((occurrence) => ({
        occurrence,
        derivative: derivativeValue,
      })),
      signal: new AbortController().signal,
    });

    await expect(
      pool.query(
        `SELECT occurrence_identity, owner_identity, source_ordinal, derivative_id
         FROM attachment_preparation_attempt_evidence
         JOIN attachment_preparation_attempt_occurrences
           USING (workspace_id, attempt_id, occurrence_identity)
         WHERE workspace_id = $1 AND attempt_id = $2
         ORDER BY occurrence_identity`,
        [workspaceId, claim.attempt.id],
      ),
    ).resolves.toMatchObject({
      rows: [
          {
            occurrence_identity: "stable-occurrence-a",
            owner_identity: "stable-owner-case",
            source_ordinal: 0,
            derivative_id: derivativeValue.id,
          },
          {
            occurrence_identity: "stable-occurrence-b",
            owner_identity: "stable-owner-comment",
            source_ordinal: 0,
            derivative_id: derivativeValue.id,
        },
      ],
    });
    await expect(
      pool.query(
        `INSERT INTO attachment_preparation_attempt_evidence (
           workspace_id, attempt_id, occurrence_identity, outcome,
           warning_code, warning_retryable
         ) VALUES ($1, $2, 'late-occurrence', 'unavailable', 'late', false)`,
        [workspaceId, claim.attempt.id],
      ),
    ).rejects.toThrow(/claimed/u);
  });

  it("returns a completed cache hit and persists its opaque vision operation attribution", async () => {
    const sourceReferenceId = await seedWorkspace("attachment-workspace-a");
    const value = identity();
    const claim = await repository.claimDerivative(value);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("Expected derivative claim.");

    await repository.completeDerivative({
      claimId: claim.claimId,
      derivative: derivative(
        value,
        "derivative-output:vision",
        "ai-operation-1",
      ),
    });
    await repository.recordAttachment({
      id: "attachment-a",
      workspaceId: value.workspaceId,
      sourceReferenceId,
      storage: {
        workspaceId: value.workspaceId,
        storageBackendId: "storage-test",
        key: "source-blob:a",
      },
      sha256: value.contentSha256,
      byteLength: 42,
      declaredMimeType: "image/png",
      detectedMimeType: "image/png",
      sanitizedFilename: "screenshot.png",
      observedAt: "2026-07-13T23:00:00.000Z",
    });
    await repository.recordDerivativeSource({
      workspaceId: value.workspaceId,
      derivativeId: `attachment-derivative:${value.key}`,
      attachmentId: "attachment-a",
      sourceJobId: "analysis-job-1",
    });

    await expect(repository.claimDerivative(value)).resolves.toEqual({
      kind: "completed",
      derivative: derivative(
        value,
        "derivative-output:vision",
        "ai-operation-1",
      ),
    });
    await expect(
      repository.listDerivativeSources({
        workspaceId: value.workspaceId,
        derivativeId: `attachment-derivative:${value.key}`,
      }),
    ).resolves.toEqual([
      {
        attachmentId: "attachment-a",
        sourceReferenceId,
        sourceJobId: "analysis-job-1",
        operationId: "ai-operation-1",
      },
    ]);
    await expect(
      repository.findDerivativeEvidenceRecord({
        workspaceId: value.workspaceId,
        attachmentId: "attachment-a",
        derivativeId: `attachment-derivative:${value.key}`,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      workspaceId: value.workspaceId,
      attachmentId: "attachment-a",
      derivativeId: `attachment-derivative:${value.key}`,
      output: {
        workspaceId: value.workspaceId,
        storageBackendId: "storage-test",
        key: "derivative-output:vision",
      },
      outputContentHash: "b".repeat(64),
      outputByteLength: 42,
    });
    await expect(
      repository.findDerivativeEvidenceRecord({
        workspaceId: "attachment-workspace-b",
        attachmentId: "attachment-a",
        derivativeId: `attachment-derivative:${value.key}`,
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();
  });

  it("allows one concurrent claim, retries only retryable terminal failures, and enforces ownership", async () => {
    await seedWorkspace("attachment-workspace-a");
    const value = identity();
    const claims = await Promise.all([
      repository.claimDerivative(value),
      repository.claimDerivative(value),
    ]);
    const claimed = claims.find(
      (claim): claim is Extract<typeof claim, { readonly kind: "claimed" }> =>
        claim.kind === "claimed",
    );
    expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === "inProgress")).toHaveLength(
      1,
    );
    if (claimed === undefined) throw new Error("Expected an owned claim.");

    await repository.failDerivative({
      claimId: claimed.claimId,
      code: "attachment.runtimeTimeout",
      retryable: true,
    });
    await expect(repository.findFailure(value)).resolves.toMatchObject({
      code: "attachment.runtimeTimeout",
      retryable: true,
    });

    const retried = await repository.claimDerivative(value);
    expect(retried.kind).toBe("claimed");
    if (retried.kind !== "claimed") throw new Error("Expected retry claim.");
    await expect(
      repository.completeDerivative({
        claimId: "another-claimant",
        derivative: derivative(value),
      }),
    ).rejects.toBeInstanceOf(PostgresAttachmentClaimOwnershipError);
    await repository.failDerivative({
      claimId: retried.claimId,
      code: "attachment.invalidText",
      retryable: false,
    });
    await expect(repository.claimDerivative(value)).rejects.toBeInstanceOf(
      PostgresAttachmentTerminalFailureError,
    );
  });

  it("separates cache claims by workspace and access policy", async () => {
    await seedWorkspace("attachment-workspace-a");
    await seedWorkspace("attachment-workspace-b");
    const original = identity();
    const otherWorkspace = identity({ workspaceId: "attachment-workspace-b" });
    const otherPolicy = identity({ accessPolicyHash: "access-policy-b" });

    for (const value of [original, otherWorkspace, otherPolicy]) {
      await expect(repository.claimDerivative(value)).resolves.toMatchObject({
        kind: "claimed",
      });
    }
    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM attachment_derivatives",
    );
    expect(count.rows).toEqual([{ count: "3" }]);
  });

  it("persists the immutable storage backend with attachment and derivative metadata", async () => {
    const sourceReferenceId = await seedWorkspace("attachment-workspace-a");
    const value = identity({ processor: "text" });
    const claim = await repository.claimDerivative(value);
    if (claim.kind !== "claimed") throw new Error("Expected derivative claim.");
    await repository.completeDerivative({
      claimId: claim.claimId,
      derivative: derivative(value, "derivative-output:retention"),
    });
    await repository.scheduleDerivativeRetention({
      workspaceId: value.workspaceId,
      derivativeId: `attachment-derivative:${value.key}`,
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    await repository.recordAttachment({
      id: "attachment-retention",
      workspaceId: value.workspaceId,
      sourceReferenceId,
      storage: {
        workspaceId: value.workspaceId,
        storageBackendId: "storage-test",
        key: "source-blob:retention",
      },
      sha256: value.contentSha256,
      byteLength: 7,
      detectedMimeType: "text/plain",
      sanitizedFilename: "diagnostic.txt",
      observedAt: "2026-07-13T23:00:00.000Z",
      retentionExpiresAt: "2020-01-01T00:00:00.000Z",
    });

    const retained = await pool.query<{
      derivative_backend: string | null;
      reference_backend: string | null;
      blob_backend: string | null;
      derivative_expiry: Date | null;
      blob_expiry: Date | null;
    }>(
      `SELECT
         derivative.output_storage_backend_id AS derivative_backend,
         (SELECT blob.storage_backend_id
          FROM attachment_blobs AS blob
          WHERE blob.workspace_id = attachment.workspace_id
            AND blob.id = attachment.blob_id) AS reference_backend,
         blob.storage_backend_id AS blob_backend,
         derivative.retention_expires_at AS derivative_expiry,
         blob.retention_expires_at AS blob_expiry
       FROM attachment_derivatives AS derivative
       JOIN attachments AS attachment ON attachment.workspace_id = derivative.workspace_id
       JOIN attachment_blobs AS blob
         ON blob.workspace_id = attachment.workspace_id
        AND blob.id = attachment.blob_id`,
    );
    expect(retained.rows).toEqual([
      {
        derivative_backend: "storage-test",
        reference_backend: "storage-test",
        blob_backend: "storage-test",
        derivative_expiry: new Date("2020-01-01T00:00:00.000Z"),
        blob_expiry: new Date("2020-01-01T00:00:00.000Z"),
      },
    ]);
  });

  it("keeps occurrence locators server-private and prevents immutable occurrence changes", async () => {
    const workspaceId = "attachment-workspace-a";
    const sourceReferenceId = await seedWorkspace(workspaceId);
    await recordOccurrence({
      workspaceId,
      sourceReferenceId,
      id: "attachment-occurrence-private",
      ownerId: "snapshot-private",
      required: false,
    });

    const [occurrence] = await preparation.listOccurrences({
      workspaceId,
      ownerKind: "caseSnapshot",
      ownerId: "snapshot-private",
    });
    expect(occurrence).toMatchObject({
      id: "attachment-occurrence-private",
      declared: { mediaType: "image/png", contentLength: 42 },
    });
    expect(JSON.stringify(occurrence)).not.toContain(
      "sealed-attachment-locator",
    );
    await expect(
      preparation.readPrivateOccurrenceLocator({
        workspaceId,
        occurrenceId: "attachment-occurrence-private",
      }),
    ).resolves.toEqual({
      ciphertext: "sealed-attachment-locator",
      cipherVersion: "test-v1",
    });
    await expect(
      preparation.readPrivateOccurrenceLocator({
        workspaceId: "attachment-workspace-b",
        occurrenceId: "attachment-occurrence-private",
      }),
    ).resolves.toBeUndefined();
    await expect(
      pool.query(
        `UPDATE attachment_occurrences
         SET required = true
         WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, "attachment-occurrence-private"],
      ),
    ).rejects.toThrow(/immutable/u);
  });

  it("records only exact completed derivative evidence and fences preparation completion", async () => {
    const workspaceId = "attachment-workspace-a";
    const sourceReferenceId = await seedWorkspace(workspaceId);
    const value = identity({ workspaceId });
    const derivativeClaim = await repository.claimDerivative(value);
    if (derivativeClaim.kind !== "claimed") {
      throw new Error("Expected a derivative claim.");
    }
    const persistedDerivative = derivative(
      value,
      "derivative-output:preparation",
    );
    await repository.completeDerivative({
      claimId: derivativeClaim.claimId,
      derivative: persistedDerivative,
    });
    await repository.recordAttachment({
      id: "attachment-preparation-ready",
      workspaceId,
      sourceReferenceId,
      storage: {
        workspaceId,
        storageBackendId: "storage-test",
        key: "source-blob:preparation",
      },
      sha256: value.contentSha256,
      byteLength: 42,
      detectedMimeType: "image/png",
      observedAt: "2026-07-16T00:00:00.000Z",
    });
    await repository.recordDerivativeSource({
      workspaceId,
      derivativeId: persistedDerivative.id,
      attachmentId: "attachment-preparation-ready",
      sourceJobId: "preparation-source-job",
    });
    await recordOccurrence({
      workspaceId,
      sourceReferenceId,
      id: "attachment-occurrence-ready",
      ownerId: "snapshot-ready",
      required: true,
    });

    const claimed = await preparation.claimPreparation({
      workspaceId,
      ownerKind: "caseSnapshot",
      ownerId: "snapshot-ready",
      policyIdentityHash: "e".repeat(64),
      preparationIdentityHash: "f".repeat(64),
    });
    expect(claimed.kind).toBe("claimed");
    if (claimed.kind !== "claimed")
      throw new Error("Expected preparation claim.");
    await expect(
      preparation.claimPreparation({
        workspaceId,
        ownerKind: "caseSnapshot",
        ownerId: "snapshot-ready",
        policyIdentityHash: "e".repeat(64),
        preparationIdentityHash: "f".repeat(64),
      }),
    ).resolves.toMatchObject({ kind: "inProgress" });
    await expect(
      preparation.completePreparation({
        workspaceId,
        runId: claimed.run.id,
        lease: {
          ...claimed.lease,
          fencingToken: claimed.lease.fencingToken + 1n,
        },
        evidence: [],
      }),
    ).rejects.toBeInstanceOf(PostgresAttachmentPreparationClaimOwnershipError);
    await expect(
      preparation.completePreparation({
        workspaceId,
        runId: claimed.run.id,
        lease: claimed.lease,
        evidence: [
          {
            occurrenceId: "attachment-occurrence-ready",
            outcome: "ready",
            attachmentId: "attachment-preparation-ready",
            derivativeId: persistedDerivative.id,
            processorVersion: value.processorVersion,
            outputContentHash: "a".repeat(64),
          },
        ],
      }),
    ).rejects.toThrow(/not exact/u);

    await expect(
      preparation.completePreparation({
        workspaceId,
        runId: claimed.run.id,
        lease: claimed.lease,
        evidence: [
          {
            occurrenceId: "attachment-occurrence-ready",
            outcome: "ready",
            attachmentId: "attachment-preparation-ready",
            derivativeId: persistedDerivative.id,
            processorVersion: value.processorVersion,
            outputContentHash: persistedDerivative.outputContentHash,
          },
        ],
      }),
    ).resolves.toMatchObject({
      run: { state: "completed", retryRequired: false },
      evidence: [
        {
          occurrenceId: "attachment-occurrence-ready",
          outcome: "ready",
          required: true,
          outputContentHash: "b".repeat(64),
        },
      ],
    });
    await expect(
      preparation.claimPreparation({
        workspaceId,
        ownerKind: "caseSnapshot",
        ownerId: "snapshot-ready",
        policyIdentityHash: "e".repeat(64),
        preparationIdentityHash: "f".repeat(64),
      }),
    ).resolves.toMatchObject({ kind: "terminal" });
  });

  it("finishes optional unavailable evidence but fails an attempt with required unavailable evidence", async () => {
    const workspaceId = "attachment-workspace-a";
    const sourceReferenceId = await seedWorkspace(workspaceId);
    await recordOccurrence({
      workspaceId,
      sourceReferenceId,
      id: "attachment-occurrence-optional",
      ownerId: "snapshot-optional",
      required: false,
    });
    const optional = await preparation.claimPreparation({
      workspaceId,
      ownerKind: "caseSnapshot",
      ownerId: "snapshot-optional",
      policyIdentityHash: "1".repeat(64),
      preparationIdentityHash: "2".repeat(64),
    });
    if (optional.kind !== "claimed")
      throw new Error("Expected optional claim.");
    await expect(
      preparation.completePreparation({
        workspaceId,
        runId: optional.run.id,
        lease: optional.lease,
        evidence: [
          {
            occurrenceId: "attachment-occurrence-optional",
            outcome: "failed",
            warningCode: "attachment.fetch-unavailable",
            retryable: true,
          },
        ],
      }),
    ).resolves.toMatchObject({
      run: { state: "completed", retryRequired: true },
      evidence: [{ outcome: "failed", required: false, retryable: true }],
    });

    await recordOccurrence({
      workspaceId,
      sourceReferenceId,
      id: "attachment-occurrence-required",
      ownerId: "snapshot-required",
      required: true,
    });
    const required = await preparation.claimPreparation({
      workspaceId,
      ownerKind: "caseSnapshot",
      ownerId: "snapshot-required",
      policyIdentityHash: "3".repeat(64),
      preparationIdentityHash: "4".repeat(64),
    });
    if (required.kind !== "claimed")
      throw new Error("Expected required claim.");
    await expect(
      preparation.completePreparation({
        workspaceId,
        runId: required.run.id,
        lease: required.lease,
        evidence: [
          {
            occurrenceId: "attachment-occurrence-required",
            outcome: "skipped",
            warningCode: "attachment.fetch-unavailable",
            retryable: false,
          },
        ],
      }),
    ).resolves.toMatchObject({
      run: { state: "failed", retryRequired: false },
      evidence: [{ outcome: "skipped", required: true, retryable: false }],
    });
  });

  it("returns in-progress to the loser of a fresh concurrent preparation claim", async () => {
    const workspaceId = "attachment-workspace-a";
    await seedWorkspace(workspaceId);
    const request = {
      workspaceId,
      ownerKind: "caseSnapshot" as const,
      ownerId: "snapshot-claim-race",
      policyIdentityHash: "5".repeat(64),
      preparationIdentityHash: "6".repeat(64),
    };

    const claims = await Promise.all([
      preparation.claimPreparation(request),
      preparation.claimPreparation(request),
    ]);
    expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === "inProgress")).toHaveLength(
      1,
    );
    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM attachment_preparation_runs
       WHERE workspace_id = $1 AND owner_id = $2`,
      [workspaceId, request.ownerId],
    );
    expect(count.rows).toEqual([{ count: "1" }]);
  });

  it("rejects occurrence provenance outside its connector and immutable connector version", async () => {
    const workspaceId = "attachment-workspace-a";
    const sourceReferenceId = await seedWorkspace(workspaceId);
    const otherConnectorId = "attachment-connector-other";
    const otherReferenceId = "attachment-reference-other";
    await seedConnectorProvenance({
      workspaceId,
      connectorId: otherConnectorId,
      sourceReferenceId: otherReferenceId,
    });

    await expect(
      recordOccurrence({
        workspaceId,
        sourceReferenceId: otherReferenceId,
        id: "attachment-occurrence-wrong-reference",
        ownerId: "snapshot-provenance",
        required: false,
      }),
    ).rejects.toThrow(/provenance/u);
    await expect(
      recordOccurrence({
        workspaceId,
        sourceReferenceId,
        id: "attachment-occurrence-wrong-version",
        ownerId: "snapshot-provenance",
        required: false,
        connectorConfigurationVersionId: `${otherConnectorId}:configuration-v1`,
      }),
    ).rejects.toThrow(/provenance/u);
  });

  it("rejects a derivative whose input content is not the occurrence attachment content", async () => {
    const workspaceId = "attachment-workspace-a";
    const sourceReferenceId = await seedWorkspace(workspaceId);
    const value = identity({ workspaceId });
    const derivativeClaim = await repository.claimDerivative(value);
    if (derivativeClaim.kind !== "claimed") {
      throw new Error("Expected a derivative claim.");
    }
    const persistedDerivative = derivative(value, "derivative-output:mismatch");
    await repository.completeDerivative({
      claimId: derivativeClaim.claimId,
      derivative: persistedDerivative,
    });
    await repository.recordAttachment({
      id: "attachment-preparation-mismatch",
      workspaceId,
      sourceReferenceId,
      storage: {
        workspaceId,
        storageBackendId: "storage-test",
        key: "source-blob:mismatch",
      },
      sha256: "c".repeat(64),
      byteLength: 42,
      detectedMimeType: "image/png",
      observedAt: "2026-07-16T00:00:00.000Z",
    });
    await repository.recordDerivativeSource({
      workspaceId,
      derivativeId: persistedDerivative.id,
      attachmentId: "attachment-preparation-mismatch",
      sourceJobId: "preparation-mismatch-source-job",
    });
    await recordOccurrence({
      workspaceId,
      sourceReferenceId,
      id: "attachment-occurrence-mismatch",
      ownerId: "snapshot-mismatch",
      required: true,
      contentHash: "c".repeat(64),
    });
    const claim = await preparation.claimPreparation({
      workspaceId,
      ownerKind: "caseSnapshot",
      ownerId: "snapshot-mismatch",
      policyIdentityHash: "7".repeat(64),
      preparationIdentityHash: "8".repeat(64),
    });
    if (claim.kind !== "claimed")
      throw new Error("Expected preparation claim.");

    await expect(
      preparation.completePreparation({
        workspaceId,
        runId: claim.run.id,
        lease: claim.lease,
        evidence: [
          {
            occurrenceId: "attachment-occurrence-mismatch",
            outcome: "ready",
            attachmentId: "attachment-preparation-mismatch",
            derivativeId: persistedDerivative.id,
            processorVersion: value.processorVersion,
            outputContentHash: persistedDerivative.outputContentHash,
          },
        ],
      }),
    ).rejects.toThrow(/not exact/u);
  });

  it("fails closed on expired leases and incoherent direct terminal evidence", async () => {
    const workspaceId = "attachment-workspace-a";
    const sourceReferenceId = await seedWorkspace(workspaceId);
    await recordOccurrence({
      workspaceId,
      sourceReferenceId,
      id: "attachment-occurrence-expired",
      ownerId: "snapshot-expired",
      required: false,
    });
    const claim = await preparation.claimPreparation({
      workspaceId,
      ownerKind: "caseSnapshot",
      ownerId: "snapshot-expired",
      policyIdentityHash: "9".repeat(64),
      preparationIdentityHash: "a".repeat(64),
    });
    if (claim.kind !== "claimed")
      throw new Error("Expected preparation claim.");
    await pool.query(
      `UPDATE attachment_preparation_runs
       SET lease_expires_at = NOW() - INTERVAL '1 millisecond'
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, claim.run.id],
    );
    await expect(
      preparation.completePreparation({
        workspaceId,
        runId: claim.run.id,
        lease: claim.lease,
        evidence: [
          {
            occurrenceId: "attachment-occurrence-expired",
            outcome: "skipped",
            warningCode: "attachment.expired",
            retryable: true,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(PostgresAttachmentPreparationClaimOwnershipError);

    await pool.query(
      `INSERT INTO attachment_preparation_runs (
         id, workspace_id, owner_kind, owner_id, policy_identity_hash,
         preparation_identity_hash, state, fencing_token, completed_at
       ) VALUES ($1, $2, 'caseSnapshot', 'snapshot-expired', $3, $4,
         'completed', 1, NOW())`,
      [
        "attachment-preparation-run-incoherent",
        workspaceId,
        "b".repeat(64),
        "c".repeat(64),
      ],
    );
    await expect(
      preparation.findPreparationOutcome({
        workspaceId,
        runId: "attachment-preparation-run-incoherent",
      }),
    ).rejects.toThrow(/evidence is incomplete/u);
  });
});
