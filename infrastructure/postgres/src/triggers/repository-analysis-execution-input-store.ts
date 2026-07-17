import { createHash, randomUUID } from "node:crypto";

import {
  type AnalysisProfile,
  analysisProfileSchema,
  createPreparedAttachmentEvidenceIdentity,
  type PreparedAttachmentEvidence,
  type PreparedAttachmentEvidenceSet,
  type RepositoryRunPin,
  validatePreparedAttachmentEvidence,
} from "@caseweaver/analysis";
import type { EnvelopeFor } from "@caseweaver/domain";
import type { Prisma, PrismaClient } from "@prisma/client";

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu;
const defaultLeaseMilliseconds = 5 * 60_000;

type JsonObject = Readonly<Record<string, Prisma.JsonValue>>;

export interface RepositoryAnalysisRecipeExecutionRow {
  readonly request_id: string;
  readonly workspace_id: string;
  readonly case_snapshot_id: string | null;
  readonly analysis_profile_version_id: string;
  readonly analysis_trigger_version_id: string;
  readonly trigger_id: string;
  readonly connector_registration_id: string;
  readonly connector_configuration_version_id: string;
  readonly profile_definition: Prisma.JsonValue;
  readonly recipe_version_id: string;
  readonly recipe_profile_version_id: string;
  readonly analysis_binding_version_id: string;
  readonly retrieval_profile_version_id: string | null;
  readonly attachment_policy_version_id: string | null;
  readonly attachment_stage_mode: string;
  readonly code_repository_version_id: string | null;
  readonly repository_execution_policy_version_id: string | null;
  readonly repository_stage_mode: string;
  readonly repository_id: string | null;
  readonly execution_policy_id: string | null;
  readonly repository_agent_binding_version_id: string | null;
}

interface InputRow {
  readonly id: string;
  readonly state: string;
  readonly lease_token: string | null;
  readonly lease_expires_at: Date | null;
  readonly fencing_token: bigint;
  readonly error_retryable: boolean | null;
  readonly lease_live: boolean;
}

interface SnapshotAttachmentEvidenceRow {
  readonly occurrence_identity: string | null;
  readonly attachment_id: string;
  readonly attachment_derivative_id: string;
  readonly output_content_hash: string;
}

interface StableAttemptAttachmentEvidenceRow {
  readonly occurrence_identity: string;
  readonly attachment_id: string;
  readonly outcome: "ready" | "unavailable";
  readonly required: boolean;
  readonly attachment_derivative_id: string | null;
  readonly output_content_hash: string | null;
  readonly warning_code: string | null;
}

export interface ClaimedRepositoryAnalysisExecutionInput {
  readonly id: string;
  readonly fence: bigint;
  readonly workspaceId: string;
  readonly profile: AnalysisProfile;
  /** Frozen from immutable snapshot references before PBI-011 identity creation. */
  readonly preparedAttachments?: PreparedAttachmentEvidenceSet;
  /** Stable terminal attempt selected by the immutable case snapshot. */
  readonly attachmentPreparationAttemptId?: string;
  readonly repository?: Readonly<{
    readonly runtimeVersionId: string;
    readonly repositoryId: string;
    readonly repositoryVersionId: string;
    readonly executionPolicyId: string;
    readonly executionPolicyVersionId: string;
    readonly repositoryAgentBindingVersionId: string;
  }>;
}

export type RepositoryAnalysisExecutionInputClaim =
  | Readonly<{ readonly kind: "notApplicable" | "notCaptured" | "notFound" }>
  | Readonly<{ readonly kind: "completed" }>
  | Readonly<{ readonly kind: "claimed"; readonly claim: ClaimedRepositoryAnalysisExecutionInput }>;

/** Redacted retryable contention result; it contains no connector/repository data. */
export class RepositoryAnalysisExecutionInputInProgressError extends Error {
  public readonly code = "analysis.executionInputInProgress";
  public readonly retryable = true;

