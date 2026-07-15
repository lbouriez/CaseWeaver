import { createHash, randomUUID } from "node:crypto";

import { Pool, type PoolClient, type QueryResultRow } from "pg";

export interface AttachmentDerivativeIdentity {
  readonly workspaceId: string;
  readonly accessPolicyHash: string;
  readonly contentSha256: string;
  readonly processor: string;
  readonly processorVersion: string;
  readonly securityPolicyVersion: string;
  readonly normalizationVersion: string;
  readonly visionPromptVersion?: string;
  readonly visionBindingVersionId?: string;
  readonly key: string;
}

export interface AttachmentStorageHandle {
  readonly workspaceId: string;
  readonly key: string;
}

export interface PersistedAttachmentDerivative {
  readonly id: string;
  readonly identity: AttachmentDerivativeIdentity;
  readonly status: "completed";
  readonly output: AttachmentStorageHandle;
  readonly mimeType: "text/plain";
  readonly operationId?: string;
}

export type AttachmentDerivativeClaim =
  | Readonly<{
      readonly kind: "completed";
      readonly derivative: PersistedAttachmentDerivative;
    }>
  | Readonly<{ readonly kind: "claimed"; readonly claimId: string }>
  | Readonly<{ readonly kind: "inProgress" }>;

/**
 * This is structurally compatible with the narrow cache-claim portion of
 * `AttachmentRepository`. It intentionally has no package dependency so that this
 * outer adapter remains composable without exposing PostgreSQL types inward.
 */
export interface AttachmentDerivativeRepositoryPort {
  claimDerivative(
    identity: AttachmentDerivativeIdentity,
  ): Promise<AttachmentDerivativeClaim>;
  completeDerivative(input: {
    readonly claimId: string;
    readonly derivative: PersistedAttachmentDerivative;
  }): Promise<void>;
  failDerivative(input: {
    readonly claimId: string;
    readonly code: string;
    readonly retryable: boolean;
  }): Promise<void>;
}

export interface AttachmentReferenceInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceReferenceId: string;
  readonly storage: AttachmentStorageHandle;
  readonly sha256: string;
  readonly byteLength: number;
  readonly detectedMimeType: string;
  readonly declaredMimeType?: string;
  readonly sanitizedFilename?: string;
  readonly observedAt: string;
  readonly retentionExpiresAt?: string;
}

export interface PersistedAttachmentReference {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceReferenceId: string;
  readonly storage: AttachmentStorageHandle;
  readonly sha256: string;
  readonly byteLength: number;
  readonly detectedMimeType: string;
  readonly declaredMimeType?: string;
  readonly sanitizedFilename?: string;
}

export interface AttachmentDerivativeFailure {
  readonly derivativeId: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly failedAt: string;
}

export interface AttachmentDerivativeSource {
  readonly attachmentId: string;
  readonly sourceReferenceId: string;
  readonly sourceJobId: string;
  readonly operationId?: string;
}

export type RetentionCleanupCandidate =
  | Readonly<{
      readonly kind: "derivative";
      readonly id: string;
      readonly claimId: string;
      readonly storage?: AttachmentStorageHandle;
    }>
  | Readonly<{
      readonly kind: "attachmentReference";
      readonly id: string;
      readonly claimId: string;
    }>
  | Readonly<{
      readonly kind: "blob";
      readonly id: string;
      readonly claimId: string;
      readonly storage: AttachmentStorageHandle;
    }>;

export class PostgresAttachmentClaimOwnershipError extends Error {
  public readonly code = "attachment.claimOwnership";
  public readonly retryable = false;

  public constructor() {
    super("The attachment derivative claim is no longer owned by this caller.");
    this.name = "PostgresAttachmentClaimOwnershipError";
  }
}

export class PostgresAttachmentTerminalFailureError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(failure: AttachmentDerivativeFailure) {
    super(
      `Attachment derivative failed with non-retryable code "${failure.code}".`,
    );
    this.name = "PostgresAttachmentTerminalFailureError";
    this.code = failure.code;
    this.retryable = failure.retryable;
  }
}

