import { createHash } from "node:crypto";

import { canonicalizeConfiguration } from "./configuration.js";
import {
  AdministrationAuditUnavailableError,
  AdministrationNotFoundError,
  AdministrationValidationError,
  IdempotencyConflictError,
} from "./errors.js";

/** A server-owned action code; a browser never supplies it. */
export const repositoryDraftTestPreviewAuditAction =
  "admin.codeRepository.draftTest.preview" as const;
/** A server-owned action code; a browser never supplies it. */
export const repositoryDraftTestAuditAction =
  "admin.codeRepository.draftTest" as const;

/**
 * Candidate identity binds a confirmation, idempotency record, and durable result
 * to exactly one server-selected draft. It intentionally has no settings, URL,
 * ref, mount, locator, credential, path, response, or error field.
 */
export interface RepositoryDraftTestIdentity {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly repositoryId: string;
  readonly candidateVersionId: string;
  readonly candidateDigest: string;
}

/** Safe, server-rendered confirmation payload. */
export interface RepositoryDraftTestPreview {
  readonly confirmationId: string;
  readonly confirmation: string;
  readonly impact: string;
  readonly expiresAt: string;
}

export type RepositoryDraftTestOutcome =
  | "completed"
  | "failed"
  | "outcome_unknown";

/** Deliberately redacted terminal state; it never contains a connection result. */
export interface RepositoryDraftTestResult {
  readonly id: string;
  readonly outcome: RepositoryDraftTestOutcome;
  readonly completedAt: string;
}

/**
 * Safe non-terminal response for a duplicate request while a durable claim is
 * still live. It is deliberately not a `RepositoryDraftTestResult`: acceptance
 * cannot be mistaken for a completed test or used to activate a repository.
 */
export interface RepositoryDraftTestInProgress {
  readonly id: string;
  readonly outcome: "accepted";
  readonly status: "inProgress";
  readonly acceptedAt: string;
}

/** API-usable, redacted execution response with an explicit terminal boundary. */
export type RepositoryDraftTestExecutionResult =
  | Readonly<{
      readonly kind: "inProgress";
      readonly result: RepositoryDraftTestInProgress;
    }>
  | Readonly<{
      readonly kind: "terminal";
      readonly result: RepositoryDraftTestResult;
    }>;

/**
 * Server-private candidate resolved from an existing immutable draft/version.
 * Implementations calculate `candidateDigest` from canonical private settings,
 * normalized secret registration IDs, and the safe feature projection.
 */
export interface ResolvedRepositoryDraftCandidate {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly candidateVersionId: string;
  readonly candidateDigest: string;
}

/** The resolver accepts only opaque selected identifiers, never candidate values. */
export interface RepositoryDraftTestCandidateResolver {
  resolveCandidate(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly candidateVersionId: string;
  }): Promise<ResolvedRepositoryDraftCandidate | undefined>;
}

/**
 * Server-private execution material for one validated inert candidate. It is
 * separate from the browser-facing digest: a remote URL, deployment alias,
 * exact ref, or external secret locator may exist only at this trusted runner
 * boundary.
 */
export interface ServerPrivateRepositoryDraftTestCandidate {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly candidateVersionId: string;
  readonly candidateDigest: string;
  readonly location:
    | Readonly<{
        readonly mode: "remoteHttps";
        readonly remoteUrl: string;
        readonly checkoutSecretReference?: string;
      }>
    | Readonly<{
        readonly mode: "deploymentMounted";
        readonly mountAlias: string;
      }>;
  readonly checkoutRef:
    | Readonly<{ readonly kind: "branch" | "tag"; readonly name: string }>
    | Readonly<{ readonly kind: "commit"; readonly sha: string }>;
}

/** Resolves an exact candidate only after durable confirmation/claim. */
export interface RepositoryDraftTestExecutionCandidateResolver {
  resolveExecutionCandidate(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly candidateVersionId: string;
    readonly candidateDigest: string;
  }): Promise<ServerPrivateRepositoryDraftTestCandidate | undefined>;
}

export interface RepositoryDraftTestAudit {
  readonly workspaceId: string;
  readonly actorPrincipalId: string;
  readonly action:
    | typeof repositoryDraftTestPreviewAuditAction
    | typeof repositoryDraftTestAuditAction;
  readonly targetType: "code-repository";
  readonly targetId: string;
  readonly permission: "configuration.manage";
  readonly outcome: "succeeded" | "failed";
  readonly occurredAt: string;
  readonly idempotencyKeyDigest?: string;
}

/**
 * Durable confirmation/idempotency/audit boundary. `consumeAndClaim` is the
 * only operation permitted to consume a one-use confirmation: persistence
 * verifies session, expiry, exact candidate identity, and idempotency atomically.
 * It uses database transaction time for claim leases. A still-live claim must
 * return `inProgress`; only a claim already expired according to that database
 * policy may be reclaimed as a new `claimed` result.
 */
