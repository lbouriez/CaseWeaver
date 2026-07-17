import { randomUUID } from "node:crypto";

import {
  type AttachmentOccurrenceDescriptor,
  type AttachmentPreparationAttempt,
  type AttachmentPreparationAttemptClaim,
  type AttachmentPreparationAttemptStore,
  type AttachmentPreparationOutcome,
  type AttachmentPreparationPolicy,
  type AttachmentPreparationResult,
  type AttachmentPreparationWarning,
  attachmentPreparationIdentityHash,
  type SelectedAttachmentDerivative,
  type ServerPrivateAttachmentOccurrenceEvidence,
  throwIfAttachmentAborted,
} from "@caseweaver/attachments";
import type { Pool, PoolClient, QueryResultRow } from "pg";

const maximumIdentifierLength = 1_024;
const maximumOccurrenceCount = 10_000;

type AttemptState = "claimed" | "completed";

interface AttemptRow extends QueryResultRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly subject_kind: string;
  readonly subject_id: string;
  readonly plan_identity_hash: string;
  readonly policy_mode: string;
  readonly policy_version: string;
  readonly access_policy_hash: string;
  readonly attempt_sequence: number;
  readonly retry_of_attempt_id: string | null;
  readonly state: AttemptState;
  readonly fence: string | null;
  readonly lease_expires_at: Date | null;
  readonly result_identity_hash: string | null;
  readonly result: unknown;
  readonly retry_required: boolean;
  readonly created_at: Date;
  readonly completed_at: Date | null;
}

interface AttemptOccurrenceRow extends QueryResultRow {
  readonly occurrence_identity: string;
  readonly owner_identity: string | null;
  readonly source_ordinal: number | null;
  readonly ordinal: number;
  readonly attachment_id: string;
  readonly relation: string;
  readonly required: boolean;
}

interface IdRow extends QueryResultRow {
  readonly id: string;
}

interface DerivativeEvidenceRow extends QueryResultRow {
  readonly id: string;
}

interface CompletedEvidenceRow extends QueryResultRow {
  readonly occurrence_identity: string;
  readonly attachment_id: string;
  readonly derivative_id: string;
  readonly derivative_identity: string;
  readonly derivative_content_hash: string;
}

export class PostgresAttachmentPreparationAttemptInProgressError extends Error {
  public readonly code = "attachmentPreparation.inProgress";
  public readonly retryable = true;

  public constructor() {
    super("Attachment preparation is already in progress.");
    this.name = "PostgresAttachmentPreparationAttemptInProgressError";
  }
}

export class PostgresAttachmentPreparationAttemptOwnershipError extends Error {
  public readonly code = "attachmentPreparation.attemptOwnership";
  public readonly retryable = false;

  public constructor() {
    super("Attachment preparation attempt ownership has expired or changed.");
    this.name = "PostgresAttachmentPreparationAttemptOwnershipError";
  }
}

export interface PostgresAttachmentPreparationAttemptStoreOptions {
  /**
   * Database time, rather than a worker clock, is authoritative for this
   * lease. The bounded value is used only as an interval operand in SQL.
   */
  readonly claimLeaseMilliseconds?: number;
  /** Trusted composition injects deterministic IDs for tests when required. */
  readonly nextId?: () => string;
}

/**
 * Durable, fenced storage for the stable attachment preparation port.
 *
 * Only safe terminal outcome data and immutable derivative identity evidence
 * cross into these tables. This adapter intentionally never stores derivative
 * text, a blob/storage handle, attachment locator, URL, source path, or a
 * connector/private reference. A completed cache hit consequently returns an
 * empty server-private derivative branch; downstream work must resolve its
 * already-pinned derivative evidence through its dedicated private reader.
 */