  public constructor() {
    super("The immutable analysis input is being prepared.");
    this.name = "RepositoryAnalysisExecutionInputInProgressError";
  }
}

/** Redacted terminal configuration/preparation failure. */
export class RepositoryAnalysisExecutionInputUnavailableError extends Error {
  public readonly code = "analysis.executionInputUnavailable";
  public readonly retryable = false;

  public constructor() {
    super("The immutable analysis input is unavailable.");
    this.name = "RepositoryAnalysisExecutionInputUnavailableError";
  }
}

function unavailable(): never {
  throw new RepositoryAnalysisExecutionInputUnavailableError();
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  unavailable();
}

function object(value: Prisma.JsonValue): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) unavailable();
  return value as JsonObject;
}

function asIdentifier(value: string | null): string {
  if (value === null || !identifier.test(value)) unavailable();
  return value;
}

function stage(value: string): "disabled" | "optional" | "required" {
  if (value === "disabled" || value === "optional" || value === "required") {
    return value;
  }
  unavailable();
}

/**
 * Creates the execution-effective profile from a recipe's retained pins. The
 * recipe controls stage activation and exact identities; the selected profile
 * retains its feature-owned prompt/budget/retrieval settings. No URL, locator,
 * source tree, or credential enters this object.
 */
export function effectiveProfileForRepositoryAnalysisRecipe(
  row: RepositoryAnalysisRecipeExecutionRow,
): AnalysisProfile {
  const base = object(row.profile_definition) as unknown as Record<string, unknown>;
  if (row.recipe_profile_version_id !== row.analysis_profile_version_id) unavailable();
  const repositoryMode = stage(row.repository_stage_mode);
  const attachmentMode = stage(row.attachment_stage_mode);
  const existingRepository = object(base.repository as Prisma.JsonValue);
  const existingRetrieval = object(base.retrieval as Prisma.JsonValue);
  const repository =
    repositoryMode === "disabled"
      ? Object.freeze({
          policy: "disabled",
          maximumContextCharacters: existingRepository.maximumContextCharacters,
          maximumEvidenceCharacters: existingRepository.maximumEvidenceCharacters,
        })
      : Object.freeze({
          policy: repositoryMode,
          repositoryId: asIdentifier(row.repository_id),
          repositoryVersionId: asIdentifier(row.code_repository_version_id),
          executionPolicyId: asIdentifier(row.execution_policy_id),
          executionPolicyVersionId: asIdentifier(
            row.repository_execution_policy_version_id,
          ),
          repositoryAgentBindingVersionId: asIdentifier(
            row.repository_agent_binding_version_id,
          ),
          maximumContextCharacters: existingRepository.maximumContextCharacters,
          maximumEvidenceCharacters: existingRepository.maximumEvidenceCharacters,
        });
  if (
    (repositoryMode === "disabled" &&
      (row.code_repository_version_id !== null ||
        row.repository_execution_policy_version_id !== null ||
        row.repository_id !== null ||
        row.execution_policy_id !== null ||
        row.repository_agent_binding_version_id !== null)) ||
    (repositoryMode !== "disabled" &&
      (row.code_repository_version_id === null ||
        row.repository_execution_policy_version_id === null ||
        row.repository_id === null ||
        row.execution_policy_id === null ||
        row.repository_agent_binding_version_id === null)) ||
    (attachmentMode === "disabled" && row.attachment_policy_version_id !== null) ||
    (attachmentMode !== "disabled" && row.attachment_policy_version_id === null)
  ) {
    unavailable();
  }
  try {
    return analysisProfileSchema.parse({
      ...base,
      analysisBindingVersionId: row.analysis_binding_version_id,
      retrieval: {
        ...existingRetrieval,
        ...(row.retrieval_profile_version_id === null
          ? {}
          : { profileVersion: row.retrieval_profile_version_id }),
      },
      attachments: { policy: attachmentMode },
      repository,
    });
  } catch {
    unavailable();
  }
}