export interface RepositoryDraftTestStore {
  issueAndRecord(input: {
    readonly identity: RepositoryDraftTestIdentity;
    readonly audit: RepositoryDraftTestAudit;
    readonly now: string;
  }): Promise<RepositoryDraftTestPreview>;
  consumeAndClaim(input: {
    readonly identity: RepositoryDraftTestIdentity;
    readonly confirmationId: string;
    readonly idempotencyKeyDigest: string;
  }): Promise<
    | Readonly<{ readonly kind: "claimed"; readonly claimId: string }>
    | Readonly<{
        readonly kind: "inProgress";
        readonly result: RepositoryDraftTestInProgress;
      }>
    | Readonly<{
        readonly kind: "terminal";
        readonly result: RepositoryDraftTestResult;
      }>
    | Readonly<{ readonly kind: "conflict" }>
  >;
  completeAndRecord(input: {
    readonly claimId: string;
    readonly identity: RepositoryDraftTestIdentity;
    readonly result: Omit<RepositoryDraftTestResult, "id">;
    readonly audit: RepositoryDraftTestAudit;
  }): Promise<RepositoryDraftTestResult>;
  /** Fails closed unless the exact candidate has one successful terminal test. */
  requireSuccessfulCandidate(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly candidateDigest: string;
  }): Promise<void>;
}

/**
 * The runner owns private candidate recovery and non-destructive ref resolution.
 * It must return only a terminal state; it cannot disclose a remote URL, ref,
 * mount, path, secret, response, or error to this administration contract.
 */
export interface RepositoryDraftTestRunner {
  run(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly candidateVersionId: string;
    readonly candidateDigest: string;
    readonly signal: AbortSignal;
  }): Promise<RepositoryDraftTestOutcome>;
}

export interface RepositoryConfigurationActivationGuard {
  requireSuccessfulCandidate(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly candidateDigest: string;
  }): Promise<void>;
}

export interface RepositoryDraftTestClock {
  now(): string;
}

export interface PreviewRepositoryDraftTestCommand {
  /** Values come from validated session/request context, not browser authority. */
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly repositoryId: string;
  readonly candidateVersionId: string;
}

export interface RunRepositoryDraftTestCommand
  extends PreviewRepositoryDraftTestCommand {
  readonly confirmationId: string;
  /** The transport hashes the raw idempotency key before this use case. */
  readonly idempotencyKeyDigest: string;
  readonly signal: AbortSignal;
}

/**
 * Calculates the private identity for an inert repository candidate. Callers
 * must use this only after server-side validation; neither its input nor its
 * output is a public DTO. Array order in write-only settings remains meaningful,
 * while secret registration identities are normalized as a set.
 */