export class PostgresAttachmentPreparationAttemptStore
  implements AttachmentPreparationAttemptStore
{
  private readonly claimLeaseMilliseconds: number;
  private readonly nextId: () => string;

  public constructor(
    private readonly pool: Pool,
    options: PostgresAttachmentPreparationAttemptStoreOptions = {},
  ) {
    this.claimLeaseMilliseconds = positiveLease(
      options.claimLeaseMilliseconds ?? 15 * 60 * 1_000,
    );
    this.nextId = options.nextId ?? randomUUID;
  }

  public async claim(
    input: Parameters<AttachmentPreparationAttemptStore["claim"]>[0],
  ): Promise<AttachmentPreparationAttemptClaim> {
    const valid = validateClaimInput(input);
    throwIfAttachmentAborted(valid.signal);
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [
          attemptLockKey(
            valid.subject.workspaceId,
            valid.subject.kind,
            valid.subject.id,
            valid.planIdentity,
          ),
        ],
      );
      throwIfAttachmentAborted(valid.signal);

      const existing = await findLatestAttemptForUpdate(client, valid);
      if (existing === undefined) {
        const attempt = await this.insertClaimedAttempt(client, valid, 1);
        throwIfAttachmentAborted(valid.signal);
        await client.query("COMMIT");
        committed = true;
        return Object.freeze({ kind: "claimed", attempt });
      }

      assertAttemptMatchesClaim(existing, valid);
      if (existing.state === "completed") {
        const completed = completedResult(existing);
        if (!completed.outcome.retryRequired) {
          await client.query("COMMIT");
          committed = true;
          return Object.freeze({
            kind: "completed",
            attempt: completedAttemptReference(existing),
            result: completed,
          });
        }
        const attempt = await this.insertClaimedAttempt(
          client,
          valid,
          existing.attempt_sequence + 1,
          existing.id,
        );
        throwIfAttachmentAborted(valid.signal);
        await client.query("COMMIT");
        committed = true;
        return Object.freeze({ kind: "claimed", attempt });
      }

      claimedAttempt(existing);
      const reclaimed = await client.query<AttemptRow>(
        `UPDATE attachment_preparation_attempts
         SET fence = $1,
             lease_expires_at = statement_timestamp()
               + ($2 * INTERVAL '1 millisecond')
         WHERE workspace_id = $3
           AND id = $4
           AND state = 'claimed'
           AND lease_expires_at <= statement_timestamp()
         RETURNING ${attemptColumns()}`,
        [
          this.nextId(),
          this.claimLeaseMilliseconds,
          valid.subject.workspaceId,
          existing.id,
        ],
      );
      const row = reclaimed.rows[0];
      if (row === undefined) {
        throwIfAttachmentAborted(valid.signal);
        await client.query("COMMIT");
        committed = true;
        throw new PostgresAttachmentPreparationAttemptInProgressError();
      }
      const attempt = claimedAttempt(row);
      throwIfAttachmentAborted(valid.signal);
      await client.query("COMMIT");
      committed = true;
      return Object.freeze({ kind: "claimed", attempt });
    } catch (error) {
      if (!committed) await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async finalize(
    input: Parameters<AttachmentPreparationAttemptStore["finalize"]>[0],
  ): Promise<void> {
    const valid = validateFinalizeInput(input);
    throwIfAttachmentAborted(valid.signal);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const attempt = await claimedAttemptForFinalize(client, valid.attempt);
      if (attempt === undefined) {
        throw new PostgresAttachmentPreparationAttemptOwnershipError();
      }
      const persistedOccurrences = await attemptOccurrences(client, attempt);
      const evidence = safeEvidence(valid, persistedOccurrences);
      throwIfAttachmentAborted(valid.signal);

      for (const record of evidence) {
        if (record.outcome === "ready") {
          const inserted = await client.query<DerivativeEvidenceRow>(
            `INSERT INTO attachment_preparation_attempt_evidence (
               workspace_id, attempt_id, occurrence_identity, outcome,
               derivative_id, derivative_identity, derivative_content_hash,
               warning_code, warning_retryable
             )
             SELECT $1, $2, $3, 'ready', $4, $5, $6, NULL, NULL
             WHERE EXISTS (
               SELECT 1
               FROM attachment_derivatives
               WHERE workspace_id = $1
                 AND id = $4
                 AND status = 'completed'
                 AND identity_key = $5
                 AND output_content_hash = $6
                 AND EXISTS (
                   SELECT 1
                   FROM attachment_preparation_attempt_occurrences AS occurrence
                   INNER JOIN attachment_derivative_sources AS source
                     ON source.workspace_id = occurrence.workspace_id
                    AND source.attachment_id = occurrence.attachment_id
                    AND source.attachment_derivative_id = $4
                   WHERE occurrence.workspace_id = $1
                     AND occurrence.attempt_id = $2
                     AND occurrence.occurrence_identity = $3
                 )
             )
             RETURNING attempt_id AS id`,
            [
              attempt.workspace_id,
              attempt.id,
              record.occurrenceIdentity,
              record.derivativeId,
              record.derivativeIdentity,
              record.derivativeContentHash,
            ],
          );
          if (inserted.rows.length !== 1) {
            throw new Error(
              "Attachment preparation selected derivative is not durable evidence.",
            );
          }
        } else {
          await client.query(
            `INSERT INTO attachment_preparation_attempt_evidence (
               workspace_id, attempt_id, occurrence_identity, outcome,
               derivative_id, derivative_identity, derivative_content_hash,
               warning_code, warning_retryable
             ) VALUES ($1, $2, $3, 'unavailable', NULL, NULL, NULL, $4, $5)`,
            [
              attempt.workspace_id,
              attempt.id,
              record.occurrenceIdentity,
              record.warningCode,
              record.warningRetryable,
            ],
          );
        }
      }

      const serializedOutcome = JSON.stringify(
        safeOutcome(valid.result.outcome),
      );
      const completed = await client.query<IdRow>(
        `UPDATE attachment_preparation_attempts
         SET state = 'completed',
             fence = NULL,
             lease_expires_at = NULL,
             result_identity_hash = $1,
             result = $2::jsonb,
             retry_required = $3,
             completed_at = statement_timestamp()
         WHERE workspace_id = $4
           AND id = $5
           AND state = 'claimed'
           AND fence = $6
           AND lease_expires_at > statement_timestamp()
           AND policy_mode = $7
           AND policy_version = $8
           AND access_policy_hash = $9
         RETURNING id`,
        [
          valid.result.outcome.identityHash,
          serializedOutcome,
          valid.result.outcome.retryRequired,
          attempt.workspace_id,
          attempt.id,
          valid.attempt.fence,
          valid.result.outcome.policy.mode,
          valid.result.outcome.policy.policyVersion,
          valid.result.outcome.policy.accessPolicyHash,
        ],
      );
      if (completed.rows.length !== 1) {
        throw new PostgresAttachmentPreparationAttemptOwnershipError();
      }
      throwIfAttachmentAborted(valid.signal);
      await client.query("COMMIT");
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Private cache-rehydration evidence for one completed, fenced attempt.
   * It contains no locator, object key, path, filename, content, or public
   * source reference. Trusted worker composition must independently verify
   * each returned derivative through the retention-aware evidence reader.
   */
  public async completedDerivativeEvidence(input: {
    readonly workspaceId: string;
    readonly attemptId: string;
    readonly subject: Readonly<{
      readonly kind: "sourceDocument" | "caseCapture";
      readonly id: string;
    }>;
  }): Promise<
    readonly Readonly<{
      readonly occurrenceIdentity: string;
      readonly attachmentId: string;
      readonly derivativeId: string;
      readonly derivativeIdentity: string;
      readonly derivativeContentHash: string;
    }>[]
  > {
    assertIdentifier(input.workspaceId, "workspace ID");
    assertIdentifier(input.attemptId, "attachment preparation attempt ID");
    if (
      input.subject.kind !== "sourceDocument" &&
      input.subject.kind !== "caseCapture"
    ) {
      throw new Error("Attachment preparation evidence subject is invalid.");
    }
    assertIdentifier(
      input.subject.id,
      "attachment preparation evidence subject",
    );
    const result = await this.pool.query<CompletedEvidenceRow>(
      `SELECT occurrence.occurrence_identity,
              occurrence.attachment_id,
              evidence.derivative_id,
              evidence.derivative_identity,
              evidence.derivative_content_hash
         FROM attachment_preparation_attempts AS attempt
         INNER JOIN attachment_preparation_attempt_occurrences AS occurrence
           ON occurrence.workspace_id = attempt.workspace_id
          AND occurrence.attempt_id = attempt.id
         INNER JOIN attachment_preparation_attempt_evidence AS evidence
           ON evidence.workspace_id = occurrence.workspace_id
          AND evidence.attempt_id = occurrence.attempt_id
          AND evidence.occurrence_identity = occurrence.occurrence_identity
        WHERE attempt.workspace_id = $1
          AND attempt.id = $2
          AND attempt.subject_kind = $3
          AND attempt.subject_id = $4
          AND attempt.state = 'completed'
          AND evidence.outcome = 'ready'
          AND evidence.derivative_id IS NOT NULL
          AND evidence.derivative_identity IS NOT NULL
          AND evidence.derivative_content_hash IS NOT NULL
        ORDER BY occurrence.ordinal, occurrence.occurrence_identity`,
      [
        input.workspaceId,
        input.attemptId,
        input.subject.kind,
        input.subject.id,
      ],
    );
    try {
      return Object.freeze(
        result.rows.map((row) => {
          assertIdentifier(row.occurrence_identity, "occurrence identity");
          assertIdentifier(row.attachment_id, "attachment ID");
          assertIdentifier(row.derivative_id, "derivative ID");
          assertIdentifier(row.derivative_identity, "derivative identity");
          assertHash(row.derivative_content_hash, "derivative content hash");
          return Object.freeze({
            occurrenceIdentity: row.occurrence_identity,
            attachmentId: row.attachment_id,
            derivativeId: row.derivative_id,
            derivativeIdentity: row.derivative_identity,
            derivativeContentHash: row.derivative_content_hash,
          });
        }),
      );
    } catch {
      throw new Error("Attachment preparation evidence is unavailable.");
    }
  }

  private async insertClaimedAttempt(
    client: PoolClient,
    input: ValidClaimInput,
    sequence: number,
    retryOfAttemptId?: string,
  ): Promise<AttachmentPreparationAttempt> {
    const id = this.nextId();
    const fence = this.nextId();
    const inserted = await client.query<AttemptRow>(
      `INSERT INTO attachment_preparation_attempts (
         id, workspace_id, subject_kind, subject_id, plan_identity_hash,
         policy_mode, policy_version, access_policy_hash, attempt_sequence,
         retry_of_attempt_id, state, fence, lease_expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'claimed', $11,
         statement_timestamp() + ($12 * INTERVAL '1 millisecond')
       )
       RETURNING ${attemptColumns()}`,
      [
        id,
        input.subject.workspaceId,
        input.subject.kind,
        input.subject.id,
        input.planIdentity,
        input.policy.mode,
        input.policy.policyVersion,
        input.policy.accessPolicyHash,
        sequence,
        retryOfAttemptId ?? null,
        fence,
        this.claimLeaseMilliseconds,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error("Attachment preparation attempt was not retained.");
    }
    for (const occurrence of input.occurrences) {
      await client.query(
        `INSERT INTO attachment_preparation_attempt_occurrences (
           workspace_id, attempt_id, occurrence_identity, owner_identity,
           source_ordinal, ordinal, attachment_id, relation, required
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.subject.workspaceId,
          row.id,
          occurrence.identity,
          occurrence.ownerIdentity ?? null,
          occurrence.sourceOrdinal ?? null,
          occurrence.ordinal,
          occurrence.attachmentId,
          occurrence.relation,
          occurrence.required,
        ],
      );
    }
    return claimedAttempt(row);
  }
}

interface ValidClaimInput {
  readonly subject: Readonly<{
    readonly workspaceId: string;
    readonly kind: "sourceDocument" | "caseCapture";
    readonly id: string;
  }>;
  readonly policy: AttachmentPreparationPolicy;
  readonly planIdentity: string;
  readonly occurrences: readonly AttachmentOccurrenceDescriptor[];
  readonly signal: AbortSignal;
}

interface ValidFinalizeInput {
  readonly attempt: AttachmentPreparationAttempt;
  readonly result: AttachmentPreparationResult;
  readonly evidence: readonly ServerPrivateAttachmentOccurrenceEvidence[];
  readonly signal: AbortSignal;
}

type SafeEvidence =
  | Readonly<{
      readonly outcome: "ready";
      readonly occurrenceIdentity: string;
      readonly derivativeId: string;
      readonly derivativeIdentity: string;
      readonly derivativeContentHash: string;
    }>
  | Readonly<{
      readonly outcome: "unavailable";
      readonly occurrenceIdentity: string;
      readonly warningCode: string;
      readonly warningRetryable: boolean;
    }>;

function validateClaimInput(
  input: Parameters<AttachmentPreparationAttemptStore["claim"]>[0],
): ValidClaimInput {
  const subject = input.subject;
  assertIdentifier(subject.workspaceId, "workspace ID");
  if (subject.kind !== "sourceDocument" && subject.kind !== "caseCapture") {
    throw new RangeError("Attachment preparation subject kind is invalid.");
  }
  assertIdentifier(subject.id, "subject ID");
  assertHash(input.planIdentity, "plan identity");
  const policy = validPolicy(input.policy);
  if (
    !Array.isArray(input.occurrences) ||
    input.occurrences.length > maximumOccurrenceCount
  ) {
    throw new RangeError("Attachment preparation occurrences are invalid.");
  }
  const identities = new Set<string>();
  const ordinals = new Set<number>();
  const occurrences = input.occurrences.map((occurrence) => {
    assertIdentifier(occurrence.identity, "occurrence identity");
    if (occurrence.ownerIdentity !== undefined) {
      assertIdentifier(occurrence.ownerIdentity, "occurrence owner identity");
    }
    assertIdentifier(occurrence.attachmentId, "occurrence attachment");
    assertIdentifier(occurrence.relation, "occurrence relation");
    if (!Number.isSafeInteger(occurrence.ordinal) || occurrence.ordinal < 0) {
      throw new RangeError(
        "Attachment preparation occurrence ordinal is invalid.",
      );
    }
    if (
      occurrence.sourceOrdinal !== undefined &&
      (!Number.isSafeInteger(occurrence.sourceOrdinal) ||
        occurrence.sourceOrdinal < 0)
    ) {
      throw new RangeError(
        "Attachment preparation occurrence source ordinal is invalid.",
      );
    }
    if (typeof occurrence.required !== "boolean") {
      throw new RangeError(
        "Attachment preparation occurrence required flag is invalid.",
      );
    }
    if (
      identities.has(occurrence.identity) ||
      ordinals.has(occurrence.ordinal)
    ) {
      throw new RangeError(
        "Attachment preparation occurrences must have unique identities and ordinals.",
      );
    }
    identities.add(occurrence.identity);
    ordinals.add(occurrence.ordinal);
    return Object.freeze({
      identity: occurrence.identity,
      ...(occurrence.ownerIdentity === undefined
        ? {}
        : { ownerIdentity: occurrence.ownerIdentity }),
      ...(occurrence.sourceOrdinal === undefined
        ? {}
        : { sourceOrdinal: occurrence.sourceOrdinal }),
      ordinal: occurrence.ordinal,
      attachmentId: occurrence.attachmentId,
      relation: occurrence.relation,
      required: occurrence.required,
    });
  });
  return Object.freeze({
    subject: Object.freeze({
      workspaceId: subject.workspaceId,
      kind: subject.kind,
      id: subject.id,
    }),
    policy,
    planIdentity: input.planIdentity,
    occurrences: Object.freeze([...occurrences]),
    signal: input.signal,
  });
}

function validateFinalizeInput(
  input: Parameters<AttachmentPreparationAttemptStore["finalize"]>[0],
): ValidFinalizeInput {
  assertIdentifier(input.attempt.id, "attempt ID");
  assertIdentifier(input.attempt.fence, "attempt fence");
  assertHash(input.attempt.planIdentity, "attempt plan identity");
  if (input.attempt.retryOfAttemptId !== undefined) {
    assertIdentifier(input.attempt.retryOfAttemptId, "retry attempt ID");
  }
  const outcome = validOutcome(input.result.outcome);
  if (
    !Array.isArray(input.evidence) ||
    input.evidence.length > maximumOccurrenceCount
  ) {
    throw new RangeError("Attachment preparation evidence is invalid.");
  }
  return Object.freeze({
    attempt: Object.freeze({
      id: input.attempt.id,
      fence: input.attempt.fence,
      planIdentity: input.attempt.planIdentity,
      ...(input.attempt.retryOfAttemptId === undefined
        ? {}
        : { retryOfAttemptId: input.attempt.retryOfAttemptId }),
    }),
    result: Object.freeze({ outcome, derivatives: Object.freeze([]) }),
    evidence: Object.freeze([...input.evidence]),
    signal: input.signal,
  });
}

function validPolicy(
  policy: AttachmentPreparationPolicy,
): AttachmentPreparationPolicy {
  if (
    policy.mode !== "disabled" &&
    policy.mode !== "optional" &&
    policy.mode !== "required"
  ) {
    throw new RangeError("Attachment preparation policy mode is invalid.");
  }
  assertIdentifier(policy.policyVersion, "policy version");
  assertHash(policy.accessPolicyHash, "access policy hash");
  return Object.freeze({
    mode: policy.mode,
    policyVersion: policy.policyVersion,
    accessPolicyHash: policy.accessPolicyHash,
  });
}

function validOutcome(
  outcome: AttachmentPreparationOutcome,
): AttachmentPreparationOutcome {
  if (outcome.status !== "prepared" && outcome.status !== "terminal") {
    throw new RangeError("Attachment preparation outcome status is invalid.");
  }
  assertHash(outcome.identityHash, "result identity hash");
  const policy = validPolicy(outcome.policy);
  if (
    !Array.isArray(outcome.selectedDerivatives) ||
    !Array.isArray(outcome.warnings)
  ) {
    throw new RangeError("Attachment preparation result is invalid.");
  }
  if (typeof outcome.retryRequired !== "boolean") {
    throw new RangeError(
      "Attachment preparation retry-required flag is invalid.",
    );
  }
  const selectedDerivatives = outcome.selectedDerivatives.map(
    validSelectedDerivative,
  );
  const warnings = outcome.warnings.map(validWarning);
  const selectedKeys = new Set<string>();
  const warningKeys = new Set<string>();
  for (const selected of selectedDerivatives) {
    if (selectedKeys.has(selected.occurrenceIdentity)) {
      throw new RangeError(
        "Attachment preparation has multiple selected derivatives for one occurrence.",
      );
    }
    selectedKeys.add(selected.occurrenceIdentity);
  }
  for (const warning of warnings) {
    if (warning.occurrenceIdentity === undefined) {
      throw new RangeError(
        "Attachment preparation warnings must identify an occurrence.",
      );
    }
    if (
      warningKeys.has(warning.occurrenceIdentity) ||
      selectedKeys.has(warning.occurrenceIdentity)
    ) {
      throw new RangeError(
        "Attachment preparation has conflicting occurrence evidence.",
      );
    }
    warningKeys.add(warning.occurrenceIdentity);
  }
  if (
    policy.mode === "disabled" &&
    (selectedDerivatives.length !== 0 || warnings.length !== 0)
  ) {
    throw new RangeError(
      "Disabled attachment preparation cannot have evidence.",
    );
  }
  const expectedStatus =
    policy.mode === "required" && warnings.length > 0 ? "terminal" : "prepared";
  if (outcome.status !== expectedStatus) {
    throw new RangeError(
      "Attachment preparation outcome status does not match its policy.",
    );
  }
  const retryRequired = warnings.some((warning) => warning.retryable);
  if (outcome.retryRequired !== retryRequired) {
    throw new RangeError(
      "Attachment preparation retry-required flag does not match warnings.",
    );
  }
  if (
    outcome.identityHash !==
    attachmentPreparationIdentityHash({
      policy,
      selectedDerivatives,
      warnings,
    })
  ) {
    throw new RangeError(
      "Attachment preparation result identity hash is invalid.",
    );
  }
  return Object.freeze({
    status: outcome.status,
    identityHash: outcome.identityHash,
    policy,
    selectedDerivatives: Object.freeze(selectedDerivatives),
    warnings: Object.freeze(warnings),
    retryRequired: outcome.retryRequired,
  });
}

function validSelectedDerivative(
  derivative: SelectedAttachmentDerivative,
): SelectedAttachmentDerivative {
  assertIdentifier(
    derivative.occurrenceIdentity,
    "selected occurrence identity",
  );
  assertIdentifier(
    derivative.derivativeIdentity,
    "selected derivative identity",
  );
  assertHash(
    derivative.derivativeContentHash,
    "selected derivative content hash",
  );
  return Object.freeze({
    occurrenceIdentity: derivative.occurrenceIdentity,
    derivativeIdentity: derivative.derivativeIdentity,
    derivativeContentHash: derivative.derivativeContentHash,
  });
}

function validWarning(
  warning: AttachmentPreparationWarning,
): AttachmentPreparationWarning {
  if (warning.kind !== "attachmentPreparationWarning") {
    throw new RangeError("Attachment preparation warning kind is invalid.");
  }
  if (
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(warning.code) ||
    warning.code.length > 200
  ) {
    throw new RangeError("Attachment preparation warning code is invalid.");
  }
  if (typeof warning.retryable !== "boolean") {
    throw new RangeError(
      "Attachment preparation warning retryable flag is invalid.",
    );
  }
  if (warning.occurrenceIdentity !== undefined) {
    assertIdentifier(warning.occurrenceIdentity, "warning occurrence identity");
  }
  return Object.freeze({
    kind: "attachmentPreparationWarning",
    code: warning.code,
    retryable: warning.retryable,
    ...(warning.occurrenceIdentity === undefined
      ? {}
      : { occurrenceIdentity: warning.occurrenceIdentity }),
  });
}

function assertIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumIdentifierLength ||
    value.includes("\u0000") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new RangeError(`Attachment preparation ${label} is invalid.`);
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new RangeError(`Attachment preparation ${label} is invalid.`);
  }
}

function positiveLease(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60 * 60 * 1_000) {
    throw new RangeError(
      "Attachment preparation claim lease duration is invalid.",
    );
  }
  return value;
}

function attemptLockKey(
  workspaceId: string,
  subjectKind: string,
  subjectId: string,
  planIdentity: string,
): string {
  return `attachment-preparation:${workspaceId}:${subjectKind}:${subjectId}:${planIdentity}`;
}

function attemptColumns(): string {
  return `id, workspace_id, subject_kind, subject_id, plan_identity_hash,
          policy_mode, policy_version, access_policy_hash, attempt_sequence,
          retry_of_attempt_id, state, fence, lease_expires_at,
          result_identity_hash, result, retry_required, created_at, completed_at`;
}

async function findLatestAttemptForUpdate(
  client: PoolClient,
  input: ValidClaimInput,
): Promise<AttemptRow | undefined> {
  const result = await client.query<AttemptRow>(
    `SELECT ${attemptColumns()}
     FROM attachment_preparation_attempts
     WHERE workspace_id = $1
       AND subject_kind = $2
       AND subject_id = $3
       AND plan_identity_hash = $4
     ORDER BY attempt_sequence DESC
     LIMIT 1
     FOR UPDATE`,
    [
      input.subject.workspaceId,
      input.subject.kind,
      input.subject.id,
      input.planIdentity,
    ],
  );
  return result.rows[0];
}

function assertAttemptMatchesClaim(
  row: AttemptRow,
  input: ValidClaimInput,
): void {
  if (
    (row.state !== "claimed" && row.state !== "completed") ||
    !Number.isSafeInteger(row.attempt_sequence) ||
    row.attempt_sequence < 1 ||
    typeof row.retry_required !== "boolean"
  ) {
    throw new Error("Stored attachment preparation attempt is invalid.");
  }
  assertIdentifier(row.id, "stored attempt ID");
  if (row.retry_of_attempt_id !== null) {
    assertIdentifier(row.retry_of_attempt_id, "stored retry attempt ID");
  }
  if (
    row.workspace_id !== input.subject.workspaceId ||
    row.subject_kind !== input.subject.kind ||
    row.subject_id !== input.subject.id ||
    row.plan_identity_hash !== input.planIdentity ||
    row.policy_mode !== input.policy.mode ||
    row.policy_version !== input.policy.policyVersion ||
    row.access_policy_hash !== input.policy.accessPolicyHash
  ) {
    throw new Error(
      "Attachment preparation attempt conflicts with its immutable plan.",
    );
  }
}

function claimedAttempt(row: AttemptRow): AttachmentPreparationAttempt {
  if (
    row.state !== "claimed" ||
    row.fence === null ||
    row.lease_expires_at === null ||
    row.result !== null ||
    row.result_identity_hash !== null ||
    row.completed_at !== null ||
    row.retry_required !== false
  ) {
    throw new Error("Stored attachment preparation claim is invalid.");
  }
  assertIdentifier(row.id, "stored attempt ID");
  assertIdentifier(row.fence, "stored attempt fence");
  assertHash(row.plan_identity_hash, "stored plan identity");
  if (
    !(row.lease_expires_at instanceof Date) ||
    Number.isNaN(row.lease_expires_at.getTime())
  ) {
    throw new Error("Stored attachment preparation lease is invalid.");
  }
  if (row.retry_of_attempt_id !== null)
    assertIdentifier(row.retry_of_attempt_id, "stored retry attempt ID");
  return Object.freeze({
    id: row.id,
    fence: row.fence,
    planIdentity: row.plan_identity_hash,
    ...(row.retry_of_attempt_id === null
      ? {}
      : { retryOfAttemptId: row.retry_of_attempt_id }),
  });
}

function completedAttemptReference(
  row: AttemptRow,
): Readonly<{ readonly id: string; readonly planIdentity: string }> {
  if (row.state !== "completed") {
    throw new Error("Stored attachment preparation completion is invalid.");
  }
  assertIdentifier(row.id, "stored attempt ID");
  assertHash(row.plan_identity_hash, "stored plan identity");
  return Object.freeze({ id: row.id, planIdentity: row.plan_identity_hash });
}

function completedResult(row: AttemptRow): AttachmentPreparationResult {
  if (
    row.state !== "completed" ||
    row.fence !== null ||
    row.lease_expires_at !== null ||
    row.result_identity_hash === null ||
    row.result === null ||
    row.completed_at === null
  ) {
    throw new Error("Stored attachment preparation completion is invalid.");
  }
  assertHash(row.result_identity_hash, "stored result identity hash");
  if (
    !(row.completed_at instanceof Date) ||
    Number.isNaN(row.completed_at.getTime())
  ) {
    throw new Error(
      "Stored attachment preparation completion timestamp is invalid.",
    );
  }
  const outcome = validOutcome(storedOutcome(row.result));
  if (
    outcome.identityHash !== row.result_identity_hash ||
    outcome.retryRequired !== row.retry_required
  ) {
    throw new Error(
      "Stored attachment preparation result conflicts with immutable state.",
    );
  }
  return Object.freeze({ outcome, derivatives: Object.freeze([]) });
}

function storedOutcome(value: unknown): AttachmentPreparationOutcome {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw new Error("Stored attachment preparation result is invalid.");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    "identityHash",
    "policy",
    "retryRequired",
    "selectedDerivatives",
    "status",
    "warnings",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error(
      "Stored attachment preparation result has unexpected fields.",
    );
  }
  assertExactRecordKeys(
    record.policy,
    ["accessPolicyHash", "mode", "policyVersion"],
    "policy",
  );
  if (
    !Array.isArray(record.selectedDerivatives) ||
    !Array.isArray(record.warnings)
  ) {
    throw new Error("Stored attachment preparation result is invalid.");
  }
  for (const selected of record.selectedDerivatives) {
    assertExactRecordKeys(
      selected,
      ["derivativeContentHash", "derivativeIdentity", "occurrenceIdentity"],
      "selected derivative",
    );
  }
  for (const warning of record.warnings) {
    const warningRecord = strictRecord(warning, "warning");
    const warningKeys = Object.keys(warningRecord).sort();
    const allowed =
      "occurrenceIdentity" in warningRecord
        ? ["code", "kind", "occurrenceIdentity", "retryable"]
        : ["code", "kind", "retryable"];
    if (
      warningKeys.length !== allowed.length ||
      warningKeys.some((key, index) => key !== allowed[index])
    ) {
      throw new Error(
        "Stored attachment preparation warning has unexpected fields.",
      );
    }
  }
  return record as unknown as AttachmentPreparationOutcome;
}

function assertExactRecordKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): void {
  const record = strictRecord(value, label);
  const keys = Object.keys(record).sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error(
      `Stored attachment preparation ${label} has unexpected fields.`,
    );
  }
}

function strictRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`Stored attachment preparation ${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

async function claimedAttemptForFinalize(
  client: PoolClient,
  input: AttachmentPreparationAttempt,
): Promise<AttemptRow | undefined> {
  const result = await client.query<AttemptRow>(
    `SELECT ${attemptColumns()}
     FROM attachment_preparation_attempts
     WHERE id = $1
       AND plan_identity_hash = $2
       AND state = 'claimed'
       AND fence = $3
       AND lease_expires_at > statement_timestamp()
     FOR UPDATE`,
    [input.id, input.planIdentity, input.fence],
  );
  const row = result.rows[0];
  if (row !== undefined) claimedAttempt(row);
  return row;
}

async function attemptOccurrences(
  client: PoolClient,
  attempt: AttemptRow,
): Promise<readonly AttachmentOccurrenceDescriptor[]> {
  const result = await client.query<AttemptOccurrenceRow>(
    `SELECT occurrence_identity, owner_identity, source_ordinal, ordinal,
            attachment_id, relation, required
     FROM attachment_preparation_attempt_occurrences
     WHERE workspace_id = $1 AND attempt_id = $2
     ORDER BY ordinal, occurrence_identity
     FOR KEY SHARE`,
    [attempt.workspace_id, attempt.id],
  );
  return Object.freeze(
    result.rows.map((row) => {
      assertIdentifier(row.occurrence_identity, "stored occurrence identity");
      if (row.owner_identity !== null) {
        assertIdentifier(
          row.owner_identity,
          "stored occurrence owner identity",
        );
      }
      assertIdentifier(row.attachment_id, "stored occurrence attachment");
      assertIdentifier(row.relation, "stored occurrence relation");
      if (
        !Number.isSafeInteger(row.ordinal) ||
        row.ordinal < 0 ||
        (row.source_ordinal !== null &&
          (!Number.isSafeInteger(row.source_ordinal) ||
            row.source_ordinal < 0)) ||
        typeof row.required !== "boolean"
      ) {
        throw new Error("Stored attachment preparation occurrence is invalid.");
      }
      return Object.freeze({
        identity: row.occurrence_identity,
        ...(row.owner_identity === null
          ? {}
          : { ownerIdentity: row.owner_identity }),
        ...(row.source_ordinal === null
          ? {}
          : { sourceOrdinal: row.source_ordinal }),
        ordinal: row.ordinal,
        attachmentId: row.attachment_id,
        relation: row.relation,
        required: row.required,
      });
    }),
  );
}

function safeEvidence(
  input: ValidFinalizeInput,
  occurrences: readonly AttachmentOccurrenceDescriptor[],
): readonly SafeEvidence[] {
  if (input.result.outcome.policy.mode === "disabled") {
    if (
      input.result.outcome.selectedDerivatives.length !== 0 ||
      input.result.outcome.warnings.length !== 0 ||
      input.evidence.length !== 0
    ) {
      throw new Error(
        "Disabled attachment preparation cannot retain terminal evidence.",
      );
    }
    return Object.freeze([]);
  }
  const known = new Map(
    occurrences.map((occurrence) => [occurrence.identity, occurrence]),
  );
  const evidenceByOccurrence = new Map<
    string,
    ServerPrivateAttachmentOccurrenceEvidence
  >();
  for (const evidence of input.evidence) {
    assertIdentifier(
      evidence.occurrence.identity,
      "evidence occurrence identity",
    );
    if (evidenceByOccurrence.has(evidence.occurrence.identity)) {
      throw new RangeError(
        "Attachment preparation evidence repeats an occurrence.",
      );
    }
    const expected = known.get(evidence.occurrence.identity);
    if (
      expected === undefined ||
      expected.ownerIdentity !== evidence.occurrence.ownerIdentity ||
      expected.sourceOrdinal !== evidence.occurrence.sourceOrdinal ||
      expected.ordinal !== evidence.occurrence.ordinal ||
      expected.attachmentId !== evidence.occurrence.attachmentId ||
      expected.relation !== evidence.occurrence.relation ||
      expected.required !== evidence.occurrence.required
    ) {
      throw new Error(
        "Attachment preparation evidence does not match the immutable occurrence.",
      );
    }
    evidenceByOccurrence.set(evidence.occurrence.identity, evidence);
  }

  const records: SafeEvidence[] = [];
  const handled = new Set<string>();
  for (const selected of input.result.outcome.selectedDerivatives) {
    const evidence = evidenceByOccurrence.get(selected.occurrenceIdentity);
    if (
      evidence === undefined ||
      evidence.derivative.identity.key !== selected.derivativeIdentity ||
      evidence.derivative.outputContentHash !== selected.derivativeContentHash
    ) {
      throw new Error(
        "Attachment preparation selected derivative evidence is invalid.",
      );
    }
    handled.add(selected.occurrenceIdentity);
    records.push(
      Object.freeze({
        outcome: "ready" as const,
        occurrenceIdentity: selected.occurrenceIdentity,
        derivativeId: evidence.derivative.id,
        derivativeIdentity: selected.derivativeIdentity,
        derivativeContentHash: selected.derivativeContentHash,
      }),
    );
  }
  for (const warning of input.result.outcome.warnings) {
    const occurrenceIdentity = warning.occurrenceIdentity;
    if (occurrenceIdentity === undefined || handled.has(occurrenceIdentity)) {
      throw new Error("Attachment preparation warning evidence is invalid.");
    }
    handled.add(occurrenceIdentity);
    records.push(
      Object.freeze({
        outcome: "unavailable" as const,
        occurrenceIdentity,
        warningCode: warning.code,
        warningRetryable: warning.retryable,
      }),
    );
  }
  if (handled.size !== known.size || records.length !== known.size) {
    throw new Error(
      "Attachment preparation result does not cover every immutable occurrence.",
    );
  }
  return Object.freeze(
    records.sort((left, right) =>
      left.occurrenceIdentity.localeCompare(right.occurrenceIdentity),
    ),
  );
}

function safeOutcome(
  outcome: AttachmentPreparationOutcome,
): AttachmentPreparationOutcome {
  return Object.freeze({
    status: outcome.status,
    identityHash: outcome.identityHash,
    policy: Object.freeze({
      mode: outcome.policy.mode,
      policyVersion: outcome.policy.policyVersion,
      accessPolicyHash: outcome.policy.accessPolicyHash,
    }),
    selectedDerivatives: Object.freeze(
      outcome.selectedDerivatives.map((selected) =>
        Object.freeze({
          occurrenceIdentity: selected.occurrenceIdentity,
          derivativeIdentity: selected.derivativeIdentity,
          derivativeContentHash: selected.derivativeContentHash,
        }),
      ),
    ),
    warnings: Object.freeze(
      outcome.warnings.map((warning) =>
        Object.freeze({
          kind: "attachmentPreparationWarning" as const,
          code: warning.code,
          retryable: warning.retryable,
          ...(warning.occurrenceIdentity === undefined
            ? {}
            : { occurrenceIdentity: warning.occurrenceIdentity }),
        }),
      ),
    ),
    retryRequired: outcome.retryRequired,
  });
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original persistence failure. A connection released after a
    // failed rollback is discarded by pg when it is no longer usable.
  }
}
