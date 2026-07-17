import { randomUUID } from "node:crypto";

import {
  type RepositoryConfigurationActivationGuard,
  type RepositoryDraftTestAudit,
  type RepositoryDraftTestCandidateResolver,
  type RepositoryDraftTestExecutionCandidateResolver,
  type RepositoryDraftTestIdentity,
  type RepositoryDraftTestInProgress,
  type RepositoryDraftTestResult,
  type RepositoryDraftTestStore,
  type ResolvedRepositoryDraftCandidate,
  type ServerPrivateRepositoryDraftTestCandidate,
  repositoryDraftCandidateDigest,
  repositoryDraftTestAuditAction,
  repositoryDraftTestPreviewAuditAction,
} from "@caseweaver/administration";
import type { Prisma, PrismaClient } from "@prisma/client";

type Database = PrismaClient | Prisma.TransactionClient;

const confirmationTtlMilliseconds = 5 * 60 * 1_000;
const claimLeaseMilliseconds = 45 * 1_000;

interface CandidateRow {
  readonly workspace_id: string;
  readonly configuration_id: string;
  readonly configuration_version_id: string;
  readonly settings: unknown;
  readonly secret_references: unknown;
  readonly mode: string;
  readonly allowed_ref_kinds: unknown;
}

interface ClaimRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly principal_id: string;
  readonly session_id: string;
  readonly repository_id: string;
  readonly candidate_version_id: string;
  readonly candidate_digest: string;
  readonly key_digest: string;
  readonly attempt_ordinal: number;
  readonly accepted_at: Date;
  readonly lease_expires_at: Date;
}

interface ResultRow {
  readonly id: string;
  readonly outcome: string;
  readonly completed_at: Date;
}

interface TimestampRow {
  readonly expires_at: Date;
}

interface ClaimStateRow {
  readonly is_live: boolean;
}

/**
 * Resolves an inert repository candidate privately and persists bounded draft
 * tests. Every public result is an opaque ID, digest, timestamp, and terminal
 * status only; repository settings, URLs, refs, aliases, and secret locators
 * remain inside this adapter while calculating the digest.
 */