export function repositoryDraftCandidateDigest(input: {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly secretReferenceIds: readonly string[];
  readonly projection: unknown;
}): string {
  validatePrivateCandidate(input);
  const canonical = canonicalizeConfiguration({
    settings: input.settings,
    secretReferenceIds: [...new Set(input.secretReferenceIds)].sort(),
    projection: input.projection,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Issues a session-bound confirmation for an existing server-selected draft
 * candidate. The store owns expiry and the atomic preview audit append.
 */
export class PreviewRepositoryDraftTest {
  public constructor(
    private readonly candidates: RepositoryDraftTestCandidateResolver,
    private readonly store: RepositoryDraftTestStore,
    private readonly clock: RepositoryDraftTestClock,
  ) {}

  public async execute(
    command: PreviewRepositoryDraftTestCommand,
  ): Promise<RepositoryDraftTestPreview> {
    validatePreviewCommand(command);
    const candidate = await resolveCandidate(this.candidates, command);
    const now = timestamp(this.clock.now());
    let preview: RepositoryDraftTestPreview;
    try {
      preview = await this.store.issueAndRecord({
        identity: identity(candidate, command),
        audit: audit({
          command,
          occurredAt: now,
          action: repositoryDraftTestPreviewAuditAction,
          outcome: "succeeded",
        }),
        now,
      });
    } catch {
      throw new AdministrationAuditUnavailableError();
    }
    validatePreview(preview, now);
    return Object.freeze({ ...preview });
  }
}

/**
 * Executes a bounded, non-destructive candidate test exactly once. The runner
 * is called only after durable confirmation consumption/idempotency acquisition.
 * A concurrent duplicate receives a safe accepted/in-progress response and
 * cannot replace or fabricate the original terminal outcome. Only persistence
 * may reclaim a database-time-expired claim according to its lease policy.
 */
export class RunRepositoryDraftTest {
  public constructor(
    private readonly candidates: RepositoryDraftTestCandidateResolver,
    private readonly store: RepositoryDraftTestStore,
    private readonly runner: RepositoryDraftTestRunner,
    private readonly clock: RepositoryDraftTestClock,
  ) {}

  public async execute(
    command: RunRepositoryDraftTestCommand,
  ): Promise<RepositoryDraftTestExecutionResult> {
    validateRunCommand(command);
    const candidate = await resolveCandidate(this.candidates, command);
    const identity_ = identity(candidate, command);
    const claim = await this.store.consumeAndClaim({
      identity: identity_,
      confirmationId: command.confirmationId,
      idempotencyKeyDigest: command.idempotencyKeyDigest,
    });
    if (claim.kind !== "claimed") {
      if (claim.kind === "inProgress") {
        return Object.freeze({
          kind: "inProgress",
          result: presentInProgress(claim.result),
        });
      }
      if (claim.kind === "terminal") {
        return Object.freeze({
          kind: "terminal",
          result: presentResult(claim.result),
        });
      }
      throw new IdempotencyConflictError();
    }
    identifier(claim.claimId);

    let outcome: RepositoryDraftTestOutcome;
    try {
      outcome = validateOutcome(
        await this.runner.run({
          workspaceId: candidate.workspaceId,
          repositoryId: candidate.repositoryId,
          candidateVersionId: candidate.candidateVersionId,
          candidateDigest: candidate.candidateDigest,
          signal: command.signal,
        }),
      );
    } catch {
      // A failed process or cancelled request cannot assert whether the remote
      // side completed. Preserve the safe unknown state rather than guessing.
      outcome = "outcome_unknown";
    }
    const completedAt = timestamp(this.clock.now());
    try {
      return Object.freeze({
        kind: "terminal",
        result: presentResult(
          await this.store.completeAndRecord({
            claimId: claim.claimId,
            identity: identity_,
            result: { outcome, completedAt },
            audit: audit({
              command,
              occurredAt: completedAt,
              action: repositoryDraftTestAuditAction,
              outcome: outcome === "completed" ? "succeeded" : "failed",
              idempotencyKeyDigest: command.idempotencyKeyDigest,
            }),
          }),
        ),
      });
    } catch {
      // A test without its authoritative terminal audit must not be reported as
      // complete. The retained claim prevents an automatic duplicate runner call.
      throw new AdministrationAuditUnavailableError();
    }
  }
}

function identity(
  candidate: ResolvedRepositoryDraftCandidate,
  command: PreviewRepositoryDraftTestCommand,
): RepositoryDraftTestIdentity {
  return Object.freeze({
    workspaceId: candidate.workspaceId,
    principalId: command.principalId,
    sessionId: command.sessionId,
    repositoryId: candidate.repositoryId,
    candidateVersionId: candidate.candidateVersionId,
    candidateDigest: candidate.candidateDigest,
  });
}

async function resolveCandidate(
  candidates: RepositoryDraftTestCandidateResolver,
  command: Pick<
    PreviewRepositoryDraftTestCommand,
    "workspaceId" | "repositoryId" | "candidateVersionId"
  >,
): Promise<ResolvedRepositoryDraftCandidate> {
  const candidate = await candidates.resolveCandidate(command);
  if (candidate === undefined) throw new AdministrationNotFoundError();
  validateCandidate(candidate, command);
  return Object.freeze({ ...candidate });
}

function audit(input: {
  readonly command: Pick<
    PreviewRepositoryDraftTestCommand,
    "workspaceId" | "principalId" | "repositoryId"
  >;
  readonly occurredAt: string;
  readonly action:
    | typeof repositoryDraftTestPreviewAuditAction
    | typeof repositoryDraftTestAuditAction;
  readonly outcome: "succeeded" | "failed";
  readonly idempotencyKeyDigest?: string;
}): RepositoryDraftTestAudit {
  return Object.freeze({
    workspaceId: input.command.workspaceId,
    actorPrincipalId: input.command.principalId,
    action: input.action,
    targetType: "code-repository",
    targetId: input.command.repositoryId,
    permission: "configuration.manage",
    outcome: input.outcome,
    occurredAt: input.occurredAt,
    ...(input.idempotencyKeyDigest === undefined
      ? {}
      : { idempotencyKeyDigest: input.idempotencyKeyDigest }),
  });
}

function presentResult(
  value: RepositoryDraftTestResult,
): RepositoryDraftTestResult {
  validateResult(value);
  return Object.freeze({ ...value });
}

function presentInProgress(
  value: RepositoryDraftTestInProgress,
): RepositoryDraftTestInProgress {
  validateInProgress(value);
  return Object.freeze({ ...value });
}

function validatePrivateCandidate(input: {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly secretReferenceIds: readonly string[];
  readonly projection: unknown;
}): void {
  if (
    !isCanonicalPrivateValue(input.settings) ||
    !isCanonicalPrivateValue(input.projection)
  ) {
    throw new AdministrationValidationError();
  }
  for (const secretReferenceId of input.secretReferenceIds) {
    identifier(secretReferenceId);
  }
}

/**
 * Candidate digests are security boundaries: accepting an object that the
 * generic JSON canonicalizer silently reduces (for example a `Date` or a
 * `Map`) could bind a confirmation to different private candidate material.
 * Accept only recursively plain, enumerable JSON data before canonicalizing.
 */
function isCanonicalPrivateValue(value: unknown): boolean {
  return isCanonicalPrivateValueWithin(value, new Set<object>());
}

function isCanonicalPrivateValueWithin(
  value: unknown,
  ancestors: Set<object>,
): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return canonicalArray(value, ancestors);
    }
    return canonicalRecord(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function canonicalArray(
  value: readonly unknown[],
  ancestors: Set<object>,
): boolean {
  if (Object.getPrototypeOf(value) !== Array.prototype) return false;
  const names = Object.getOwnPropertyNames(value);
  if (
    names.some(
      (name) => name !== "length" && !canonicalArrayIndex(name, value.length),
    ) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value") ||
      !isCanonicalPrivateValueWithin(descriptor.value, ancestors)
    ) {
      return false;
    }
  }
  return true;
}

function canonicalArrayIndex(name: string, length: number): boolean {
  const index = Number(name);
  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === name
  );
}

function canonicalRecord(value: object, ancestors: Set<object>): boolean {
  if (!plainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value") ||
      !isCanonicalPrivateValueWithin(descriptor.value, ancestors)
    ) {
      return false;
    }
  }
  return true;
}

