import { createHash } from "node:crypto";

import {
  type PrincipalId,
  type Sha256Digest,
  sha256Digest,
  type WorkspaceId,
} from "@caseweaver/domain";
import type { Permission } from "@caseweaver/security";

import { canonicalizeConfiguration } from "./configuration.js";
import type { CursorPage, CursorPosition } from "./pagination.js";
import { validatePageLimit } from "./pagination.js";

/**
 * These names identify administration operations, not HTTP routes or queue
 * commands. The composition layer maps each one to the existing analysis,
 * publication, and operations use cases; this package does not recreate policy.
 */
export const administrationOperationActions = [
  "analysis.forceRerun",
  "knowledgeSource.synchronize",
  "knowledgeSource.fullRescan",
  "publication.approve",
  "deadLetter.retry",
  "job.cancel",
  "job.recover",
  "retention.reap",
  "privacy.purge",
  "secret.rotate",
  "secret.revoke",
  "configuration.activate",
  "configuration.disable",
] as const;

export type AdministrationOperationAction =
  (typeof administrationOperationActions)[number];

/** Server-owned authorization mapping; callers must not select a permission. */
export function requiredOperationPermission(
  action: AdministrationOperationAction,
): Permission {
  switch (action) {
    case "analysis.forceRerun":
      return "analysis.forceRerun";
    case "knowledgeSource.synchronize":
    case "knowledgeSource.fullRescan":
      return "connector.manage";
    case "publication.approve":
      return "publication.approve";
    case "deadLetter.retry":
      return "operations.retry";
    case "job.cancel":
      return "analysis.cancel";
    case "job.recover":
      return "operations.recover";
    case "retention.reap":
      return "retention.run";
    case "privacy.purge":
      return "privacy.delete";
    case "secret.rotate":
    case "secret.revoke":
      return "credential.manage";
    case "configuration.activate":
    case "configuration.disable":
      return "configuration.manage";
  }
}

export const administrationOperationResources = [
  "analysis",
  "knowledgeSource",
  "publication",
  "job",
  "deadLetter",
  "retention",
  "caseSnapshot",
  "secretReference",
  "configuration",
] as const;

export type AdministrationOperationResource =
  (typeof administrationOperationResources)[number];

export interface AdministrationOperationTarget {
  readonly resource: AdministrationOperationResource;
  readonly id?: string;
}

export interface AdministrationOperationRequestContext {
  readonly workspaceId: WorkspaceId;
  readonly principalId: PrincipalId;
  readonly sessionId: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly uiActionId?: string;
  readonly requestMode: "user" | "passive_poll";
}

/** Bounded common query input. Adapters must apply the workspace predicate first. */
export interface AdministrationOperationsQuery {
  readonly workspaceId: WorkspaceId;
  readonly limit: number;
  readonly after?: CursorPosition;
}

export interface AdministrationOperationListItem {
  readonly id: string;
  readonly label: string;
  readonly status?: string;
  readonly updatedAt: string;
  readonly summary?: string;
}

