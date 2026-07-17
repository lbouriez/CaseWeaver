import { randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

export type AttachmentOccurrenceOwnerKind =
  | "knowledgeRevision"
  | "caseSnapshot"
  | "caseMessage";
export type AttachmentOccurrenceRelation =
  | "declaredAttachment"
  | "inlineImage"
  | "inlineFile";

/**
 * These are the only connector-declared fields retained with a generic
 * occurrence. Names, URLs, external revisions, locators, and source content
 * remain outside this safe record.
 */
export interface SafeAttachmentOccurrenceDeclaredMetadata {
  readonly mediaType?: string;
  readonly contentLength?: number;
  readonly contentHash?: string;
}

/**
 * The caller must obtain this from deployment-owned authenticated encryption.
 * This server-private type is intentionally absent from every generic
 * occurrence/run/evidence result.
 */
export interface EncryptedAttachmentOccurrenceLocator {
  readonly ciphertext: string;
  readonly cipherVersion: string;
}

export interface AttachmentOccurrenceWrite {
  readonly id: string;
  readonly workspaceId: string;
  readonly ownerKind: AttachmentOccurrenceOwnerKind;
  readonly ownerId: string;
  readonly connectorRegistrationId: string;
  /** Immutable connector configuration version that produced this occurrence. */
  readonly connectorConfigurationVersionId: string;
  readonly relation: AttachmentOccurrenceRelation;
  readonly ordinal: number;
  /** Workspace-scoped external-reference row identity, never a raw reference. */
  readonly attachmentReferenceId: string;
  readonly declared?: SafeAttachmentOccurrenceDeclaredMetadata;
  /** Canonical connector occurrence identity; it excludes the opaque locator. */
  readonly identityHash: string;
  readonly required: boolean;
  readonly privateLocator: EncryptedAttachmentOccurrenceLocator;
}

/** A generic-safe occurrence projection. It cannot reveal the reopen locator. */
export interface AttachmentOccurrenceRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly ownerKind: AttachmentOccurrenceOwnerKind;
  readonly ownerId: string;
  readonly connectorRegistrationId: string;
  readonly connectorConfigurationVersionId: string;
  readonly relation: AttachmentOccurrenceRelation;
  readonly ordinal: number;
  readonly attachmentReferenceId: string;
  readonly declared: SafeAttachmentOccurrenceDeclaredMetadata;
  readonly identityHash: string;
  readonly required: boolean;
}

export type AttachmentPreparationRunState =
  | "pending"
  | "claimed"
  | "completed"
  | "failed";

export interface AttachmentPreparationRunRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly ownerKind: AttachmentOccurrenceOwnerKind;
  readonly ownerId: string;
  readonly attachmentPolicyVersionId?: string;
  readonly policyIdentityHash: string;
  readonly preparationIdentityHash: string;
  readonly state: AttachmentPreparationRunState;
  readonly fencingToken: bigint;
  readonly retryRequired: boolean;
}

export interface AttachmentPreparationRunRequest {
  readonly workspaceId: string;
  readonly ownerKind: AttachmentOccurrenceOwnerKind;
  readonly ownerId: string;
  readonly attachmentPolicyVersionId?: string;
  readonly policyIdentityHash: string;
  readonly preparationIdentityHash: string;
}

export interface AttachmentPreparationLease {
  /** Server-private worker lease token; never an API or audit field. */
  readonly token: string;
  readonly fencingToken: bigint;
  readonly expiresAt: string;
}

export interface ReadyAttachmentPreparationEvidence {
  readonly occurrenceId: string;
  readonly outcome: "ready";
  readonly attachmentId: string;
  readonly derivativeId: string;
  readonly processorVersion: string;
  readonly outputContentHash: string;
}

export interface UnavailableAttachmentPreparationEvidence {
  readonly occurrenceId: string;
  readonly outcome: "skipped" | "failed";
  readonly warningCode: string;
  readonly retryable: boolean;
}

export type AttachmentPreparationEvidenceWrite =
  | ReadyAttachmentPreparationEvidence
  | UnavailableAttachmentPreparationEvidence;

/** Safe terminal state; it has no locator, storage key, URL, text, or error detail. */
export type AttachmentPreparationEvidenceRecord =
  | Readonly<{
      readonly occurrenceId: string;
      readonly outcome: "ready";
      readonly required: boolean;
      readonly attachmentId: string;
      readonly derivativeId: string;
      readonly processorVersion: string;
      readonly outputContentHash: string;
    }>
  | Readonly<{
      readonly occurrenceId: string;
      readonly outcome: "skipped" | "failed";
      readonly required: boolean;
      readonly warningCode: string;
      readonly retryable: boolean;
    }>;

export interface AttachmentPreparationTerminalOutcome {
  readonly run: AttachmentPreparationRunRecord;
  readonly evidence: readonly AttachmentPreparationEvidenceRecord[];
}

export type AttachmentPreparationClaim =
  | Readonly<{
      readonly kind: "claimed";
      readonly run: AttachmentPreparationRunRecord;
      readonly lease: AttachmentPreparationLease;
    }>
  | Readonly<{
      readonly kind: "inProgress";
      readonly run: AttachmentPreparationRunRecord;
    }>
  | Readonly<{
      readonly kind: "terminal";
      readonly outcome: AttachmentPreparationTerminalOutcome;
    }>;