function validateCandidate(
  candidate: ResolvedRepositoryDraftCandidate,
  command: Pick<
    PreviewRepositoryDraftTestCommand,
    "workspaceId" | "repositoryId" | "candidateVersionId"
  >,
): void {
  identifier(candidate.workspaceId);
  identifier(candidate.repositoryId);
  identifier(candidate.candidateVersionId);
  digest(candidate.candidateDigest);
  if (
    candidate.workspaceId !== command.workspaceId ||
    candidate.repositoryId !== command.repositoryId ||
    candidate.candidateVersionId !== command.candidateVersionId
  ) {
    throw new AdministrationValidationError();
  }
}

function validatePreviewCommand(
  command: PreviewRepositoryDraftTestCommand,
): void {
  identifier(command.workspaceId);
  identifier(command.principalId);
  identifier(command.sessionId);
  identifier(command.repositoryId);
  identifier(command.candidateVersionId);
}

function validateRunCommand(command: RunRepositoryDraftTestCommand): void {
  validatePreviewCommand(command);
  identifier(command.confirmationId);
  digest(command.idempotencyKeyDigest);
  if (!(command.signal instanceof AbortSignal)) {
    throw new AdministrationValidationError();
  }
}

function validatePreview(value: RepositoryDraftTestPreview, now: string): void {
  identifier(value.confirmationId);
  boundedText(value.confirmation);
  boundedText(value.impact);
  if (
    new Date(timestamp(value.expiresAt)).getTime() <= new Date(now).getTime()
  ) {
    throw new AdministrationValidationError();
  }
}

function validateResult(value: RepositoryDraftTestResult): void {
  identifier(value.id);
  validateOutcome(value.outcome);
  timestamp(value.completedAt);
}

function validateInProgress(value: RepositoryDraftTestInProgress): void {
  identifier(value.id);
  if (value.outcome !== "accepted" || value.status !== "inProgress") {
    throw new AdministrationValidationError();
  }
  timestamp(value.acceptedAt);
}

function validateOutcome(value: unknown): RepositoryDraftTestOutcome {
  if (
    value !== "completed" &&
    value !== "failed" &&
    value !== "outcome_unknown"
  ) {
    throw new AdministrationValidationError();
  }
  return value;
}

function boundedText(value: string): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 2_000 ||
    /[\r\n]/u.test(value)
  ) {
    throw new AdministrationValidationError();
  }
}

function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)
  ) {
    throw new AdministrationValidationError();
  }
}

function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/iu.test(value)) {
    throw new AdministrationValidationError();
  }
}

function timestamp(value: unknown): string {
  if (typeof value !== "string") throw new AdministrationValidationError();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new AdministrationValidationError();
  }
  return value;
}

function plainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** A storage-backed activation guard can expose this directly to the manager. */
export const repositoryDraftTestActivationGuard = (
  store: RepositoryDraftTestStore,
): RepositoryConfigurationActivationGuard =>
  Object.freeze({
    requireSuccessfulCandidate: (input: {
      readonly workspaceId: string;
      readonly repositoryId: string;
      readonly candidateDigest: string;
    }) => store.requireSuccessfulCandidate(input),
  });