interface DerivativeRow extends QueryResultRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly identity_key: string;
  readonly access_policy_hash: string;
  readonly content_hash: string;
  readonly processor: string;
  readonly processor_version: string;
  readonly security_policy_version: string;
  readonly normalization_version: string;
  readonly vision_prompt_version: string | null;
  readonly vision_binding_version_id: string | null;
  readonly status: "pending" | "completed" | "failed";
  readonly claim_id: string | null;
  readonly output_storage_key: string | null;
  readonly output_mime_type: string | null;
  readonly ai_operation_id: string | null;
  readonly failure_code: string | null;
  readonly failure_retryable: boolean | null;
  readonly failed_at: Date | null;
  readonly retention_state: "active" | "claimed" | "deleted";
}

interface IdRow extends QueryResultRow {
  readonly id: string;
}

interface AttachmentRow extends QueryResultRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly external_reference_id: string;
  readonly storage_key: string;
  readonly content_hash: string;
  readonly byte_length: string;
  readonly detected_mime_type: string;
  readonly declared_mime_type: string | null;
  readonly sanitized_filename: string | null;
}

interface SourceRow extends QueryResultRow {
  readonly attachment_id: string;
  readonly source_reference_id: string;
  readonly source_job_id: string;
  readonly ai_operation_id: string | null;
}

interface RetentionDerivativeRow extends QueryResultRow {
  readonly id: string;
  readonly output_storage_key: string | null;
  readonly workspace_id: string;
}

interface RetentionBlobRow extends QueryResultRow {
  readonly id: string;
  readonly storage_key: string;
  readonly workspace_id: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function derivativeId(identity: AttachmentDerivativeIdentity): string {
  return `attachment-derivative:${identity.key}`;
}

function blobId(input: AttachmentReferenceInput): string {
  return `attachment-blob:${digest(`${input.workspaceId}:${input.id}`)}`;
}

function assertOpaque(
  name: string,
  value: string,
  maximumLength = 1_024,
): void {
  if (
    value.length === 0 ||
    value.length > maximumLength ||
    value.includes("\u0000")
  ) {
    throw new RangeError(`Attachment ${name} is invalid.`);
  }
}

function assertTimestamp(name: string, value: string): void {
  if (Number.isNaN(new Date(value).valueOf())) {
    throw new RangeError(`Attachment ${name} must be an ISO timestamp.`);
  }
}

function identityKey(
  identity: Omit<AttachmentDerivativeIdentity, "key">,
): string {
  return digest(
    JSON.stringify({
      workspaceId: identity.workspaceId,
      accessPolicyHash: identity.accessPolicyHash,
      contentSha256: identity.contentSha256,
      processor: identity.processor,
      processorVersion: identity.processorVersion,
      securityPolicyVersion: identity.securityPolicyVersion,
      normalizationVersion: identity.normalizationVersion,
      visionPromptVersion: identity.visionPromptVersion,
      visionBindingVersionId: identity.visionBindingVersionId,
    }),
  );
}

function assertIdentity(
  identity: AttachmentDerivativeIdentity,
): AttachmentDerivativeIdentity {
  for (const [name, value] of [
    ["workspaceId", identity.workspaceId],
    ["accessPolicyHash", identity.accessPolicyHash],
    ["contentSha256", identity.contentSha256],
    ["processor", identity.processor],
    ["processorVersion", identity.processorVersion],
    ["securityPolicyVersion", identity.securityPolicyVersion],
    ["normalizationVersion", identity.normalizationVersion],
    ["key", identity.key],
  ] as const) {
    assertOpaque(name, value);
  }
  if (!/^[a-f0-9]{64}$/u.test(identity.contentSha256)) {
    throw new RangeError("Attachment content SHA-256 is invalid.");
  }
  if (!/^[a-f0-9]{64}$/u.test(identity.key)) {
    throw new RangeError("Attachment derivative cache key is invalid.");
  }
  if (
    (identity.visionPromptVersion === undefined) !==
    (identity.visionBindingVersionId === undefined)
  ) {
    throw new RangeError(
      "Attachment vision cache identity requires both version fields.",
    );
  }
  if (identity.visionPromptVersion !== undefined) {
    assertOpaque("visionPromptVersion", identity.visionPromptVersion);
    assertOpaque(
      "visionBindingVersionId",
      identity.visionBindingVersionId ?? "",
    );
  }
  if (identity.key !== identityKey(identity)) {
    throw new RangeError(
      "Attachment derivative cache key does not match identity.",
    );
  }
  return identity;
}

function toIdentity(row: DerivativeRow): AttachmentDerivativeIdentity {
  return Object.freeze({
    workspaceId: row.workspace_id,
    accessPolicyHash: row.access_policy_hash,
    contentSha256: row.content_hash,
    processor: row.processor,
    processorVersion: row.processor_version,
    securityPolicyVersion: row.security_policy_version,
    normalizationVersion: row.normalization_version,
    ...(row.vision_prompt_version === null
      ? {}
      : { visionPromptVersion: row.vision_prompt_version }),
    ...(row.vision_binding_version_id === null
      ? {}
      : { visionBindingVersionId: row.vision_binding_version_id }),
    key: row.identity_key,
  });
}

function toCompletedDerivative(
  row: DerivativeRow,
): PersistedAttachmentDerivative {
  if (
    row.status !== "completed" ||
    row.output_storage_key === null ||
    row.output_mime_type !== "text/plain"
  ) {
    throw new Error("Persisted attachment derivative is incomplete.");
  }
  return Object.freeze({
    id: row.id,
    identity: toIdentity(row),
    status: "completed",
    output: Object.freeze({
      workspaceId: row.workspace_id,
      key: row.output_storage_key,
    }),
    mimeType: "text/plain",
    ...(row.ai_operation_id === null
      ? {}
      : { operationId: row.ai_operation_id }),
  });
}

function toFailure(row: DerivativeRow): AttachmentDerivativeFailure {
  if (
    row.status !== "failed" ||
    row.failure_code === null ||
    row.failure_retryable === null ||
    row.failed_at === null
  ) {
    throw new Error("Persisted attachment failure is incomplete.");
  }
  return Object.freeze({
    derivativeId: row.id,
    code: row.failure_code,
    retryable: row.failure_retryable,
    failedAt: row.failed_at.toISOString(),
  });
}

function validateRetentionLimit(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new RangeError(
      "Attachment retention claim limit must be between 1 and 100.",
    );
  }
}