export class PostgresAttachmentPreparationClaimOwnershipError extends Error {
  public readonly code = "attachmentPreparation.claimOwnership";
  public readonly retryable = false;

  public constructor() {
    super("Attachment preparation lease is no longer owned by this worker.");
    this.name = "PostgresAttachmentPreparationClaimOwnershipError";
  }
}

interface OccurrenceRow extends QueryResultRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly owner_kind: string;
  readonly owner_id: string;
  readonly connector_registration_id: string;
  readonly connector_configuration_version_id: string | null;
  readonly relation: string;
  readonly ordinal: number;
  readonly attachment_reference_id: string;
  readonly declared_metadata: unknown;
  readonly identity_hash: string;
  readonly required: boolean;
}

interface PrivateLocatorRow extends QueryResultRow {
  readonly locator_ciphertext: string;
  readonly cipher_version: string;
}

interface PreparationRunRow extends QueryResultRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly owner_kind: string;
  readonly owner_id: string;
  readonly attachment_policy_version_id: string | null;
  readonly policy_identity_hash: string;
  readonly preparation_identity_hash: string;
  readonly state: string;
  readonly lease_token: string | null;
  readonly lease_expires_at: Date | null;
  readonly fencing_token: string;
  readonly retry_required: boolean;
  readonly completed_at: Date | null;
}

interface PreparationEvidenceRow extends QueryResultRow {
  readonly attachment_occurrence_id: string;
  readonly outcome: string;
  readonly required: boolean;
  readonly attachment_id: string | null;
  readonly attachment_derivative_id: string | null;
  readonly processor_version: string | null;
  readonly output_content_hash: string | null;
  readonly warning_code: string | null;
  readonly retryable: boolean;
}

interface CompletedDerivativeRow extends QueryResultRow {
  readonly processor_version: string;
  readonly output_content_hash: string;
}

interface OccurrenceProvenanceRow extends QueryResultRow {
  readonly connector_registration_id: string;
}

const maximumIdentifierLength = 1_024;
const maximumCiphertextLength = 32_768;

function assertText(
  value: string,
  label: string,
  maximumLength = maximumIdentifierLength,
): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.includes("\u0000") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new RangeError(`Attachment preparation ${label} is invalid.`);
  }
}

function assertHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new RangeError(`Attachment preparation ${label} is invalid.`);
  }
}

function assertBoolean(
  value: unknown,
  label: string,
): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Stored attachment preparation ${label} is invalid.`);
  }
}

function assertFencingToken(
  value: unknown,
  label: string,
): asserts value is bigint {
  if (
    typeof value !== "bigint" ||
    value < 1n ||
    value > 9_223_372_036_854_775_807n
  ) {
    throw new RangeError(`Attachment preparation ${label} is invalid.`);
  }
}

function assertOwnerKind(
  value: string,
): asserts value is AttachmentOccurrenceOwnerKind {
  if (
    value !== "knowledgeRevision" &&
    value !== "caseSnapshot" &&
    value !== "caseMessage"
  ) {
    throw new RangeError("Attachment preparation owner kind is invalid.");
  }
}

function assertRelation(
  value: string,
): asserts value is AttachmentOccurrenceRelation {
  if (
    value !== "declaredAttachment" &&
    value !== "inlineImage" &&
    value !== "inlineFile"
  ) {
    throw new RangeError(
      "Attachment preparation occurrence relation is invalid.",
    );
  }
}

function assertSafeInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Attachment preparation ${label} is invalid.`);
  }
}

function normalizeDeclared(
  input: SafeAttachmentOccurrenceDeclaredMetadata | undefined,
): SafeAttachmentOccurrenceDeclaredMetadata {
  if (input === undefined) return Object.freeze({});
  const value: {
    mediaType?: string;
    contentLength?: number;
    contentHash?: string;
  } = {};
  if (input.mediaType !== undefined) {
    assertText(input.mediaType, "declared media type", 255);
    value.mediaType = input.mediaType.toLowerCase();
  }
  if (input.contentLength !== undefined) {
    assertSafeInteger(
      input.contentLength,
      "declared content length",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    value.contentLength = input.contentLength;
  }
  if (input.contentHash !== undefined) {
    assertHash(input.contentHash, "declared content hash");
    value.contentHash = input.contentHash.toLowerCase();
  }
  return Object.freeze(value);
}

function parseDeclared(
  value: unknown,
): SafeAttachmentOccurrenceDeclaredMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored attachment occurrence metadata is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        key !== "mediaType" && key !== "contentLength" && key !== "contentHash",
    )
  ) {
    throw new Error("Stored attachment occurrence metadata is invalid.");
  }
  if (
    ("mediaType" in record && typeof record.mediaType !== "string") ||
    ("contentLength" in record && typeof record.contentLength !== "number") ||
    ("contentHash" in record && typeof record.contentHash !== "string")
  ) {
    throw new Error("Stored attachment occurrence metadata is invalid.");
  }
  return normalizeDeclared({
    ...(typeof record.mediaType === "string"
      ? { mediaType: record.mediaType }
      : {}),
    ...(typeof record.contentLength === "number"
      ? { contentLength: record.contentLength }
      : {}),
    ...(typeof record.contentHash === "string"
      ? { contentHash: record.contentHash }
      : {}),
  });
}