export class PostgresRepositoryDraftTestStore
  implements
    RepositoryDraftTestCandidateResolver,
    RepositoryDraftTestExecutionCandidateResolver,
    RepositoryDraftTestStore,
    RepositoryConfigurationActivationGuard
{
  private readonly nextId: () => string;
  private readonly confirmationTtlMilliseconds: number;
  private readonly claimLeaseMilliseconds: number;

  public constructor(
    private readonly client: PrismaClient,
    input: Readonly<{
      readonly nextId?: () => string;
      readonly confirmationTtlMilliseconds?: number;
      readonly claimLeaseMilliseconds?: number;
    }> = {},
  ) {
    this.nextId = input.nextId ?? randomUUID;
    this.confirmationTtlMilliseconds = positiveDuration(
      input.confirmationTtlMilliseconds ?? confirmationTtlMilliseconds,
      "Repository draft-test confirmation lifetime",
    );
    this.claimLeaseMilliseconds = positiveDuration(
      input.claimLeaseMilliseconds ?? claimLeaseMilliseconds,
      "Repository draft-test claim lease",
    );
  }

  public async resolveCandidate(
    input: Parameters<
      RepositoryDraftTestCandidateResolver["resolveCandidate"]
    >[0],
  ): Promise<ResolvedRepositoryDraftCandidate | undefined> {
    const rows = await this.client.$queryRaw<readonly CandidateRow[]>`
      SELECT
        configuration.workspace_id,
        configuration.id AS configuration_id,
        version.id AS configuration_version_id,
        version.settings,
        version.secret_references,
        repository.mode,
        repository.allowed_ref_kinds
      FROM administration_configurations AS configuration
      INNER JOIN administration_configuration_versions AS version
        ON version.workspace_id = configuration.workspace_id
        AND version.configuration_id = configuration.id
      INNER JOIN code_repository_versions AS repository
        ON repository.workspace_id = version.workspace_id
        AND repository.configuration_version_id = version.id
      WHERE configuration.workspace_id = ${input.workspaceId}
        AND configuration.id = ${input.repositoryId}
        AND configuration.resource_type = 'code-repositories'
        AND configuration.lifecycle = 'draft'
        AND configuration.current_version_id = ${input.candidateVersionId}
        AND version.id = ${input.candidateVersionId}
    `;
    const row = rows[0];
    if (row === undefined) return undefined;
    const settings = privateSettings(row.settings);
    const secretReferenceIds = await this.registeredSecretReferenceIds(
      row.workspace_id,
      privateSecretReferences(row.secret_references),
    );
    const projection = codeRepositoryProjection(row, input);
    return Object.freeze({
      workspaceId: row.workspace_id,
      repositoryId: row.configuration_id,
      candidateVersionId: row.configuration_version_id,
      candidateDigest: repositoryDraftCandidateDigest({
        settings,
        secretReferenceIds,
        projection,
      }),
    });
  }

  public async resolveExecutionCandidate(
    input: Parameters<
      RepositoryDraftTestExecutionCandidateResolver["resolveExecutionCandidate"]
    >[0],
  ): Promise<ServerPrivateRepositoryDraftTestCandidate | undefined> {
    const candidate = await this.resolveCandidate(input);
    if (candidate === undefined || candidate.candidateDigest !== input.candidateDigest) {
      return undefined;
    }
    const rows = await this.client.$queryRaw<readonly CandidateRow[]>`
      SELECT
        configuration.workspace_id,
        configuration.id AS configuration_id,
        version.id AS configuration_version_id,
        version.settings,
        version.secret_references,
        repository.mode,
        repository.allowed_ref_kinds
      FROM administration_configurations AS configuration
      INNER JOIN administration_configuration_versions AS version
        ON version.workspace_id = configuration.workspace_id
        AND version.configuration_id = configuration.id
      INNER JOIN code_repository_versions AS repository
        ON repository.workspace_id = version.workspace_id
        AND repository.configuration_version_id = version.id
      WHERE configuration.workspace_id = ${input.workspaceId}
        AND configuration.id = ${input.repositoryId}
        AND configuration.resource_type = 'code-repositories'
        AND configuration.lifecycle = 'draft'
        AND configuration.current_version_id = ${input.candidateVersionId}
        AND version.id = ${input.candidateVersionId}
    `;
    const row = rows[0];
    if (row === undefined) return undefined;
    const projection = codeRepositoryProjection(row, input);
    const settings = privateSettings(row.settings);
    const repository = privateSettings(settings.repository);
    const checkoutRef = checkoutRefFromSettings(repository);
    if (!projection.allowedRefKinds.includes(checkoutRef.kind)) {
      return undefined;
    }
    const secretReferenceIds = await this.registeredSecretReferenceIds(
      row.workspace_id,
      privateSecretReferences(row.secret_references),
    );
    if (projection.mode === "remoteHttps") {
      const remoteUrl = repository.remoteUrl;
      if (typeof remoteUrl !== "string" || secretReferenceIds.length > 1) {
        return undefined;
      }
      const registration =
        secretReferenceIds.length === 0
          ? undefined
          : await this.client.credentialRegistration.findFirst({
              where: {
                workspaceId: row.workspace_id,
                id: secretReferenceIds[0],
                lifecycle: "active",
              },
              select: { secretReference: true },
            });
      if (registration === null) return undefined;
      return Object.freeze({
        ...candidate,
        location: Object.freeze({
          mode: "remoteHttps" as const,
          remoteUrl,
          ...(registration === undefined
            ? {}
            : { checkoutSecretReference: registration.secretReference }),
        }),
        checkoutRef,
      });
    }
    if (secretReferenceIds.length !== 0 || typeof repository.mountAlias !== "string") {
      return undefined;
    }
    return Object.freeze({
      ...candidate,
      location: Object.freeze({
        mode: "deploymentMounted" as const,
        mountAlias: repository.mountAlias,
      }),
      checkoutRef,
    });
  }

  private async registeredSecretReferenceIds(
    workspaceId: string,
    secretReferences: readonly string[],
  ): Promise<readonly string[]> {
    if (secretReferences.length === 0) return Object.freeze([]);
    const registrations = await this.client.credentialRegistration.findMany({
      where: {
        workspaceId,
        lifecycle: "active",
        id: { in: [...secretReferences] },
      },
      select: { id: true },
    });
    if (
      registrations.length !== secretReferences.length ||
      !secretReferences.every((reference) =>
        registrations.some((registration) => registration.id === reference),
      )
    ) {
      throw new Error(
        "Repository draft-test secret registrations are invalid.",
      );
    }
    return Object.freeze([...secretReferences]);
  }

  public async issueAndRecord(
    input: Parameters<RepositoryDraftTestStore["issueAndRecord"]>[0],
  ) {
    assertTimestamp(input.now);
    assertAudit(
      input.audit,
      input.identity,
      repositoryDraftTestPreviewAuditAction,
      "succeeded",
    );
    const confirmationId = this.nextId();
    const confirmation = "Run repository connection test";
    const impact =
      "CaseWeaver will perform one bounded, read-only repository connection and ref-resolution test. The candidate is not saved or activated.";
    return this.client.$transaction(async (database) => {
      const rows = await database.$queryRaw<readonly TimestampRow[]>`
        INSERT INTO administration_repository_draft_test_confirmations (
          id, workspace_id, principal_id, session_id, repository_id,
          candidate_version_id, candidate_digest, confirmation, impact,
          expires_at, created_at
        )
        VALUES (
          ${confirmationId}, ${input.identity.workspaceId},
          ${input.identity.principalId}, ${input.identity.sessionId},
          ${input.identity.repositoryId}, ${input.identity.candidateVersionId},
          ${input.identity.candidateDigest}, ${confirmation}, ${impact},
          statement_timestamp() + (${this.confirmationTtlMilliseconds} * INTERVAL '1 millisecond'),
          statement_timestamp()
        )
        RETURNING expires_at
      `;
      const inserted = rows[0];
      if (inserted === undefined) {
        throw new Error("Repository draft-test confirmation was not retained.");
      }
      await appendAudit(database, input.audit, this.nextId);
      return Object.freeze({
        confirmationId,
        confirmation,
        impact,
        expiresAt: inserted.expires_at.toISOString(),
      });
    });
  }

  public async consumeAndClaim(
    input: Parameters<RepositoryDraftTestStore["consumeAndClaim"]>[0],
  ) {
    return this.client.$transaction(async (database) => {
      await database.$queryRaw`
        SELECT 1 AS locked
        FROM pg_advisory_xact_lock(
          hashtextextended(
            ${`repository-draft-test:${input.identity.workspaceId}:${input.idempotencyKeyDigest}`},
            0
          )
        )
      `;
      const existing = await latestClaim(
        database,
        input.identity.workspaceId,
        input.idempotencyKeyDigest,
      );
      if (existing !== undefined) {
        if (!matches(existing, input.identity)) {
          return Object.freeze({ kind: "conflict" as const });
        }
        const terminal = await resultForClaim(database, existing.id);
        if (terminal !== undefined) {
          return Object.freeze({
            kind: "terminal" as const,
            result: storedResult(terminal),
          });
        }
        if (await claimIsLive(database, existing.id)) {
          return Object.freeze({
            kind: "inProgress" as const,
            result: inProgress(existing),
          });
        }
        const reclaimed = await createClaim(database, {
          id: this.nextId(),
          identity: input.identity,
          keyDigest: input.idempotencyKeyDigest,
          attemptOrdinal: existing.attempt_ordinal + 1,
          leaseMilliseconds: this.claimLeaseMilliseconds,
          previousClaimId: existing.id,
        });
        if (!reclaimed) {
          throw new Error(
            "Repository draft-test expired claim could not be reclaimed.",
          );
        }
        return Object.freeze({ kind: "claimed" as const, claimId: reclaimed });
      }

      const consumed = await database.$queryRaw<
        readonly Readonly<{ id: string }>[]
      >`
        UPDATE administration_repository_draft_test_confirmations
        SET consumed_at = statement_timestamp()
        WHERE id = ${input.confirmationId}
          AND workspace_id = ${input.identity.workspaceId}
          AND principal_id = ${input.identity.principalId}
          AND session_id = ${input.identity.sessionId}
          AND repository_id = ${input.identity.repositoryId}
          AND candidate_version_id = ${input.identity.candidateVersionId}
          AND candidate_digest = ${input.identity.candidateDigest}
          AND expires_at > statement_timestamp()
          AND consumed_at IS NULL
        RETURNING id
      `;
      if (consumed.length !== 1) {
        return Object.freeze({ kind: "conflict" as const });
      }
      const claimId = this.nextId();
      const created = await createClaim(database, {
        id: claimId,
        identity: input.identity,
        keyDigest: input.idempotencyKeyDigest,
        attemptOrdinal: 1,
        leaseMilliseconds: this.claimLeaseMilliseconds,
      });
      if (!created) {
        throw new Error("Repository draft-test claim was not retained.");
      }
      return Object.freeze({ kind: "claimed" as const, claimId });
    });
  }

  public async completeAndRecord(
    input: Parameters<RepositoryDraftTestStore["completeAndRecord"]>[0],
  ): Promise<RepositoryDraftTestResult> {
    assertAudit(
      input.audit,
      input.identity,
      repositoryDraftTestAuditAction,
      input.result.outcome === "completed" ? "succeeded" : "failed",
    );
    assertTimestamp(input.result.completedAt);
    return this.client.$transaction(async (database) => {
      const claim = await claimById(database, input.claimId);
      if (claim === undefined || !matches(claim, input.identity)) {
        throw new Error("Repository draft-test claim is invalid.");
      }
      const existing = await resultForClaim(database, claim.id);
      if (existing !== undefined) {
        const result = storedResult(existing);
        if (
          result.outcome !== input.result.outcome ||
          result.completedAt !== input.result.completedAt
        ) {
          throw new Error(
            "Repository draft-test result conflicts with its claim.",
          );
        }
        return result;
      }
      const current = await latestClaim(
        database,
        claim.workspace_id,
        claim.key_digest,
      );
      if (current === undefined || current.id !== claim.id) {
        throw new Error("Repository draft-test claim was superseded.");
      }
      if (!(await claimIsLive(database, claim.id))) {
        throw new Error("Repository draft-test claim lease expired.");
      }
      const resultId = this.nextId();
      const created = await database.$queryRaw<readonly ResultRow[]>`
        INSERT INTO administration_repository_draft_test_results (
          id, claim_id, workspace_id, outcome, completed_at
        )
        VALUES (
          ${resultId}, ${claim.id}, ${claim.workspace_id},
          ${input.result.outcome}, ${input.result.completedAt}::timestamptz
        )
        RETURNING id, outcome, completed_at
      `;
      const result = created[0];
      if (result === undefined) {
        throw new Error("Repository draft-test result was not retained.");
      }
      await database.$executeRaw`
        UPDATE administration_repository_draft_test_claims
        SET completed_at = ${input.result.completedAt}::timestamptz
        WHERE id = ${claim.id}
      `;
      await appendAudit(database, input.audit, this.nextId);
      return storedResult(result);
    });
  }

  public async requireSuccessfulCandidate(
    input: Parameters<
      RepositoryConfigurationActivationGuard["requireSuccessfulCandidate"]
    >[0],
  ): Promise<void> {
    const successful = await this.client.$queryRaw<
      readonly Readonly<{ readonly id: string }>[]
    >`
      SELECT result.id
      FROM administration_repository_draft_test_results AS result
      INNER JOIN administration_repository_draft_test_claims AS claim
        ON claim.id = result.claim_id
        AND claim.workspace_id = result.workspace_id
      WHERE claim.workspace_id = ${input.workspaceId}
        AND claim.repository_id = ${input.repositoryId}
        AND claim.candidate_digest = ${input.candidateDigest}
        AND result.outcome = 'completed'
      ORDER BY result.completed_at DESC, result.id DESC
      LIMIT 1
    `;
    if (successful.length !== 1) {
      throw new Error("Repository candidate has no successful completed test.");
    }
  }
}

