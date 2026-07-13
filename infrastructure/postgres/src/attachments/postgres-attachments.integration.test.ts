import { createHash } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  type AttachmentDerivativeIdentity,
  type PersistedAttachmentDerivative,
  PostgresAttachmentClaimOwnershipError,
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
const repository = new PostgresAttachmentRepository(pool, 60_000, 60_000);

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
    output: { workspaceId: value.workspaceId, key: outputKey },
    mimeType: "text/plain",
    ...(operationId === undefined ? {} : { operationId }),
  });
}

async function resetAttachments(): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
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
  await pool.query(
    "DELETE FROM workspaces WHERE id LIKE 'attachment-workspace-%'",
  );
}

async function seedWorkspace(
  workspaceId: string,
  sourceReferenceId = `attachment-reference:${workspaceId}`,
): Promise<string> {
  const connectorId = `attachment-connector:${workspaceId}`;
  await pool.query("INSERT INTO workspaces (id) VALUES ($1)", [workspaceId]);
  await pool.query(
    `INSERT INTO connector_registrations (id, workspace_id, lifecycle)
     VALUES ($1, $2, 'active')`,
    [connectorId, workspaceId],
  );
  await pool.query(
    `INSERT INTO external_references (
       id, workspace_id, connector_registration_id, kind, external_id
     ) VALUES ($1, $2, $3, 'attachment', $4)`,
    [sourceReferenceId, workspaceId, connectorId, sourceReferenceId],
  );
  return sourceReferenceId;
}

beforeEach(async () => resetAttachments());
afterAll(async () => {
  await resetAttachments();
  await pool.end();
});

describe("PBI-008 PostgreSQL attachment persistence", () => {
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
      storage: { workspaceId: value.workspaceId, key: "source-blob:a" },
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

  it("claims and transitions expired derivatives, references, and blob handles without deleting storage", async () => {
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
      storage: { workspaceId: value.workspaceId, key: "source-blob:retention" },
      sha256: value.contentSha256,
      byteLength: 7,
      detectedMimeType: "text/plain",
      sanitizedFilename: "diagnostic.txt",
      observedAt: "2026-07-13T23:00:00.000Z",
      retentionExpiresAt: "2020-01-01T00:00:00.000Z",
    });

    const expiredDerivative = await repository.claimExpiredRetention({
      limit: 1,
    });
    expect(expiredDerivative).toMatchObject([
      {
        kind: "derivative",
        storage: {
          workspaceId: value.workspaceId,
          key: "derivative-output:retention",
        },
      },
    ]);
    const derivativeCandidate = expiredDerivative[0];
    if (derivativeCandidate === undefined) {
      throw new Error("Expected an expired derivative candidate.");
    }
    await repository.completeRetentionCleanup(derivativeCandidate);

    const expiredReference = await repository.claimExpiredRetention({
      limit: 1,
    });
    expect(expiredReference).toMatchObject([
      { kind: "attachmentReference", id: "attachment-retention" },
    ]);
    const referenceCandidate = expiredReference[0];
    if (referenceCandidate === undefined) {
      throw new Error("Expected an expired reference candidate.");
    }
    await repository.completeRetentionCleanup(referenceCandidate);

    const expiredBlob = await repository.claimExpiredRetention({ limit: 1 });
    expect(expiredBlob).toMatchObject([
      {
        kind: "blob",
        storage: {
          workspaceId: value.workspaceId,
          key: "source-blob:retention",
        },
      },
    ]);
    const blobCandidate = expiredBlob[0];
    if (blobCandidate === undefined) {
      throw new Error("Expected an expired blob candidate.");
    }
    await repository.completeRetentionCleanup(blobCandidate);

    const retained = await pool.query<{
      derivative_state: string;
      reference_state: string;
      blob_state: string;
      derivative_key: string | null;
      blob_key: string | null;
    }>(
      `SELECT
         derivative.retention_state AS derivative_state,
         attachment.retention_state AS reference_state,
         blob.retention_state AS blob_state,
         derivative.output_storage_key AS derivative_key,
         blob.storage_key AS blob_key
       FROM attachment_derivatives AS derivative
       JOIN attachments AS attachment ON attachment.workspace_id = derivative.workspace_id
       JOIN attachment_blobs AS blob
         ON blob.workspace_id = attachment.workspace_id
        AND blob.id = attachment.blob_id`,
    );
    expect(retained.rows).toEqual([
      {
        derivative_state: "deleted",
        reference_state: "deleted",
        blob_state: "deleted",
        derivative_key: null,
        blob_key: null,
      },
    ]);
  });
});