export class PostgresAttachmentRepository
  implements AttachmentDerivativeRepositoryPort
{
  public constructor(
    private readonly pool: Pool,
    private readonly claimLeaseMs = 15 * 60 * 1_000,
    private readonly retentionClaimLeaseMs = 5 * 60 * 1_000,
  ) {
    for (const value of [claimLeaseMs, retentionClaimLeaseMs]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(
          "Attachment claim lease duration must be positive.",
        );
      }
    }
  }

  public async recordAttachment(
    input: AttachmentReferenceInput,
  ): Promise<PersistedAttachmentReference> {
    this.assertAttachmentInput(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const id = blobId(input);
      const blob = await client.query<IdRow>(
        `INSERT INTO attachment_blobs (
           id, workspace_id, storage_key, content_hash, byte_length,
           detected_mime_type
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (workspace_id, id) DO UPDATE
           SET id = attachment_blobs.id
         WHERE attachment_blobs.retention_state = 'active'
           AND attachment_blobs.storage_key = EXCLUDED.storage_key
           AND attachment_blobs.content_hash = EXCLUDED.content_hash
           AND attachment_blobs.byte_length = EXCLUDED.byte_length
           AND attachment_blobs.detected_mime_type = EXCLUDED.detected_mime_type
         RETURNING id`,
        [
          id,
          input.workspaceId,
          input.storage.key,
          input.sha256,
          input.byteLength,
          input.detectedMimeType,
        ],
      );
      if (blob.rows[0] === undefined) {
        throw new Error(
          "Attachment blob metadata conflicts with an existing record.",
        );
      }
      const attachment = await client.query<AttachmentRow>(
        `INSERT INTO attachments (
           id, workspace_id, external_reference_id, lifecycle, content_hash,
           blob_id, byte_length, declared_mime_type, detected_mime_type,
           sanitized_filename, observed_at, retention_expires_at
         ) VALUES (
           $1, $2, $3, 'accepted', $4, $5, $6, $7, $8, $9, $10, $11
         )
         ON CONFLICT (workspace_id, id) DO UPDATE
           SET observed_at = EXCLUDED.observed_at
         WHERE attachments.external_reference_id = EXCLUDED.external_reference_id
           AND attachments.lifecycle = 'accepted'
           AND attachments.content_hash = EXCLUDED.content_hash
           AND attachments.blob_id = EXCLUDED.blob_id
           AND attachments.byte_length = EXCLUDED.byte_length
           AND attachments.declared_mime_type
             IS NOT DISTINCT FROM EXCLUDED.declared_mime_type
           AND attachments.detected_mime_type = EXCLUDED.detected_mime_type
           AND attachments.sanitized_filename
             IS NOT DISTINCT FROM EXCLUDED.sanitized_filename
           AND attachments.retention_expires_at
             IS NOT DISTINCT FROM EXCLUDED.retention_expires_at
           AND attachments.retention_state = 'active'
         RETURNING
           attachments.id,
           attachments.workspace_id,
           attachments.external_reference_id,
           (SELECT storage_key FROM attachment_blobs
            WHERE workspace_id = attachments.workspace_id
              AND id = attachments.blob_id) AS storage_key,
           attachments.content_hash,
           attachments.byte_length,
           attachments.detected_mime_type,
           attachments.declared_mime_type,
           attachments.sanitized_filename`,
        [
          input.id,
          input.workspaceId,
          input.sourceReferenceId,
          input.sha256,
          id,
          input.byteLength,
          input.declaredMimeType ?? null,
          input.detectedMimeType,
          input.sanitizedFilename ?? null,
          input.observedAt,
          input.retentionExpiresAt ?? null,
        ],
      );
      const row = attachment.rows[0];
      if (row === undefined) {
        throw new Error(
          "Attachment reference metadata conflicts with an existing record.",
        );
      }
      await client.query("COMMIT");
      return Object.freeze({
        id: row.id,
        workspaceId: row.workspace_id,
        sourceReferenceId: row.external_reference_id,
        storage: Object.freeze({
          workspaceId: row.workspace_id,
          key: row.storage_key,
        }),
        sha256: row.content_hash,
        byteLength: Number(row.byte_length),
        detectedMimeType: row.detected_mime_type,
        ...(row.declared_mime_type === null
          ? {}
          : { declaredMimeType: row.declared_mime_type }),
        ...(row.sanitized_filename === null
          ? {}
          : { sanitizedFilename: row.sanitized_filename }),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async claimDerivative(
    input: AttachmentDerivativeIdentity,
  ): Promise<AttachmentDerivativeClaim> {
    const identity = assertIdentity(input);
    const claimId = randomUUID();
    const created = await this.pool.query<DerivativeRow>(
      `INSERT INTO attachment_derivatives (
         id, workspace_id, identity_key, access_policy_hash, content_hash,
         processor, processor_version, security_policy_version,
         normalization_version, vision_prompt_version, vision_binding_version_id,
         status, claim_id, claim_expires_at, claim_attempts
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         'pending', $12, NOW() + ($13 * INTERVAL '1 millisecond'), 1
       )
       ON CONFLICT (workspace_id, identity_key) DO NOTHING
       RETURNING ${this.derivativeColumns()}`,
      [
        derivativeId(identity),
        identity.workspaceId,
        identity.key,
        identity.accessPolicyHash,
        identity.contentSha256,
        identity.processor,
        identity.processorVersion,
        identity.securityPolicyVersion,
        identity.normalizationVersion,
        identity.visionPromptVersion ?? null,
        identity.visionBindingVersionId ?? null,
        claimId,
        this.claimLeaseMs,
      ],
    );
    if (created.rows[0] !== undefined) {
      return Object.freeze({ kind: "claimed", claimId });
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<DerivativeRow>(
        `SELECT ${this.derivativeColumns()}
         FROM attachment_derivatives
         WHERE workspace_id = $1 AND identity_key = $2
         FOR UPDATE`,
        [identity.workspaceId, identity.key],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        throw new Error(
          "Attachment derivative was not found after a cache conflict.",
        );
      }
      if (row.status === "pending") {
        const recovered = await client.query<IdRow>(
          `UPDATE attachment_derivatives
           SET claim_id = $1,
               claim_expires_at = NOW() + ($2 * INTERVAL '1 millisecond'),
               claim_attempts = claim_attempts + 1
           WHERE workspace_id = $3
             AND id = $4
             AND status = 'pending'
             AND claim_expires_at <= NOW()
           RETURNING id`,
          [claimId, this.claimLeaseMs, identity.workspaceId, row.id],
        );
        await client.query("COMMIT");
        return recovered.rows[0] === undefined
          ? Object.freeze({ kind: "inProgress" })
          : Object.freeze({ kind: "claimed", claimId });
      }
      if (row.status === "completed") {
        if (row.retention_state === "active") {
          await client.query("COMMIT");
          return Object.freeze({
            kind: "completed",
            derivative: toCompletedDerivative(row),
          });
        }
        if (row.retention_state === "claimed") {
          await client.query("COMMIT");
          return Object.freeze({ kind: "inProgress" });
        }
        await this.reclaimDeletedDerivative(client, row, claimId);
        await client.query("COMMIT");
        return Object.freeze({ kind: "claimed", claimId });
      }
      if (row.retention_state !== "active" || !row.failure_retryable) {
        const failure = toFailure(row);
        await client.query("COMMIT");
        throw new PostgresAttachmentTerminalFailureError(failure);
      }
      await this.retryFailedDerivative(client, row, claimId);
      await client.query("COMMIT");
      return Object.freeze({ kind: "claimed", claimId });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async completeDerivative(input: {
    readonly claimId: string;
    readonly derivative: PersistedAttachmentDerivative;
  }): Promise<void> {
    assertOpaque("claimId", input.claimId);
    const identity = assertIdentity(input.derivative.identity);
    if (input.derivative.id !== derivativeId(identity)) {
      throw new RangeError(
        "Attachment derivative ID does not match its identity.",
      );
    }
    if (input.derivative.output.workspaceId !== identity.workspaceId) {
      throw new RangeError("Attachment derivative output crosses a workspace.");
    }
    assertOpaque("output storage key", input.derivative.output.key, 2_048);
    if (input.derivative.operationId !== undefined) {
      assertOpaque("operationId", input.derivative.operationId);
    }
    const completed = await this.pool.query<IdRow>(
      `UPDATE attachment_derivatives
       SET status = 'completed',
           claim_id = NULL,
           claim_expires_at = NULL,
           output_storage_key = $1,
           output_mime_type = 'text/plain',
           ai_operation_id = $2,
           failure_code = NULL,
           failure_retryable = NULL,
           failed_at = NULL,
           completed_at = NOW()
       WHERE workspace_id = $3
         AND id = $4
         AND status = 'pending'
         AND claim_id = $5
       RETURNING id`,
      [
        input.derivative.output.key,
        input.derivative.operationId ?? null,
        identity.workspaceId,
        input.derivative.id,
        input.claimId,
      ],
    );
    if (completed.rows[0] === undefined) {
      throw new PostgresAttachmentClaimOwnershipError();
    }
  }

  public async failDerivative(input: {
    readonly claimId: string;
    readonly code: string;
    readonly retryable: boolean;
  }): Promise<void> {
    assertOpaque("claimId", input.claimId);
    assertOpaque("failure code", input.code);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const failed = await client.query<IdRow>(
        `UPDATE attachment_derivatives
         SET status = 'failed',
             claim_id = NULL,
             claim_expires_at = NULL,
             failure_code = $1,
             failure_retryable = $2,
             failed_at = NOW()
         WHERE status = 'pending' AND claim_id = $3
         RETURNING id`,
        [input.code, input.retryable, input.claimId],
      );
      const derivative = failed.rows[0];
      if (derivative === undefined) {
        throw new PostgresAttachmentClaimOwnershipError();
      }
      await client.query(
        `INSERT INTO attachment_derivative_failures (
           id, workspace_id, attachment_derivative_id, claim_id,
           code, retryable, failed_at
         )
         SELECT $1, workspace_id, id, $2, $3, $4, failed_at
         FROM attachment_derivatives
         WHERE id = $5`,
        [
          `attachment-derivative-failure:${randomUUID()}`,
          input.claimId,
          input.code,
          input.retryable,
          derivative.id,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async findFailure(
    identity: AttachmentDerivativeIdentity,
  ): Promise<AttachmentDerivativeFailure | undefined> {
    const valid = assertIdentity(identity);
    const result = await this.pool.query<DerivativeRow>(
      `SELECT ${this.derivativeColumns()}
       FROM attachment_derivatives
       WHERE workspace_id = $1 AND identity_key = $2`,
      [valid.workspaceId, valid.key],
    );
    const row = result.rows[0];
    return row?.status === "failed" ? toFailure(row) : undefined;
  }

  public async recordDerivativeSource(input: {
    readonly workspaceId: string;
    readonly derivativeId: string;
    readonly attachmentId: string;
    readonly sourceJobId: string;
  }): Promise<void> {
    assertOpaque("workspaceId", input.workspaceId);
    assertOpaque("derivativeId", input.derivativeId);
    assertOpaque("attachmentId", input.attachmentId);
    assertOpaque("sourceJobId", input.sourceJobId);
    await this.pool.query(
      `INSERT INTO attachment_derivative_sources (
         workspace_id, attachment_derivative_id, attachment_id, source_job_id
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [
        input.workspaceId,
        input.derivativeId,
        input.attachmentId,
        input.sourceJobId,
      ],
    );
  }

  public async listDerivativeSources(input: {
    readonly workspaceId: string;
    readonly derivativeId: string;
  }): Promise<readonly AttachmentDerivativeSource[]> {
    assertOpaque("workspaceId", input.workspaceId);
    assertOpaque("derivativeId", input.derivativeId);
    const result = await this.pool.query<SourceRow>(
      `SELECT
         source.attachment_id,
         attachment.external_reference_id AS source_reference_id,
         source.source_job_id,
         derivative.ai_operation_id
       FROM attachment_derivative_sources AS source
       JOIN attachments AS attachment
         ON attachment.workspace_id = source.workspace_id
        AND attachment.id = source.attachment_id
       JOIN attachment_derivatives AS derivative
         ON derivative.workspace_id = source.workspace_id
        AND derivative.id = source.attachment_derivative_id
       WHERE source.workspace_id = $1
         AND source.attachment_derivative_id = $2
       ORDER BY source.attachment_id, source.source_job_id`,
      [input.workspaceId, input.derivativeId],
    );
    return Object.freeze(
      result.rows.map((row) =>
        Object.freeze({
          attachmentId: row.attachment_id,
          sourceReferenceId: row.source_reference_id,
          sourceJobId: row.source_job_id,
          ...(row.ai_operation_id === null
            ? {}
            : { operationId: row.ai_operation_id }),
        }),
      ),
    );
  }

  public async scheduleDerivativeRetention(input: {
    readonly workspaceId: string;
    readonly derivativeId: string;
    readonly expiresAt: string;
  }): Promise<void> {
    assertOpaque("workspaceId", input.workspaceId);
    assertOpaque("derivativeId", input.derivativeId);
    assertTimestamp("retention expiry", input.expiresAt);
    const updated = await this.pool.query<IdRow>(
      `UPDATE attachment_derivatives
       SET retention_expires_at = $1
       WHERE workspace_id = $2
         AND id = $3
         AND status IN ('completed', 'failed')
         AND retention_state = 'active'
       RETURNING id`,
      [input.expiresAt, input.workspaceId, input.derivativeId],
    );
    if (updated.rows[0] === undefined) {
      throw new Error(
        "Attachment derivative is not terminal and retention-active.",
      );
    }
  }

  public async claimExpiredRetention(input: {
    readonly limit: number;
  }): Promise<readonly RetentionCleanupCandidate[]> {
    validateRetentionLimit(input.limit);
    const claimId = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const candidates: RetentionCleanupCandidate[] = [];
      const derivatives = await client.query<RetentionDerivativeRow>(
        `WITH selected AS (
           SELECT id
           FROM attachment_derivatives
           WHERE status IN ('completed', 'failed')
             AND retention_expires_at <= NOW()
             AND (
               retention_state = 'active'
               OR (
                 retention_state = 'claimed'
                 AND retention_claim_expires_at <= NOW()
               )
             )
           ORDER BY retention_expires_at, id
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE attachment_derivatives AS derivative
         SET retention_state = 'claimed',
             retention_claim_id = $2,
             retention_claimed_at = NOW(),
             retention_claim_expires_at =
               NOW() + ($3 * INTERVAL '1 millisecond')
         FROM selected
         WHERE derivative.id = selected.id
         RETURNING derivative.id, derivative.workspace_id,
                   derivative.output_storage_key`,
        [input.limit, claimId, this.retentionClaimLeaseMs],
      );
      candidates.push(
        ...derivatives.rows.map((row) =>
          Object.freeze({
            kind: "derivative" as const,
            id: row.id,
            claimId,
            ...(row.output_storage_key === null
              ? {}
              : {
                  storage: Object.freeze({
                    workspaceId: row.workspace_id,
                    key: row.output_storage_key,
                  }),
                }),
          }),
        ),
      );
      const remainingAfterDerivatives = input.limit - candidates.length;
      if (remainingAfterDerivatives > 0) {
        const references = await client.query<IdRow>(
          `WITH selected AS (
             SELECT id
             FROM attachments
             WHERE retention_expires_at <= NOW()
               AND (
                 retention_state = 'active'
                 OR (
                   retention_state = 'claimed'
                   AND retention_claim_expires_at <= NOW()
                 )
               )
             ORDER BY retention_expires_at, id
             LIMIT $1
             FOR UPDATE SKIP LOCKED
           )
           UPDATE attachments AS attachment
           SET retention_state = 'claimed',
               retention_claim_id = $2,
               retention_claimed_at = NOW(),
               retention_claim_expires_at =
                 NOW() + ($3 * INTERVAL '1 millisecond')
           FROM selected
           WHERE attachment.id = selected.id
           RETURNING attachment.id`,
          [remainingAfterDerivatives, claimId, this.retentionClaimLeaseMs],
        );
        candidates.push(
          ...references.rows.map((row) =>
            Object.freeze({
              kind: "attachmentReference" as const,
              id: row.id,
              claimId,
            }),
          ),
        );
      }
      const remainingAfterReferences = input.limit - candidates.length;
      if (remainingAfterReferences > 0) {
        const blobs = await client.query<RetentionBlobRow>(
          `WITH selected AS (
             SELECT blob.id
             FROM attachment_blobs AS blob
             WHERE blob.retention_state = 'active'
               AND NOT EXISTS (
                 SELECT 1
                 FROM attachments AS attachment
                 WHERE attachment.workspace_id = blob.workspace_id
                   AND attachment.blob_id = blob.id
                   AND attachment.retention_state <> 'deleted'
               )
             ORDER BY blob.id
             LIMIT $1
             FOR UPDATE SKIP LOCKED
           )
           UPDATE attachment_blobs AS blob
           SET retention_state = 'claimed',
               retention_claim_id = $2,
               retention_claimed_at = NOW(),
               retention_claim_expires_at =
                 NOW() + ($3 * INTERVAL '1 millisecond')
           FROM selected
           WHERE blob.id = selected.id
           RETURNING blob.id, blob.workspace_id, blob.storage_key`,
          [remainingAfterReferences, claimId, this.retentionClaimLeaseMs],
        );
        for (const row of blobs.rows) {
          if (row.storage_key === null) {
            throw new Error(
              "Retention-active attachment blob has no storage key.",
            );
          }
          candidates.push(
            Object.freeze({
              kind: "blob",
              id: row.id,
              claimId,
              storage: Object.freeze({
                workspaceId: row.workspace_id,
                key: row.storage_key,
              }),
            }),
          );
        }
      }
      await client.query("COMMIT");
      return Object.freeze(candidates);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async completeRetentionCleanup(
    candidate: RetentionCleanupCandidate,
  ): Promise<void> {
    assertOpaque("retention claimId", candidate.claimId);
    const completed = await this.completeRetentionCleanupCandidate(candidate);
    if (completed.rows[0] === undefined) {
      throw new PostgresAttachmentClaimOwnershipError();
    }
  }

  private derivativeColumns(): string {
    return `id, workspace_id, identity_key, access_policy_hash, content_hash,
      processor, processor_version, security_policy_version, normalization_version,
      vision_prompt_version, vision_binding_version_id, status, claim_id,
      output_storage_key, output_mime_type, ai_operation_id, failure_code,
      failure_retryable, failed_at, retention_state`;
  }

  private async reclaimDeletedDerivative(
    client: PoolClient,
    row: DerivativeRow,
    claimId: string,
  ): Promise<void> {
    const reclaimed = await client.query<IdRow>(
      `UPDATE attachment_derivatives
       SET status = 'pending',
           claim_id = $1,
           claim_expires_at = NOW() + ($2 * INTERVAL '1 millisecond'),
           claim_attempts = claim_attempts + 1,
           output_storage_key = NULL,
           output_mime_type = NULL,
           ai_operation_id = NULL,
           failure_code = NULL,
           failure_retryable = NULL,
           failed_at = NULL,
           completed_at = NULL,
           retention_state = 'active',
           retention_claim_id = NULL,
           retention_claimed_at = NULL,
           retention_claim_expires_at = NULL,
           retention_deleted_at = NULL
       WHERE workspace_id = $3
         AND id = $4
         AND status = 'completed'
         AND retention_state = 'deleted'
       RETURNING id`,
      [claimId, this.claimLeaseMs, row.workspace_id, row.id],
    );
    if (reclaimed.rows[0] === undefined) {
      throw new PostgresAttachmentClaimOwnershipError();
    }
  }

  private async retryFailedDerivative(
    client: PoolClient,
    row: DerivativeRow,
    claimId: string,
  ): Promise<void> {
    const retried = await client.query<IdRow>(
      `UPDATE attachment_derivatives
       SET status = 'pending',
           claim_id = $1,
           claim_expires_at = NOW() + ($2 * INTERVAL '1 millisecond'),
           claim_attempts = claim_attempts + 1,
           failure_code = NULL,
           failure_retryable = NULL,
           failed_at = NULL
       WHERE workspace_id = $3
         AND id = $4
         AND status = 'failed'
         AND failure_retryable = true
         AND retention_state = 'active'
       RETURNING id`,
      [claimId, this.claimLeaseMs, row.workspace_id, row.id],
    );
    if (retried.rows[0] === undefined) {
      throw new PostgresAttachmentClaimOwnershipError();
    }
  }

  private async completeRetentionCleanupCandidate(
    candidate: RetentionCleanupCandidate,
  ): Promise<{ readonly rows: readonly IdRow[] }> {
    const values = [candidate.id, candidate.claimId];
    switch (candidate.kind) {
      case "derivative":
        return this.pool.query<IdRow>(
          `UPDATE attachment_derivatives
           SET retention_state = 'deleted',
               retention_claim_id = NULL,
               retention_claimed_at = NULL,
               retention_claim_expires_at = NULL,
               retention_deleted_at = NOW(),
               output_storage_key = NULL,
               output_mime_type = NULL
           WHERE id = $1
             AND retention_state = 'claimed'
             AND retention_claim_id = $2
           RETURNING id`,
          values,
        );
      case "attachmentReference":
        return this.pool.query<IdRow>(
          `UPDATE attachments
           SET retention_state = 'deleted',
               retention_claim_id = NULL,
               retention_claimed_at = NULL,
               retention_claim_expires_at = NULL,
               retention_deleted_at = NOW()
           WHERE id = $1
             AND retention_state = 'claimed'
             AND retention_claim_id = $2
           RETURNING id`,
          values,
        );
      case "blob":
        return this.pool.query<IdRow>(
          `UPDATE attachment_blobs
           SET retention_state = 'deleted',
               retention_claim_id = NULL,
               retention_claimed_at = NULL,
               retention_claim_expires_at = NULL,
               retention_deleted_at = NOW(),
               storage_key = NULL
           WHERE id = $1
             AND retention_state = 'claimed'
             AND retention_claim_id = $2
           RETURNING id`,
          values,
        );
    }
  }

  private assertAttachmentInput(input: AttachmentReferenceInput): void {
    assertOpaque("attachment ID", input.id);
    assertOpaque("workspaceId", input.workspaceId);
    assertOpaque("sourceReferenceId", input.sourceReferenceId);
    if (input.storage.workspaceId !== input.workspaceId) {
      throw new RangeError("Attachment storage handle crosses a workspace.");
    }
    assertOpaque("storage key", input.storage.key, 2_048);
    if (!/^[a-f0-9]{64}$/u.test(input.sha256)) {
      throw new RangeError("Attachment content SHA-256 is invalid.");
    }
    if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
      throw new RangeError("Attachment byte length is invalid.");
    }
    assertOpaque("detected MIME type", input.detectedMimeType, 255);
    if (input.declaredMimeType !== undefined) {
      assertOpaque("declared MIME type", input.declaredMimeType, 255);
    }
    if (input.sanitizedFilename !== undefined) {
      assertOpaque("sanitized filename", input.sanitizedFilename, 255);
      if (/[\r\n]/u.test(input.sanitizedFilename)) {
        throw new RangeError("Attachment sanitized filename is invalid.");
      }
    }
    assertTimestamp("observedAt", input.observedAt);
    if (input.retentionExpiresAt !== undefined) {
      assertTimestamp("retention expiry", input.retentionExpiresAt);
    }
  }
}

export interface PostgresAttachmentPersistence {
  readonly repository: PostgresAttachmentRepository;
  close(): Promise<void>;
}

export interface PostgresAttachmentPersistenceConfiguration {
  readonly databaseUrl: string;
  readonly claimLeaseMs?: number;
  readonly retentionClaimLeaseMs?: number;
}

/**
 * Creates persistence composition only. Attachment persistence has no durable command
 * input, so worker invocation belongs to analysis/publication orchestration.
 */
export function createPostgresAttachmentPersistence(
  configuration: PostgresAttachmentPersistenceConfiguration,
): PostgresAttachmentPersistence {
  const pool = new Pool({ connectionString: configuration.databaseUrl });
  return Object.freeze({
    repository: new PostgresAttachmentRepository(
      pool,
      configuration.claimLeaseMs,
      configuration.retentionClaimLeaseMs,
    ),
    close: async () => pool.end(),
  });
}