async function latestClaim(
  database: Database,
  workspaceId: string,
  keyDigest: string,
): Promise<ClaimRow | undefined> {
  const rows = await database.$queryRaw<readonly ClaimRow[]>`
    SELECT
      id, workspace_id, principal_id, session_id, repository_id,
      candidate_version_id, candidate_digest, key_digest, attempt_ordinal,
      accepted_at, lease_expires_at
    FROM administration_repository_draft_test_claims
    WHERE workspace_id = ${workspaceId}
      AND key_digest = ${keyDigest}
    ORDER BY attempt_ordinal DESC
    LIMIT 1
    FOR UPDATE
  `;
  return rows[0];
}

async function claimById(
  database: Database,
  claimId: string,
): Promise<ClaimRow | undefined> {
  const rows = await database.$queryRaw<readonly ClaimRow[]>`
    SELECT
      id, workspace_id, principal_id, session_id, repository_id,
      candidate_version_id, candidate_digest, key_digest, attempt_ordinal,
      accepted_at, lease_expires_at
    FROM administration_repository_draft_test_claims
    WHERE id = ${claimId}
    FOR UPDATE
  `;
  return rows[0];
}

async function resultForClaim(
  database: Database,
  claimId: string,
): Promise<ResultRow | undefined> {
  const rows = await database.$queryRaw<readonly ResultRow[]>`
    SELECT id, outcome, completed_at
    FROM administration_repository_draft_test_results
    WHERE claim_id = ${claimId}
  `;
  return rows[0];
}