export interface AdministrationOperationDetail
  extends AdministrationOperationListItem {
  /**
   * Values are deliberately scalar and redacted. Protected snapshots, evidence,
   * connector payloads, provider responses, receipts, and exception text have
   * dedicated access flows and never belong in this generic administrative DTO.
   */
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DashboardSummary {
  readonly generatedAt: string;
  readonly queueDepth: number;
  readonly activeJobs: number;
  readonly failedJobs: number;
  readonly budgetWarnings: number;
  readonly publicationOutcomeUnknown: number;
}

export interface OperationsReadPort {
  dashboard(input: AdministrationOperationsQuery): Promise<DashboardSummary>;
  listAnalyses(
    input: AdministrationOperationsQuery,
  ): Promise<CursorPage<AdministrationOperationListItem>>;
  findAnalysis(
    input: Readonly<{ readonly workspaceId: WorkspaceId; readonly id: string }>,
  ): Promise<AdministrationOperationDetail | undefined>;
  listPublications(
    input: AdministrationOperationsQuery,
  ): Promise<CursorPage<AdministrationOperationListItem>>;
  findPublication(
    input: Readonly<{ readonly workspaceId: WorkspaceId; readonly id: string }>,
  ): Promise<AdministrationOperationDetail | undefined>;
  listJobs(
    input: AdministrationOperationsQuery,
  ): Promise<CursorPage<AdministrationOperationListItem>>;
  findJob(
    input: Readonly<{ readonly workspaceId: WorkspaceId; readonly id: string }>,
  ): Promise<AdministrationOperationDetail | undefined>;
  listDeadLetters(
    input: AdministrationOperationsQuery,
  ): Promise<CursorPage<AdministrationOperationListItem>>;
  findDeadLetter(
    input: Readonly<{ readonly workspaceId: WorkspaceId; readonly id: string }>,
  ): Promise<AdministrationOperationDetail | undefined>;
  listCosts(
    input: AdministrationOperationsQuery &
      Readonly<{
        readonly analysisJobId?: string;
        readonly connectorInstanceId?: string;
        readonly sourceId?: string;
        readonly providerInstanceId?: string;
        readonly role?: string;
      }>,
  ): Promise<CursorPage<AdministrationOperationListItem>>;
  listAuditEvents(
    input: AdministrationOperationsQuery,
  ): Promise<CursorPage<AdministrationOperationListItem>>;
}

export const operationsReadResources = [
  "overview",
  "analyses",
  "publications",
  "jobs",
  "deadLetters",
  "costs",
  "auditEvents",
] as const;

export type OperationsReadResource = (typeof operationsReadResources)[number];

/** Server-owned permission mapping for every operations read model. */
export function requiredOperationsReadPermission(
  resource: OperationsReadResource,
): Permission {
  switch (resource) {
    case "overview":
    case "jobs":
    case "deadLetters":
      return "operations.inspect";
    case "analyses":
    case "publications":
      return "analysis.read";
    case "costs":
      return "cost.read";
    case "auditEvents":
      return "audit.read";
  }
}

/**
 * Validates the intentionally small page budget shared by the operational UI.
 * A caller supplies the decoded cursor only after its HTTP boundary validation.
 */
export function operationsQuery(
  input: Omit<AdministrationOperationsQuery, "limit"> & {
    readonly limit?: number;
  },
): AdministrationOperationsQuery {
  return Object.freeze({
    ...input,
    limit: validatePageLimit(input.limit, 100),
  });
}

export interface PrivacyPurgeParameters {
  readonly reason: string;
}

export interface RetentionReapParameters {
  readonly limit: number;
}

export interface ConfigurationLifecycleParameters {
  readonly resourceType: "connector-instances" | "ai-provider-instances";
}

export interface KnowledgeSourceCommandParameters {
  readonly kind: "synchronize" | "fullRescan";
}

export type AdministrationOperationParameters =
  | Readonly<Record<string, never>>
  | PrivacyPurgeParameters
  | RetentionReapParameters
  | KnowledgeSourceCommandParameters
  | ConfigurationLifecycleParameters;

export interface AdministrationOperationCommand {
  readonly action: AdministrationOperationAction;
  readonly target: AdministrationOperationTarget;
  readonly parameters: AdministrationOperationParameters;
}

/**
 * Validates semantic action/target pairs before an adapter resolves records or
 * invokes a feature use case. It intentionally does not authorize anything.
 */
export function validateOperationCommand(
  command: AdministrationOperationCommand,
): AdministrationOperationCommand {
  if (
    !(administrationOperationActions as readonly string[]).includes(
      command.action,
    )
  ) {
    throw new Error("The operation action is invalid.");
  }
  if (
    !isOperationTarget(command.target) ||
    !isPlainRecord(command.parameters)
  ) {
    throw new Error("The operation command is invalid.");
  }
  const requiresId = (resource: AdministrationOperationResource): void => {
    if (
      command.target.resource !== resource ||
      command.target.id === undefined ||
      !isStableIdentifier(command.target.id)
    ) {
      throw new Error("The operation target is invalid.");
    }
  };
  const requiresNoId = (resource: AdministrationOperationResource): void => {
    if (
      command.target.resource !== resource ||
      command.target.id !== undefined
    ) {
      throw new Error("The operation target is invalid.");
    }
  };

  switch (command.action) {
    case "analysis.forceRerun":
      requiresId("analysis");
      requireEmptyParameters(command.parameters);
      break;
    case "knowledgeSource.synchronize":
      requiresId("knowledgeSource");
      requireKnowledgeSourceParameters(command.parameters, "synchronize");
      break;
    case "knowledgeSource.fullRescan":
      requiresId("knowledgeSource");
      requireKnowledgeSourceParameters(command.parameters, "fullRescan");
      break;
    case "publication.approve":
      requiresId("publication");
      requireEmptyParameters(command.parameters);
      break;
    case "deadLetter.retry":
      requiresId("deadLetter");
      requireEmptyParameters(command.parameters);
      break;
    case "job.cancel":
    case "job.recover":
      requiresId("job");
      requireEmptyParameters(command.parameters);
      break;
    case "retention.reap":
      requiresNoId("retention");
      requireRetentionParameters(command.parameters);
      break;
    case "privacy.purge":
      requiresId("caseSnapshot");
      requirePrivacyParameters(command.parameters);
      break;
    case "secret.rotate":
    case "secret.revoke":
      requiresId("secretReference");
      requireEmptyParameters(command.parameters);
      break;
    case "configuration.activate":
    case "configuration.disable":
      requiresId("configuration");
      requireConfigurationLifecycleParameters(command.parameters);
      break;
  }
  return Object.freeze(command);
}

/** Canonical digest; plaintext operation parameters must never enter audit metadata. */
export function digestOperationCommand(
  command: AdministrationOperationCommand,
): Sha256Digest {
  const valid = validateOperationCommand(command);
  return sha256Digest(
    createHash("sha256")
      .update(canonicalizeConfiguration(valid), "utf8")
      .digest("hex"),
  );
}

export interface AdministrationActionPreview {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly principalId: PrincipalId;
  readonly sessionId: string;
  readonly action: AdministrationOperationAction;
  readonly target: AdministrationOperationTarget;
  readonly parameterDigest: Sha256Digest;
  readonly permission: Permission;
  readonly confirmation: string;
  readonly impact: string;
  readonly canConfirm: boolean;
  readonly estimatedCost?: Readonly<{
    readonly amount: string;
    readonly currency: string;
  }>;
  readonly expiresAt: string;
  readonly consumedAt?: string;
}

/**
 * Persistence-only preview representation. The public preview DTO deliberately
 * omits the command parameters; a stored preview retains them only long enough
 * to invoke the already-approved use case after the explicit confirmation.
 */
export interface StoredAdministrationActionPreview
  extends AdministrationActionPreview {
  readonly command: AdministrationOperationCommand;
}

/**
 * Preflight is supplied by the feature-owning composition. It determines real
 * impact/cost/eligibility without the administration layer inventing a result.
 */
export interface AdministrationOperationPreflightPort {
  preview(
    input: Readonly<{
      readonly command: AdministrationOperationCommand;
      readonly context: AdministrationOperationRequestContext;
    }>,
  ): Promise<
    Readonly<{
      readonly confirmation: string;
      readonly impact: string;
      readonly canConfirm: boolean;
      readonly estimatedCost?: Readonly<{
        readonly amount: string;
        readonly currency: string;
      }>;
    }>
  >;
}

/**
 * Durable storage is required so a preview cannot be forged, transferred to a
 * different principal/workspace/session, or replayed after process restart.
 * `consume` atomically checks every binding, expiry, and one-use state.
 */
export interface AdministrationActionPreviewStore {
  create(preview: StoredAdministrationActionPreview): Promise<void>;
  consume(
    input: Readonly<{
      readonly previewId: string;
      readonly workspaceId: WorkspaceId;
      readonly principalId: PrincipalId;
      readonly sessionId: string;
      readonly now: string;
    }>,
  ): Promise<StoredAdministrationActionPreview | undefined>;
}

/**
 * The application composition adapter calls the existing feature use case for
 * the selected action. It receives only digests and trusted session context;
 * neither frontend permissions nor raw operation parameters are authoritative.
 */
export interface AdministrationOperationsCommandPort {
  execute(
    input: Readonly<{
      readonly command: AdministrationOperationCommand;
      readonly requestDigest: Sha256Digest;
      readonly idempotencyKeyDigest: Sha256Digest;
      readonly context: AdministrationOperationRequestContext;
    }>,
  ): Promise<
    Readonly<{
      readonly operationId: string;
      readonly outcome: "accepted" | "completed" | "outcome_unknown";
    }>
  >;
}

function isStableIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
}

function isPlainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isOperationTarget(
  value: unknown,
): value is AdministrationOperationTarget {
  if (
    !isPlainRecord(value) ||
    typeof value.resource !== "string" ||
    !(administrationOperationResources as readonly string[]).includes(
      value.resource,
    )
  ) {
    return false;
  }
  return (
    value.id === undefined ||
    (typeof value.id === "string" && isStableIdentifier(value.id))
  );
}

function requireEmptyParameters(
  value: AdministrationOperationParameters,
): void {
  if (Object.keys(value).length !== 0) {
    throw new Error("This operation does not accept parameters.");
  }
}

function requirePrivacyParameters(
  value: AdministrationOperationParameters,
): void {
  if (
    Object.keys(value).length !== 1 ||
    !("reason" in value) ||
    typeof value.reason !== "string" ||
    value.reason.trim().length < 1 ||
    value.reason.length > 4_000
  ) {
    throw new Error("A privacy purge requires a bounded reason.");
  }
}

function requireRetentionParameters(
  value: AdministrationOperationParameters,
): void {
  if (
    Object.keys(value).length !== 1 ||
    !("limit" in value) ||
    typeof value.limit !== "number" ||
    !Number.isInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 1_000
  ) {
    throw new Error("Retention reaping requires a bounded limit.");
  }
}

function requireKnowledgeSourceParameters(
  value: AdministrationOperationParameters,
  kind: KnowledgeSourceCommandParameters["kind"],
): void {
  if (
    Object.keys(value).length !== 1 ||
    !("kind" in value) ||
    value.kind !== kind
  ) {
    throw new Error("Knowledge source command parameters are invalid.");
  }
}

function requireConfigurationLifecycleParameters(
  value: AdministrationOperationParameters,
): void {
  if (
    Object.keys(value).length !== 1 ||
    !("resourceType" in value) ||
    (value.resourceType !== "connector-instances" &&
      value.resourceType !== "ai-provider-instances")
  ) {
    throw new Error("Configuration lifecycle parameters are invalid.");
  }
}