export function repositoryRunForRepositoryAnalysisRecipe(
  row: RepositoryAnalysisRecipeExecutionRow,
  pinnedCommit: string | undefined,
  resolvedAt = new Date().toISOString(),
): RepositoryRunPin | undefined {
  if (stage(row.repository_stage_mode) === "disabled") return undefined;
  if (pinnedCommit === undefined || !sha.test(pinnedCommit)) unavailable();
  return Object.freeze({
    repositoryId: asIdentifier(row.repository_id),
    repositoryVersionId: asIdentifier(row.code_repository_version_id),
    runtimePinId: asIdentifier(row.recipe_version_id),
    executionPolicyId: asIdentifier(row.execution_policy_id),
    executionPolicyVersionId: asIdentifier(
      row.repository_execution_policy_version_id,
    ),
    repositoryAgentBindingVersionId: asIdentifier(
      row.repository_agent_binding_version_id,
    ),
    pinnedCommit: pinnedCommit.toLowerCase(),
    resolvedAt,
  });
}

/**
 * Builds the analysis-safe outcome set solely from append-only snapshot
 * references. An occurrence identity is preferred, while legacy snapshots
 * retain their historical attachment-ID identity.
 */
export function preparedAttachmentsFromSnapshotReferences(
  rows: readonly SnapshotAttachmentEvidenceRow[],
): PreparedAttachmentEvidenceSet {
  const evidence: PreparedAttachmentEvidence[] = rows.map((row) => ({
    ...(row.occurrence_identity === null
      ? {}
      : { occurrenceIdentity: row.occurrence_identity }),
    attachmentId: row.attachment_id,
    derivativeId: row.attachment_derivative_id,
    outputContentHash: row.output_content_hash.toLowerCase(),
    outcome: "ready" as const,
    required: false,
  }));
  const identityHash = createPreparedAttachmentEvidenceIdentity({ evidence });
  return validatePreparedAttachmentEvidence({
    evidence: Object.freeze(evidence.map((value) => Object.freeze(value))),
    identityHash,
  });
}

/**
 * Converts only evidence selected by the immutable stable attempt pinned to a
 * snapshot. A required unavailable occurrence remains an explicit failed
 * analysis input; optional unavailable evidence is a typed skip. Neither path
 * can be silently replaced with a newer derivative-cache result.
 */
export function preparedAttachmentsFromStableAttemptEvidence(
  rows: readonly StableAttemptAttachmentEvidenceRow[],
): PreparedAttachmentEvidenceSet {
  const evidence: PreparedAttachmentEvidence[] = rows.map((row) => {
    if (row.outcome === "ready") {
      if (
        row.attachment_derivative_id === null ||
        row.output_content_hash === null ||
        row.warning_code !== null
      ) {
        unavailable();
      }
      return Object.freeze({
        occurrenceIdentity: row.occurrence_identity,
        attachmentId: row.attachment_id,
        derivativeId: row.attachment_derivative_id,
        outputContentHash: row.output_content_hash.toLowerCase(),
        outcome: "ready" as const,
        required: row.required,
      });
    }
    if (
      row.attachment_derivative_id !== null ||
      row.output_content_hash !== null ||
      row.warning_code === null
    ) {
      unavailable();
    }
    return Object.freeze({
      occurrenceIdentity: row.occurrence_identity,
      attachmentId: row.attachment_id,
      outcome: row.required ? ("failed" as const) : ("skipped" as const),
      required: row.required,
      warningCode: row.warning_code,
    });
  });
  const identityHash = createPreparedAttachmentEvidenceIdentity({ evidence });
  return validatePreparedAttachmentEvidence({
    evidence: Object.freeze(evidence),
    identityHash,
  });
}

/**
 * No external-reference lookup occurs here: the caller can only select
 * derivative records pinned by the immutable case snapshot.
 */