async function claimIsLive(
  database: Database,
  claimId: string,
): Promise<boolean> {
  const rows = await database.$queryRaw<readonly ClaimStateRow[]>`
    SELECT lease_expires_at > statement_timestamp() AS is_live
    FROM administration_repository_draft_test_claims
    WHERE id = ${claimId}
  `;
  return rows[0]?.is_live === true;
}

async function createClaim(
  database: Database,
  input: Readonly<{
    readonly id: string;
    readonly identity: RepositoryDraftTestIdentity;
    readonly keyDigest: string;
    readonly attemptOrdinal: number;
    readonly leaseMilliseconds: number;
    readonly previousClaimId?: string;
  }>,
): Promise<string | undefined> {
  const rows = await database.$queryRaw<
    readonly Readonly<{ readonly id: string }>[]
  >`
    INSERT INTO administration_repository_draft_test_claims (
      id, workspace_id, principal_id, session_id, repository_id,
      candidate_version_id, candidate_digest, key_digest, attempt_ordinal,
      accepted_at, lease_expires_at, reclaimed_from_claim_id
    )
    VALUES (
      ${input.id}, ${input.identity.workspaceId}, ${input.identity.principalId},
      ${input.identity.sessionId}, ${input.identity.repositoryId},
      ${input.identity.candidateVersionId}, ${input.identity.candidateDigest},
      ${input.keyDigest}, ${input.attemptOrdinal}, statement_timestamp(),
      statement_timestamp() + (${input.leaseMilliseconds} * INTERVAL '1 millisecond'),
      ${input.previousClaimId ?? null}
    )
    RETURNING id
  `;
  return rows[0]?.id;
}