function canonicalDeclared(
  value: SafeAttachmentOccurrenceDeclaredMetadata,
): string {
  return JSON.stringify({
    ...(value.mediaType === undefined ? {} : { mediaType: value.mediaType }),
    ...(value.contentLength === undefined
      ? {}
      : { contentLength: value.contentLength }),
    ...(value.contentHash === undefined
      ? {}
      : { contentHash: value.contentHash }),
  });
}

function validateOccurrence(
  input: AttachmentOccurrenceWrite,
): AttachmentOccurrenceWrite {
  assertText(input.id, "occurrence ID", 200);
  assertText(input.workspaceId, "workspace ID", 200);
  assertOwnerKind(input.ownerKind);
  assertText(input.ownerId, "owner ID", 200);
  assertText(input.connectorRegistrationId, "connector registration ID", 200);
  assertText(
    input.connectorConfigurationVersionId,
    "connector configuration version ID",
    200,
  );
  assertRelation(input.relation);
  assertSafeInteger(input.ordinal, "occurrence ordinal", 0, 1_000_000);
  assertText(input.attachmentReferenceId, "attachment reference ID", 1_024);
  assertHash(input.identityHash, "occurrence identity hash");
  if (typeof input.required !== "boolean") {
    throw new RangeError(
      "Attachment preparation occurrence required flag is invalid.",
    );
  }
  assertText(
    input.privateLocator.ciphertext,
    "locator ciphertext",
    maximumCiphertextLength,
  );
  assertText(input.privateLocator.cipherVersion, "locator cipher version", 100);
  return Object.freeze({
    ...input,
    declared: normalizeDeclared(input.declared),
  });
}

function validateRunRequest(
  input: AttachmentPreparationRunRequest,
): AttachmentPreparationRunRequest {
  assertText(input.workspaceId, "workspace ID", 200);
  assertOwnerKind(input.ownerKind);
  assertText(input.ownerId, "owner ID", 200);
  if (input.attachmentPolicyVersionId !== undefined) {
    assertText(
      input.attachmentPolicyVersionId,
      "attachment policy version ID",
      200,
    );
  }
  assertHash(input.policyIdentityHash, "policy identity hash");
  assertHash(input.preparationIdentityHash, "run identity hash");
  return input;
}

function validateEvidence(
  input: readonly AttachmentPreparationEvidenceWrite[],
): void {
  const seen = new Set<string>();
  for (const item of input) {
    assertText(item.occurrenceId, "evidence occurrence ID", 200);
    if (seen.has(item.occurrenceId)) {
      throw new RangeError(
        "Attachment preparation evidence cannot repeat an occurrence.",
      );
    }
    seen.add(item.occurrenceId);
    if (item.outcome === "ready") {
      assertText(item.attachmentId, "evidence attachment ID", 200);
      assertText(item.derivativeId, "evidence derivative ID", 200);
      assertText(item.processorVersion, "evidence processor version", 200);
      assertHash(item.outputContentHash, "evidence output content hash");
    } else {
      if (item.outcome !== "skipped" && item.outcome !== "failed") {
        throw new RangeError(
          "Attachment preparation evidence outcome is invalid.",
        );
      }
      if (
        !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(item.warningCode) ||
        item.warningCode.length > 200
      ) {
        throw new RangeError("Attachment preparation warning code is invalid.");
      }
      if (typeof item.retryable !== "boolean") {
        throw new RangeError(
          "Attachment preparation evidence retryable flag is invalid.",
        );
      }
    }
  }
}

function assertRunCoherence(row: PreparationRunRow): void {
  const fence = BigInt(row.fencing_token);
  const hasLeaseToken = row.lease_token !== null;
  const hasLeaseExpiry = row.lease_expires_at !== null;
  if (
    (row.lease_expires_at !== null &&
      (!(row.lease_expires_at instanceof Date) ||
        Number.isNaN(row.lease_expires_at.getTime()))) ||
    (row.completed_at !== null &&
      (!(row.completed_at instanceof Date) ||
        Number.isNaN(row.completed_at.getTime())))
  ) {
    throw new Error("Stored attachment preparation timestamps are invalid.");
  }
  if (hasLeaseToken !== hasLeaseExpiry) {
    throw new Error("Stored attachment preparation lease state is invalid.");
  }
  if (row.state === "pending") {
    if (
      hasLeaseToken ||
      row.completed_at !== null ||
      fence !== 0n ||
      row.retry_required
    ) {
      throw new Error("Stored pending attachment preparation run is invalid.");
    }
    return;
  }
  if (row.state === "claimed") {
    if (
      !hasLeaseToken ||
      row.completed_at !== null ||
      fence < 1n ||
      row.retry_required
    ) {
      throw new Error("Stored claimed attachment preparation run is invalid.");
    }
    assertText(row.lease_token, "stored lease token", 200);
    return;
  }
  if (
    (row.state === "completed" || row.state === "failed") &&
    !hasLeaseToken &&
    row.completed_at !== null &&
    fence >= 1n
  ) {
    return;
  }
  throw new Error("Stored terminal attachment preparation run is invalid.");
}