export async function preparedAttachmentsForCaseSnapshot(
  database: Prisma.TransactionClient,
  input: Readonly<{ readonly workspaceId: string; readonly caseSnapshotId: string }>,
): Promise<PreparedAttachmentEvidenceSet> {
  const rows = await database.$queryRaw<readonly SnapshotAttachmentEvidenceRow[]>`
    SELECT occurrence_identity, attachment_id, attachment_derivative_id,
           output_content_hash
    FROM case_snapshot_attachment_references
    WHERE workspace_id = ${input.workspaceId}
      AND case_snapshot_id = ${input.caseSnapshotId}
    ORDER BY ordinal
  `;
  return preparedAttachmentsFromSnapshotReferences(rows);
}

/**
 * Reads an attempt pin, not a mutable attachment association. The snapshot
 * link and attempt evidence are both immutable database records; absence is a
 * configuration failure for a PBI-020 recipe with enabled attachment work.
 */
export async function preparedAttachmentsForPinnedCaseSnapshot(
  database: Prisma.TransactionClient,
  input: Readonly<{ readonly workspaceId: string; readonly caseSnapshotId: string }>,
): Promise<PreparedAttachmentEvidenceSet> {
  const rows = await database.$queryRaw<readonly StableAttemptAttachmentEvidenceRow[]>`
    SELECT occurrence.occurrence_identity,
           occurrence.attachment_id,
           evidence.outcome,
           occurrence.required,
           evidence.derivative_id AS attachment_derivative_id,
           evidence.derivative_content_hash AS output_content_hash,
           evidence.warning_code
    FROM case_snapshot_attachment_preparation_attempts AS pin
    JOIN attachment_preparation_attempts AS attempt
      ON attempt.workspace_id = pin.workspace_id
     AND attempt.id = pin.attachment_preparation_attempt_id
     AND attempt.state = 'completed'
    JOIN attachment_preparation_attempt_occurrences AS occurrence
      ON occurrence.workspace_id = attempt.workspace_id
     AND occurrence.attempt_id = attempt.id
    JOIN attachment_preparation_attempt_evidence AS evidence
      ON evidence.workspace_id = occurrence.workspace_id
     AND evidence.attempt_id = occurrence.attempt_id
     AND evidence.occurrence_identity = occurrence.occurrence_identity
    WHERE pin.workspace_id = ${input.workspaceId}
      AND pin.case_snapshot_id = ${input.caseSnapshotId}
    ORDER BY occurrence.ordinal, occurrence.occurrence_identity
  `;
  if (rows.length === 0) {
    const pin = await database.$queryRaw<readonly { readonly id: string }[]>`
      SELECT attempt.id
      FROM case_snapshot_attachment_preparation_attempts AS snapshot_pin
      JOIN attachment_preparation_attempts AS attempt
        ON attempt.workspace_id = snapshot_pin.workspace_id
       AND attempt.id = snapshot_pin.attachment_preparation_attempt_id
       AND attempt.state = 'completed'
      WHERE snapshot_pin.workspace_id = ${input.workspaceId}
        AND snapshot_pin.case_snapshot_id = ${input.caseSnapshotId}
    `;
    if (pin.length !== 1) unavailable();
  }
  return preparedAttachmentsFromStableAttemptEvidence(rows);
}

async function pinnedAttemptIdForCaseSnapshot(
  database: Prisma.TransactionClient,
  input: Readonly<{ readonly workspaceId: string; readonly caseSnapshotId: string }>,
): Promise<string> {
  const rows = await database.$queryRaw<readonly { readonly id: string }[]>`
    SELECT attempt.id
    FROM case_snapshot_attachment_preparation_attempts AS pin
    JOIN attachment_preparation_attempts AS attempt
      ON attempt.workspace_id = pin.workspace_id
     AND attempt.id = pin.attachment_preparation_attempt_id
     AND attempt.state = 'completed'
    WHERE pin.workspace_id = ${input.workspaceId}
      AND pin.case_snapshot_id = ${input.caseSnapshotId}
  `;
  const row = rows[0];
  if (rows.length !== 1 || row === undefined || !identifier.test(row.id)) {
    unavailable();
  }
  return row.id;
}