function inProgress(claim: ClaimRow): RepositoryDraftTestInProgress {
  return Object.freeze({
    id: claim.id,
    outcome: "accepted",
    status: "inProgress",
    acceptedAt: claim.accepted_at.toISOString(),
  });
}

function storedResult(row: ResultRow): RepositoryDraftTestResult {
  if (
    row.outcome !== "completed" &&
    row.outcome !== "failed" &&
    row.outcome !== "outcome_unknown"
  ) {
    throw new Error("Repository draft-test result is invalid.");
  }
  return Object.freeze({
    id: row.id,
    outcome: row.outcome,
    completedAt: row.completed_at.toISOString(),
  });
}

function codeRepositoryProjection(
  row: CandidateRow,
  input: Parameters<
    RepositoryDraftTestCandidateResolver["resolveCandidate"]
  >[0],
): Readonly<{
  readonly repositoryId: string;
  readonly mode: "deploymentMounted" | "remoteHttps";
  readonly allowedRefKinds: readonly ("branch" | "tag" | "commit")[];
}> {
  if (
    row.workspace_id !== input.workspaceId ||
    row.configuration_id !== input.repositoryId ||
    row.configuration_version_id !== input.candidateVersionId ||
    (row.mode !== "deploymentMounted" && row.mode !== "remoteHttps") ||
    !Array.isArray(row.allowed_ref_kinds) ||
    !row.allowed_ref_kinds.every(
      (value) => value === "branch" || value === "tag" || value === "commit",
    )
  ) {
    throw new Error("Repository draft-test candidate projection is invalid.");
  }
  return Object.freeze({
    repositoryId: row.configuration_id,
    mode: row.mode,
    allowedRefKinds: Object.freeze([...row.allowed_ref_kinds]),
  });
}