function toRun(row: PreparationRunRow): AttachmentPreparationRunRecord {
  assertText(row.id, "stored run ID", 200);
  assertText(row.workspace_id, "stored workspace ID", 200);
  assertOwnerKind(row.owner_kind);
  assertText(row.owner_id, "stored owner ID", 200);
  if (row.attachment_policy_version_id !== null) {
    assertText(
      row.attachment_policy_version_id,
      "stored attachment policy version ID",
      200,
    );
  }
  assertHash(row.policy_identity_hash, "stored policy identity hash");
  assertHash(row.preparation_identity_hash, "stored run identity hash");
  if (
    row.state !== "pending" &&
    row.state !== "claimed" &&
    row.state !== "completed" &&
    row.state !== "failed"
  ) {
    throw new Error("Stored attachment preparation state is invalid.");
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(row.fencing_token)) {
    throw new Error("Stored attachment preparation fence is invalid.");
  }
  assertBoolean(row.retry_required, "retry-required flag");
  assertRunCoherence(row);
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspace_id,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    ...(row.attachment_policy_version_id === null
      ? {}
      : { attachmentPolicyVersionId: row.attachment_policy_version_id }),
    policyIdentityHash: row.policy_identity_hash,
    preparationIdentityHash: row.preparation_identity_hash,
    state: row.state,
    fencingToken: BigInt(row.fencing_token),
    retryRequired: row.retry_required,
  });
}

function toOccurrence(row: OccurrenceRow): AttachmentOccurrenceRecord {
  assertText(row.id, "stored occurrence ID", 200);
  assertText(row.workspace_id, "stored workspace ID", 200);
  assertOwnerKind(row.owner_kind);
  assertText(row.owner_id, "stored owner ID", 200);
  assertText(
    row.connector_registration_id,
    "stored connector registration ID",
    200,
  );
  if (row.connector_configuration_version_id === null) {
    throw new Error(
      "Stored attachment occurrence configuration provenance is invalid.",
    );
  }
  assertText(
    row.connector_configuration_version_id,
    "stored connector configuration version ID",
    200,
  );
  assertRelation(row.relation);
  assertSafeInteger(row.ordinal, "stored occurrence ordinal", 0, 1_000_000);
  assertText(
    row.attachment_reference_id,
    "stored attachment reference ID",
    1_024,
  );
  assertHash(row.identity_hash, "stored occurrence identity hash");
  assertBoolean(row.required, "occurrence required flag");
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspace_id,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    connectorRegistrationId: row.connector_registration_id,
    connectorConfigurationVersionId: row.connector_configuration_version_id,
    relation: row.relation,
    ordinal: row.ordinal,
    attachmentReferenceId: row.attachment_reference_id,
    declared: parseDeclared(row.declared_metadata),
    identityHash: row.identity_hash,
    required: row.required,
  });
}

function toEvidence(
  row: PreparationEvidenceRow,
): AttachmentPreparationEvidenceRecord {
  assertText(
    row.attachment_occurrence_id,
    "stored evidence occurrence ID",
    200,
  );
  assertBoolean(row.required, "evidence required flag");
  assertBoolean(row.retryable, "evidence retryable flag");
  if (row.outcome === "ready") {
    if (
      row.attachment_id === null ||
      row.attachment_derivative_id === null ||
      row.processor_version === null ||
      row.output_content_hash === null ||
      row.warning_code !== null ||
      row.retryable
    ) {
      throw new Error(
        "Stored ready attachment preparation evidence is invalid.",
      );
    }
    assertText(row.attachment_id, "stored evidence attachment ID", 200);
    assertText(
      row.attachment_derivative_id,
      "stored evidence derivative ID",
      200,
    );
    assertText(row.processor_version, "stored evidence processor version", 200);
    assertHash(row.output_content_hash, "stored evidence output content hash");
    return Object.freeze({
      occurrenceId: row.attachment_occurrence_id,
      outcome: "ready",
      required: row.required,
      attachmentId: row.attachment_id,
      derivativeId: row.attachment_derivative_id,
      processorVersion: row.processor_version,
      outputContentHash: row.output_content_hash,
    });
  }
  if (
    (row.outcome !== "skipped" && row.outcome !== "failed") ||
    row.attachment_id !== null ||
    row.attachment_derivative_id !== null ||
    row.processor_version !== null ||
    row.output_content_hash !== null ||
    row.warning_code === null
  ) {
    throw new Error(
      "Stored unavailable attachment preparation evidence is invalid.",
    );
  }
  if (
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(row.warning_code) ||
    row.warning_code.length > 200
  ) {
    throw new Error("Stored attachment preparation warning code is invalid.");
  }
  return Object.freeze({
    occurrenceId: row.attachment_occurrence_id,
    outcome: row.outcome,
    required: row.required,
    warningCode: row.warning_code,
    retryable: row.retryable,
  });
}

function sameOccurrence(
  left: AttachmentOccurrenceRecord,
  right: AttachmentOccurrenceWrite,
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.ownerKind === right.ownerKind &&
    left.ownerId === right.ownerId &&
    left.connectorRegistrationId === right.connectorRegistrationId &&
    left.connectorConfigurationVersionId ===
      right.connectorConfigurationVersionId &&
    left.relation === right.relation &&
    left.ordinal === right.ordinal &&
    left.attachmentReferenceId === right.attachmentReferenceId &&
    canonicalDeclared(left.declared) ===
      canonicalDeclared(right.declared ?? {}) &&
    left.identityHash === right.identityHash &&
    left.required === right.required
  );
}

/**
 * PostgreSQL persistence for immutable attachment locations and the terminal
 * preparation ledger. It intentionally owns no connector, attachment runtime,
 * AI, storage, queue, or API call; composition supplies only already-encrypted
 * locators and verified derivative identities.
 */