/**
 * Fenced persistence for the pre-analysis recipe stage. The claim/finalize
 * protocol is deliberately separate from PBI-011's short request transaction:
 * remote Git resolution and attachment processing never hold database locks.
 */
export class PostgresRepositoryAnalysisExecutionInputStore {
  public constructor(
    private readonly client: PrismaClient,
    private readonly leaseMilliseconds = defaultLeaseMilliseconds,
  ) {
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1) {
      throw new RangeError("Repository-analysis input lease must be positive.");
    }
  }

  public async claim(
    command: EnvelopeFor<"analysis.trigger.v2">,
  ): Promise<RepositoryAnalysisExecutionInputClaim> {
    return this.client.$transaction(async (database) => {
      const rows = await database.$queryRaw<
        readonly RepositoryAnalysisRecipeExecutionRow[]
      >`
        SELECT
          request.id AS request_id, request.workspace_id,
          request.case_snapshot_id, request.analysis_profile_version_id,
          request.analysis_trigger_version_id,
          trigger_version.analysis_trigger_id AS trigger_id,
          request.connector_registration_id, request.connector_configuration_version_id,
          profile.definition AS profile_definition,
          recipe.id AS recipe_version_id,
          recipe.analysis_profile_version_id AS recipe_profile_version_id,
          recipe.analysis_binding_version_id,
          recipe.retrieval_profile_version_id,
          recipe.attachment_policy_version_id,
          recipe.attachment_stage_mode,
          recipe.code_repository_version_id,
          recipe.repository_execution_policy_version_id,
          recipe.repository_stage_mode,
          repository_configuration.id AS repository_id,
          policy_configuration.id AS execution_policy_id,
          policy.repository_agent_binding_version_id
        FROM analysis_trigger_requests AS request
        JOIN analysis_trigger_versions AS trigger_version
          ON trigger_version.workspace_id = request.workspace_id
         AND trigger_version.id = request.analysis_trigger_version_id
        LEFT JOIN case_analysis_trigger_recipe_versions AS mapping
          ON mapping.workspace_id = request.workspace_id
         AND mapping.analysis_trigger_version_id = request.analysis_trigger_version_id
        LEFT JOIN analysis_recipe_versions AS recipe
          ON recipe.workspace_id = mapping.workspace_id
         AND recipe.id = mapping.analysis_recipe_version_id
        LEFT JOIN analysis_profile_versions AS profile
          ON profile.workspace_id = request.workspace_id
         AND profile.id = request.analysis_profile_version_id
        LEFT JOIN administration_configuration_versions AS repository_version
          ON repository_version.workspace_id = recipe.workspace_id
         AND repository_version.id = recipe.code_repository_version_id
        LEFT JOIN administration_configurations AS repository_configuration
          ON repository_configuration.workspace_id = repository_version.workspace_id
         AND repository_configuration.id = repository_version.configuration_id
         AND repository_configuration.resource_type = 'code-repositories'
        LEFT JOIN repository_execution_policy_versions AS policy
          ON policy.workspace_id = recipe.workspace_id
         AND policy.id = recipe.repository_execution_policy_version_id
        LEFT JOIN administration_configuration_versions AS policy_version
          ON policy_version.workspace_id = policy.workspace_id
         AND policy_version.id = policy.configuration_version_id
        LEFT JOIN administration_configurations AS policy_configuration
          ON policy_configuration.workspace_id = policy_version.workspace_id
         AND policy_configuration.id = policy_version.configuration_id
         AND policy_configuration.resource_type = 'repository-execution-policies'
        WHERE request.workspace_id = ${command.workspaceId}
          AND request.id = ${command.payload.triggerRequestId}
        FOR UPDATE OF request
      `;
      const row = rows[0];
      if (row === undefined) return { kind: "notFound" };
      if (
        row.analysis_trigger_version_id !== command.payload.triggerVersionId ||
        row.trigger_id !== command.payload.triggerId ||
        row.connector_registration_id !== command.payload.connectorRegistrationId ||
        row.connector_configuration_version_id !==
          command.payload.connectorConfigurationVersionId
      ) {
        unavailable();
      }
      if (row.recipe_version_id === null) return { kind: "notApplicable" };
      if (row.case_snapshot_id === null) return { kind: "notCaptured" };
      const profile = effectiveProfileForRepositoryAnalysisRecipe(row);
      const preparedAttachments =
        profile.attachments.policy === "disabled"
          ? undefined
          : await preparedAttachmentsForPinnedCaseSnapshot(database, {
              workspaceId: command.workspaceId,
              caseSnapshotId: row.case_snapshot_id,
            });
      const attachmentPreparationAttemptId =
        profile.attachments.policy === "disabled"
          ? undefined
          : await pinnedAttemptIdForCaseSnapshot(database, {
              workspaceId: command.workspaceId,
              caseSnapshotId: row.case_snapshot_id,
            });
      const existing = await database.$queryRaw<readonly InputRow[]>`
        SELECT id, state, lease_token, lease_expires_at, fencing_token, error_retryable,
               lease_expires_at > statement_timestamp() AS lease_live
        FROM analysis_execution_inputs
        WHERE workspace_id = ${command.workspaceId}
          AND analysis_trigger_request_id = ${row.request_id}
        FOR UPDATE
      `;
      const current = existing[0];
      if (current?.state === "finalized") return { kind: "completed" };
      if (
        current?.state === "claimed" &&
        current.lease_live
      ) {
        throw new RepositoryAnalysisExecutionInputInProgressError();
      }
      if (current?.state === "failed" && current.error_retryable !== true) {
        unavailable();
      }
      const id = current?.id ?? randomUUID();
      const fence = (current?.fencing_token ?? 0n) + 1n;
      const token = randomUUID();
      const placeholder = hash(
        canonical({ requestId: row.request_id, recipeVersionId: row.recipe_version_id }),
      );
      if (current === undefined) {
        await database.$executeRaw`
          INSERT INTO analysis_execution_inputs (
            id, workspace_id, analysis_trigger_request_id, case_snapshot_id,
            analysis_recipe_version_id, attachment_evidence_hash, input_hash,
            state, lease_token, lease_expires_at, fencing_token
          ) VALUES (
            ${id}, ${command.workspaceId}, ${row.request_id}, ${row.case_snapshot_id},
            ${row.recipe_version_id}, ${preparedAttachments?.identityHash ?? createPreparedAttachmentEvidenceIdentity({ evidence: [] })}, ${placeholder},
            'claimed', ${token}, statement_timestamp() + (${this.leaseMilliseconds} * interval '1 millisecond'), ${fence}
          )
        `;
      } else {
        const claimed = await database.$executeRaw`
          UPDATE analysis_execution_inputs
          SET state = 'claimed', lease_token = ${token},
              lease_expires_at = statement_timestamp() + (${this.leaseMilliseconds} * interval '1 millisecond'),
              fencing_token = ${fence}, error_code = NULL, error_retryable = NULL
          WHERE workspace_id = ${command.workspaceId}
            AND id = ${id}
            AND state <> 'finalized'
        `;
        if (claimed !== 1) unavailable();
      }
      const repository = repositoryRunForRepositoryAnalysisRecipe(
        row,
        "a".repeat(40),
      );
      return Object.freeze({
        kind: "claimed",
        claim: Object.freeze({
          id,
          fence,
          workspaceId: row.workspace_id,
          profile,
          ...(preparedAttachments === undefined ? {} : { preparedAttachments }),
          ...(attachmentPreparationAttemptId === undefined
            ? {}
            : { attachmentPreparationAttemptId }),
          ...(repository === undefined
            ? {}
            : {
                repository: Object.freeze({
                  runtimeVersionId: repository.runtimePinId,
                  repositoryId: repository.repositoryId,
                  repositoryVersionId: repository.repositoryVersionId,
                  executionPolicyId: repository.executionPolicyId,
                  executionPolicyVersionId: repository.executionPolicyVersionId,
                  repositoryAgentBindingVersionId:
                    repository.repositoryAgentBindingVersionId,
                }),
              }),
        }),
      });
    });
  }

  public async finalize(input: {
    readonly claim: ClaimedRepositoryAnalysisExecutionInput;
    readonly repositoryRun?: RepositoryRunPin;
  }): Promise<void> {
    const preparedAttachments = input.claim.preparedAttachments;
    if (
      (input.claim.profile.attachments.policy === "disabled") !==
      (preparedAttachments === undefined)
    ) {
      unavailable();
    }
    if (
      (preparedAttachments === undefined) !==
      (input.claim.attachmentPreparationAttemptId === undefined)
    ) {
      unavailable();
    }
    const repository = input.repositoryRun;
    if (input.claim.repository === undefined ? repository !== undefined : repository === undefined) {
      unavailable();
    }
    if (
      repository !== undefined &&
      (!sha.test(repository.pinnedCommit) ||
        repository.runtimePinId !== input.claim.repository?.runtimeVersionId ||
        repository.repositoryId !== input.claim.repository.repositoryId ||
        repository.repositoryVersionId !== input.claim.repository.repositoryVersionId ||
        repository.executionPolicyId !== input.claim.repository.executionPolicyId ||
        repository.executionPolicyVersionId !==
          input.claim.repository.executionPolicyVersionId ||
        repository.repositoryAgentBindingVersionId !==
          input.claim.repository.repositoryAgentBindingVersionId)
    ) {
      unavailable();
    }
    const inputHash = hash(
      canonical({
        profile: input.claim.profile,
        preparedAttachmentEvidenceHash:
          preparedAttachments?.identityHash ??
          createPreparedAttachmentEvidenceIdentity({ evidence: [] }),
        ...(repository === undefined ? {} : { repository }),
      }),
    );
    const finalized = await this.client.$executeRaw`
      UPDATE analysis_execution_inputs
      SET attachment_evidence_hash = ${
        preparedAttachments?.identityHash ??
        createPreparedAttachmentEvidenceIdentity({ evidence: [] })
      },
          attachment_preparation_attempt_id = ${
            input.claim.attachmentPreparationAttemptId ?? null
          },
          code_repository_version_id = ${repository?.repositoryVersionId ?? null},
          repository_execution_policy_version_id = ${repository?.executionPolicyVersionId ?? null},
          repository_agent_binding_version_id = ${
            repository?.repositoryAgentBindingVersionId ?? null
          },
          resolved_commit_sha = ${repository?.pinnedCommit ?? null},
          repository_resolved_at = ${repository === undefined ? null : new Date(repository.resolvedAt)},
          input_hash = ${inputHash}, state = 'finalized', lease_token = NULL,
          lease_expires_at = NULL, finalized_at = statement_timestamp(),
          error_code = NULL, error_retryable = NULL
      WHERE workspace_id = ${input.claim.workspaceId}
        AND id = ${input.claim.id}
        AND state = 'claimed'
        AND fencing_token = ${input.claim.fence}
        AND lease_expires_at > statement_timestamp()
    `;
    if (finalized !== 1) unavailable();
  }

  public async fail(input: {
    readonly claim: ClaimedRepositoryAnalysisExecutionInput;
    readonly error: { readonly code: string; readonly retryable: boolean };
  }): Promise<void> {
    const code = input.error.code;
    if (!/^[a-z][a-z0-9.]{2,199}$/u.test(code)) unavailable();
    const failed = await this.client.$executeRaw`
      UPDATE analysis_execution_inputs
      SET state = 'failed', lease_token = NULL, lease_expires_at = NULL,
          error_code = ${code}, error_retryable = ${input.error.retryable}
      WHERE workspace_id = ${input.claim.workspaceId}
        AND id = ${input.claim.id}
        AND state = 'claimed'
        AND fencing_token = ${input.claim.fence}
        AND lease_expires_at > statement_timestamp()
    `;
    if (failed !== 1) unavailable();
  }
}