function privateSettings(value: unknown): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("Repository draft-test private settings are invalid.");
  }
  return value as Readonly<Record<string, unknown>>;
}

function privateSecretReferences(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new Error(
      "Repository draft-test private secret references are invalid.",
    );
  }
  return Object.freeze([...value]);
}

function checkoutRefFromSettings(
  repository: Readonly<Record<string, unknown>>,
): ServerPrivateRepositoryDraftTestCandidate["checkoutRef"] {
  const ref = privateSettings(repository.checkoutRef);
  if (
    (ref.kind === "branch" || ref.kind === "tag") &&
    typeof ref.name === "string" &&
    ref.name.length > 0 &&
    ref.name.length <= 512
  ) {
    return Object.freeze({ kind: ref.kind, name: ref.name });
  }
  if (
    ref.kind === "commit" &&
    typeof ref.sha === "string" &&
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(ref.sha)
  ) {
    return Object.freeze({ kind: "commit", sha: ref.sha });
  }
  throw new Error("Repository draft-test checkout reference is invalid.");
}

function matches(
  claim: ClaimRow,
  identity: RepositoryDraftTestIdentity,
): boolean {
  return (
    claim.workspace_id === identity.workspaceId &&
    claim.principal_id === identity.principalId &&
    claim.session_id === identity.sessionId &&
    claim.repository_id === identity.repositoryId &&
    claim.candidate_version_id === identity.candidateVersionId &&
    claim.candidate_digest === identity.candidateDigest
  );
}

function assertAudit(
  audit: RepositoryDraftTestAudit,
  identity: RepositoryDraftTestIdentity,
  action:
    | typeof repositoryDraftTestPreviewAuditAction
    | typeof repositoryDraftTestAuditAction,
  outcome: "succeeded" | "failed",
): void {
  if (
    audit.workspaceId !== identity.workspaceId ||
    audit.actorPrincipalId !== identity.principalId ||
    audit.action !== action ||
    audit.targetType !== "code-repository" ||
    audit.targetId !== identity.repositoryId ||
    audit.permission !== "configuration.manage" ||
    audit.outcome !== outcome
  ) {
    throw new Error("Repository draft-test audit is invalid.");
  }
  assertTimestamp(audit.occurredAt);
}

async function appendAudit(
  database: Database,
  audit: RepositoryDraftTestAudit,
  nextId: () => string,
): Promise<void> {
  await database.$executeRaw`
    INSERT INTO audit_events (
      id, workspace_id, actor_principal_id, action, target_id, target_type,
      permission, outcome, idempotency_key_digest, origin, occurred_at
    )
    VALUES (
      ${nextId()}, ${audit.workspaceId}, ${audit.actorPrincipalId}, ${audit.action},
      ${audit.targetId}, ${audit.targetType}, ${audit.permission}, ${audit.outcome},
      ${audit.idempotencyKeyDigest ?? null}, 'admin_ui', ${audit.occurredAt}::timestamptz
    )
  `;
}

function assertTimestamp(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("Repository draft-test timestamp is invalid.");
  }
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000) {
    throw new RangeError(`${name} is invalid.`);
  }
  return value;
}