export class PostgresAttachmentOccurrencePreparationStore {
  public constructor(
    private readonly pool: Pool,
    private readonly claimLeaseMs = 15 * 60 * 1_000,
  ) {
    assertSafeInteger(claimLeaseMs, "claim lease duration", 1, 60 * 60 * 1_000);
  }

  public async recordOccurrence(
    input: AttachmentOccurrenceWrite,
  ): Promise<AttachmentOccurrenceRecord> {
    const valid = validateOccurrence(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.assertOccurrenceProvenance(client, valid);
      const inserted = await client.query<OccurrenceRow>(
        `INSERT INTO attachment_occurrences (
           id, workspace_id, owner_kind, owner_id, connector_registration_id,
           connector_configuration_version_id, relation, ordinal,
           attachment_reference_id, declared_metadata, identity_hash, required
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12
         )
         ON CONFLICT (workspace_id, id) DO NOTHING
         RETURNING ${occurrenceColumns()}`,
        [
          valid.id,
          valid.workspaceId,
          valid.ownerKind,
          valid.ownerId,
          valid.connectorRegistrationId,
          valid.connectorConfigurationVersionId,
          valid.relation,
          valid.ordinal,
          valid.attachmentReferenceId,
          canonicalDeclared(valid.declared ?? {}),
          valid.identityHash,
          valid.required,
        ],
      );
      const row =
        inserted.rows[0] ??
        (
          await client.query<OccurrenceRow>(
            `SELECT ${occurrenceColumns()}
             FROM attachment_occurrences
             WHERE workspace_id = $1 AND id = $2
             FOR KEY SHARE`,
            [valid.workspaceId, valid.id],
          )
        ).rows[0];
      if (row === undefined) {
        throw new Error("Attachment occurrence could not be recorded.");
      }
      const occurrence = toOccurrence(row);
      if (!sameOccurrence(occurrence, valid)) {
        throw new Error("Attachment occurrence conflicts with immutable data.");
      }
      const privateInserted = await client.query<PrivateLocatorRow>(
        `INSERT INTO attachment_occurrence_private (
           workspace_id, attachment_occurrence_id, locator_ciphertext, cipher_version
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id, attachment_occurrence_id) DO NOTHING
         RETURNING locator_ciphertext, cipher_version`,
        [
          valid.workspaceId,
          valid.id,
          valid.privateLocator.ciphertext,
          valid.privateLocator.cipherVersion,
        ],
      );
      const privateRow =
        privateInserted.rows[0] ??
        (
          await client.query<PrivateLocatorRow>(
            `SELECT locator_ciphertext, cipher_version
             FROM attachment_occurrence_private
             WHERE workspace_id = $1 AND attachment_occurrence_id = $2
             FOR KEY SHARE`,
            [valid.workspaceId, valid.id],
          )
        ).rows[0];
      if (
        privateRow === undefined ||
        privateRow.locator_ciphertext !== valid.privateLocator.ciphertext ||
        privateRow.cipher_version !== valid.privateLocator.cipherVersion
      ) {
        throw new Error(
          "Attachment occurrence conflicts with immutable private data.",
        );
      }
      await client.query("COMMIT");
      return occurrence;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async listOccurrences(input: {
    readonly workspaceId: string;
    readonly ownerKind: AttachmentOccurrenceOwnerKind;
    readonly ownerId: string;
  }): Promise<readonly AttachmentOccurrenceRecord[]> {
    assertText(input.workspaceId, "workspace ID", 200);
    assertOwnerKind(input.ownerKind);
    assertText(input.ownerId, "owner ID", 200);
    const result = await this.pool.query<OccurrenceRow>(
      `SELECT ${occurrenceColumns()}
       FROM attachment_occurrences
       WHERE workspace_id = $1 AND owner_kind = $2 AND owner_id = $3
       ORDER BY ordinal, id`,
      [input.workspaceId, input.ownerKind, input.ownerId],
    );
    return Object.freeze(result.rows.map(toOccurrence));
  }

  /**
   * Server-private locator resolution. Do not compose this method into an API
   * read model, audit detail, logger, diagnostic, or generic occurrence query.
   */
  public async readPrivateOccurrenceLocator(input: {
    readonly workspaceId: string;
    readonly occurrenceId: string;
  }): Promise<EncryptedAttachmentOccurrenceLocator | undefined> {
    assertText(input.workspaceId, "workspace ID", 200);
    assertText(input.occurrenceId, "occurrence ID", 200);
    const result = await this.pool.query<PrivateLocatorRow>(
      `SELECT locator_ciphertext, cipher_version
       FROM attachment_occurrence_private
       WHERE workspace_id = $1 AND attachment_occurrence_id = $2
       LIMIT 1`,
      [input.workspaceId, input.occurrenceId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    assertText(
      row.locator_ciphertext,
      "stored locator ciphertext",
      maximumCiphertextLength,
    );
    assertText(row.cipher_version, "stored locator cipher version", 100);
    return Object.freeze({
      ciphertext: row.locator_ciphertext,
      cipherVersion: row.cipher_version,
    });
  }

  public async claimPreparation(
    input: AttachmentPreparationRunRequest,
  ): Promise<AttachmentPreparationClaim> {
    const valid = validateRunRequest(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let row = await this.findRunForUpdate(client, valid);
      if (row === undefined) {
        row = await this.insertClaimedRun(client, valid);
        if (row !== undefined) {
          const result = claimedResult(row);
          await client.query("COMMIT");
          return result;
        }
        row = await this.findRunForUpdate(client, valid);
        if (row === undefined) {
          throw new Error("Attachment preparation run could not be claimed.");
        }
      }
      const run = toRun(row);
      if (
        run.policyIdentityHash !== valid.policyIdentityHash ||
        run.attachmentPolicyVersionId !== valid.attachmentPolicyVersionId
      ) {
        throw new Error(
          "Attachment preparation identity conflicts with immutable policy data.",
        );
      }
      if (run.state === "completed" || run.state === "failed") {
        const outcome = await this.terminalOutcome(client, row);
        await client.query("COMMIT");
        return Object.freeze({ kind: "terminal", outcome });
      }
      const reClaimed = await this.claimExistingRun(client, row);
      if (reClaimed === undefined) {
        await client.query("COMMIT");
        return Object.freeze({ kind: "inProgress", run });
      }
      const result = claimedResult(reClaimed);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async completePreparation(input: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly lease: AttachmentPreparationLease;
    readonly evidence: readonly AttachmentPreparationEvidenceWrite[];
  }): Promise<AttachmentPreparationTerminalOutcome> {
    assertText(input.workspaceId, "workspace ID", 200);
    assertText(input.runId, "run ID", 200);
    assertText(input.lease.token, "lease token", 200);
    assertFencingToken(input.lease.fencingToken, "fencing token");
    validateEvidence(input.evidence);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query<PreparationRunRow>(
        `SELECT ${runColumns()}
         FROM attachment_preparation_runs
         WHERE workspace_id = $1
           AND id = $2
           AND state = 'claimed'
           AND lease_token = $3
           AND fencing_token = $4
           AND lease_expires_at > NOW()
         FOR UPDATE`,
        [
          input.workspaceId,
          input.runId,
          input.lease.token,
          input.lease.fencingToken.toString(),
        ],
      );
      const runRow = claimed.rows[0];
      if (runRow === undefined) {
        throw new PostgresAttachmentPreparationClaimOwnershipError();
      }
      const occurrences = await client.query<OccurrenceRow>(
        `SELECT ${occurrenceColumns()}
         FROM attachment_occurrences
         WHERE workspace_id = $1 AND owner_kind = $2 AND owner_id = $3
         ORDER BY ordinal, id`,
        [runRow.workspace_id, runRow.owner_kind, runRow.owner_id],
      );
      const provided = new Map(
        input.evidence.map((evidence) => [evidence.occurrenceId, evidence]),
      );
      if (provided.size !== occurrences.rows.length) {
        throw new Error(
          "Attachment preparation evidence does not match occurrences.",
        );
      }
      const terminalEvidence: AttachmentPreparationEvidenceRecord[] = [];
      for (const occurrenceRow of occurrences.rows) {
        const occurrence = toOccurrence(occurrenceRow);
        const evidence = provided.get(occurrence.id);
        if (evidence === undefined) {
          throw new Error(
            "Attachment preparation evidence does not match occurrences.",
          );
        }
        const persisted = await this.persistEvidence(
          client,
          runRow,
          occurrence,
          evidence,
        );
        terminalEvidence.push(persisted);
      }
      const terminalState = terminalEvidence.some(
        (evidence) => evidence.required && evidence.outcome !== "ready",
      )
        ? "failed"
        : "completed";
      const retryRequired = terminalEvidence.some(
        (evidence) => evidence.outcome !== "ready" && evidence.retryable,
      );
      const completed = await client.query<PreparationRunRow>(
        `UPDATE attachment_preparation_runs
         SET state = $1,
             lease_token = NULL,
             lease_expires_at = NULL,
             retry_required = $2,
             completed_at = NOW()
         WHERE workspace_id = $3
           AND id = $4
           AND state = 'claimed'
           AND lease_token = $5
           AND fencing_token = $6
           AND lease_expires_at > NOW()
         RETURNING ${runColumns()}`,
        [
          terminalState,
          retryRequired,
          input.workspaceId,
          input.runId,
          input.lease.token,
          input.lease.fencingToken.toString(),
        ],
      );
      const completedRun = completed.rows[0];
      if (completedRun === undefined) {
        throw new PostgresAttachmentPreparationClaimOwnershipError();
      }
      await client.query("COMMIT");
      return Object.freeze({
        run: toRun(completedRun),
        evidence: Object.freeze(terminalEvidence),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async findPreparationOutcome(input: {
    readonly workspaceId: string;
    readonly runId: string;
  }): Promise<AttachmentPreparationTerminalOutcome | undefined> {
    assertText(input.workspaceId, "workspace ID", 200);
    assertText(input.runId, "run ID", 200);
    const result = await this.pool.query<PreparationRunRow>(
      `SELECT ${runColumns()}
       FROM attachment_preparation_runs
       WHERE workspace_id = $1 AND id = $2
       LIMIT 1`,
      [input.workspaceId, input.runId],
    );
    const row = result.rows[0];
    if (
      row === undefined ||
      (row.state !== "completed" && row.state !== "failed")
    ) {
      return undefined;
    }
    return this.terminalOutcome(this.pool, row);
  }

  private async findRunForUpdate(
    client: PoolClient,
    input: AttachmentPreparationRunRequest,
  ): Promise<PreparationRunRow | undefined> {
    const result = await client.query<PreparationRunRow>(
      `SELECT ${runColumns()}
       FROM attachment_preparation_runs
       WHERE workspace_id = $1
         AND owner_kind = $2
         AND owner_id = $3
         AND preparation_identity_hash = $4
       FOR UPDATE`,
      [
        input.workspaceId,
        input.ownerKind,
        input.ownerId,
        input.preparationIdentityHash,
      ],
    );
    return result.rows[0];
  }

  /**
   * An occurrence must retain a connector, external-reference, and immutable
   * connector-configuration version from one workspace and one connector.
   * The foreign keys on occurrence rows prove workspace existence; this query
   * proves the otherwise cross-table provenance before the immutable insert.
   */
  private async assertOccurrenceProvenance(
    client: PoolClient,
    occurrence: AttachmentOccurrenceWrite,
  ): Promise<void> {
    const result = await client.query<OccurrenceProvenanceRow>(
      `SELECT connector.id AS connector_registration_id
       FROM connector_registrations AS connector
       JOIN external_references AS reference
         ON reference.workspace_id = connector.workspace_id
        AND reference.id = $3
        AND reference.connector_registration_id = connector.id
       JOIN administration_configurations AS configuration
         ON configuration.workspace_id = connector.workspace_id
        AND configuration.id = connector.id
        AND configuration.resource_type = 'connector-instances'
       JOIN administration_configuration_versions AS version
         ON version.workspace_id = configuration.workspace_id
        AND version.id = $4
        AND version.configuration_id = configuration.id
        AND version.descriptor_kind = 'connector'
       WHERE connector.workspace_id = $1
         AND connector.id = $2
       FOR KEY SHARE OF connector, reference, configuration, version`,
      [
        occurrence.workspaceId,
        occurrence.connectorRegistrationId,
        occurrence.attachmentReferenceId,
        occurrence.connectorConfigurationVersionId,
      ],
    );
    if (result.rows.length !== 1) {
      throw new Error("Attachment occurrence provenance is unavailable.");
    }
  }

  private async insertClaimedRun(
    client: PoolClient,
    input: AttachmentPreparationRunRequest,
  ): Promise<PreparationRunRow | undefined> {
    const token = `attachment-preparation-lease:${randomUUID()}`;
    const result = await client.query<PreparationRunRow>(
      `INSERT INTO attachment_preparation_runs (
         id, workspace_id, owner_kind, owner_id, attachment_policy_version_id,
         policy_identity_hash, preparation_identity_hash, state, lease_token,
         lease_expires_at, fencing_token
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, 'claimed', $8,
         NOW() + ($9 * INTERVAL '1 millisecond'), 1
       )
       ON CONFLICT (workspace_id, owner_kind, owner_id, preparation_identity_hash)
       DO NOTHING
       RETURNING ${runColumns()}`,
      [
        `attachment-preparation-run:${randomUUID()}`,
        input.workspaceId,
        input.ownerKind,
        input.ownerId,
        input.attachmentPolicyVersionId ?? null,
        input.policyIdentityHash,
        input.preparationIdentityHash,
        token,
        this.claimLeaseMs,
      ],
    );
    return result.rows[0];
  }

  private async claimExistingRun(
    client: PoolClient,
    existing: PreparationRunRow,
  ): Promise<PreparationRunRow | undefined> {
    const token = `attachment-preparation-lease:${randomUUID()}`;
    const result = await client.query<PreparationRunRow>(
      `UPDATE attachment_preparation_runs
       SET state = 'claimed',
           lease_token = $1,
           lease_expires_at = NOW() + ($2 * INTERVAL '1 millisecond'),
           fencing_token = fencing_token + 1
       WHERE workspace_id = $3
         AND id = $4
         AND state IN ('pending', 'claimed')
         AND (state = 'pending' OR lease_expires_at <= NOW())
       RETURNING ${runColumns()}`,
      [token, this.claimLeaseMs, existing.workspace_id, existing.id],
    );
    return result.rows[0];
  }

  private async persistEvidence(
    client: PoolClient,
    run: PreparationRunRow,
    occurrence: AttachmentOccurrenceRecord,
    evidence: AttachmentPreparationEvidenceWrite,
  ): Promise<AttachmentPreparationEvidenceRecord> {
    if (evidence.outcome === "ready") {
      const verified = await client.query<CompletedDerivativeRow>(
        `SELECT derivative.processor_version, derivative.output_content_hash
         FROM attachment_occurrences AS occurrence
         JOIN attachments AS attachment
           ON attachment.workspace_id = occurrence.workspace_id
          AND attachment.external_reference_id = occurrence.attachment_reference_id
          AND attachment.id = $3
          AND attachment.lifecycle = 'accepted'
          AND attachment.retention_state = 'active'
          AND attachment.content_hash IS NOT NULL
         JOIN attachment_derivative_sources AS source
           ON source.workspace_id = attachment.workspace_id
          AND source.attachment_id = attachment.id
          AND source.attachment_derivative_id = $4
         JOIN attachment_derivatives AS derivative
           ON derivative.workspace_id = source.workspace_id
          AND derivative.id = source.attachment_derivative_id
          AND derivative.status = 'completed'
          AND derivative.retention_state = 'active'
          AND derivative.output_mime_type = 'text/plain'
          AND derivative.content_hash = attachment.content_hash
         WHERE occurrence.workspace_id = $1
           AND occurrence.id = $2
           AND (
             NOT (occurrence.declared_metadata ? 'contentHash')
             OR occurrence.declared_metadata->>'contentHash' = attachment.content_hash
           )
         LIMIT 1`,
        [
          run.workspace_id,
          occurrence.id,
          evidence.attachmentId,
          evidence.derivativeId,
        ],
      );
      const derivative = verified.rows[0];
      if (
        derivative === undefined ||
        derivative.processor_version !== evidence.processorVersion ||
        derivative.output_content_hash !== evidence.outputContentHash
      ) {
        throw new Error(
          "Attachment preparation derivative evidence is not exact.",
        );
      }
      await client.query(
        `INSERT INTO attachment_preparation_evidence (
           workspace_id, attachment_preparation_run_id, attachment_occurrence_id,
           outcome, required, attachment_id, attachment_derivative_id,
           processor_version, output_content_hash, warning_code, retryable
         ) VALUES ($1, $2, $3, 'ready', $4, $5, $6, $7, $8, NULL, false)`,
        [
          run.workspace_id,
          run.id,
          occurrence.id,
          occurrence.required,
          evidence.attachmentId,
          evidence.derivativeId,
          evidence.processorVersion,
          evidence.outputContentHash,
        ],
      );
      return Object.freeze({
        occurrenceId: occurrence.id,
        outcome: "ready",
        required: occurrence.required,
        attachmentId: evidence.attachmentId,
        derivativeId: evidence.derivativeId,
        processorVersion: evidence.processorVersion,
        outputContentHash: evidence.outputContentHash,
      });
    }
    await client.query(
      `INSERT INTO attachment_preparation_evidence (
         workspace_id, attachment_preparation_run_id, attachment_occurrence_id,
         outcome, required, attachment_id, attachment_derivative_id,
         processor_version, output_content_hash, warning_code, retryable
       ) VALUES ($1, $2, $3, $4, $5, NULL, NULL, NULL, NULL, $6, $7)`,
      [
        run.workspace_id,
        run.id,
        occurrence.id,
        evidence.outcome,
        occurrence.required,
        evidence.warningCode,
        evidence.retryable,
      ],
    );
    return Object.freeze({
      occurrenceId: occurrence.id,
      outcome: evidence.outcome,
      required: occurrence.required,
      warningCode: evidence.warningCode,
      retryable: evidence.retryable,
    });
  }

  private async terminalOutcome(
    client: Pick<Pool, "query"> | PoolClient,
    row: PreparationRunRow,
  ): Promise<AttachmentPreparationTerminalOutcome> {
    const run = toRun(row);
    if (run.state !== "completed" && run.state !== "failed") {
      throw new Error("Attachment preparation run is not terminal.");
    }
    const occurrences = await client.query<OccurrenceRow>(
      `SELECT ${occurrenceColumns()}
       FROM attachment_occurrences
       WHERE workspace_id = $1 AND owner_kind = $2 AND owner_id = $3
       ORDER BY ordinal, id`,
      [run.workspaceId, run.ownerKind, run.ownerId],
    );
    const evidence = await client.query<PreparationEvidenceRow>(
      `SELECT
         attachment_occurrence_id, outcome, required, attachment_id,
         attachment_derivative_id, processor_version, output_content_hash,
         warning_code, retryable
       FROM attachment_preparation_evidence
       WHERE workspace_id = $1 AND attachment_preparation_run_id = $2
       ORDER BY attachment_occurrence_id`,
      [run.workspaceId, run.id],
    );
    if (evidence.rows.length !== occurrences.rows.length) {
      throw new Error(
        "Stored terminal attachment preparation evidence is incomplete.",
      );
    }
    const evidenceByOccurrence = new Map(
      evidence.rows.map((entry) => [entry.attachment_occurrence_id, entry]),
    );
    const coherentEvidence = occurrences.rows.map((occurrenceRow) => {
      const occurrence = toOccurrence(occurrenceRow);
      const evidenceRow = evidenceByOccurrence.get(occurrence.id);
      if (evidenceRow === undefined) {
        throw new Error(
          "Stored terminal attachment preparation evidence is incomplete.",
        );
      }
      const parsed = toEvidence(evidenceRow);
      if (parsed.required !== occurrence.required) {
        throw new Error(
          "Stored terminal attachment preparation evidence is incoherent.",
        );
      }
      return parsed;
    });
    return Object.freeze({
      run,
      evidence: Object.freeze(coherentEvidence),
    });
  }
}

function occurrenceColumns(): string {
  return `id, workspace_id, owner_kind, owner_id, connector_registration_id,
    connector_configuration_version_id, relation, ordinal, attachment_reference_id,
    declared_metadata, identity_hash, required`;
}

function runColumns(): string {
  return `id, workspace_id, owner_kind, owner_id, attachment_policy_version_id,
    policy_identity_hash, preparation_identity_hash, state, lease_token,
    lease_expires_at, fencing_token::text AS fencing_token, retry_required, completed_at`;
}

function claimedResult(row: PreparationRunRow): AttachmentPreparationClaim {
  const run = toRun(row);
  if (
    run.state !== "claimed" ||
    row.lease_token === null ||
    row.lease_expires_at === null
  ) {
    throw new Error("Attachment preparation run was not claimed.");
  }
  return Object.freeze({
    kind: "claimed",
    run,
    lease: Object.freeze({
      token: row.lease_token,
      fencingToken: run.fencingToken,
      expiresAt: row.lease_expires_at.toISOString(),
    }),
  });
}
