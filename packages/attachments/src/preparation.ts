import { createHash } from "node:crypto";

/**
 * An immutable caller policy. It is intentionally provider-neutral: processor
 * choice, byte streaming, cache claims, and AI execution remain PBI-008
 * implementation concerns.
 */
export type AttachmentPreparationMode = "disabled" | "optional" | "required";

export interface AttachmentPreparationPolicy {
  readonly mode: AttachmentPreparationMode;
  readonly policyVersion: string;
  /** Workspace-scoped access boundary; never a principal list or raw ACL. */
  readonly accessPolicyHash: string;
}

/**
 * A stable, opaque reference to one normalized attachment occurrence. It is
 * not a connector locator, blob key, URL, path, or external reference.
 */
export interface PreparedAttachmentDerivative {
  readonly occurrenceIdentity: string;
  /** Completed derivative-cache identity, never a storage handle. */
  readonly derivativeIdentity: string;
  /** SHA-256 of the canonical derivative bytes. */
  readonly derivativeContentHash: string;
  /**
   * Canonical derivative text. This is trusted server-side work input only and
   * is deliberately absent from AttachmentPreparationOutcome.
   */
  readonly searchableText: string;
}

/** A terminal, bounded diagnostic that is safe to persist with execution state. */
export interface AttachmentPreparationWarning {
  readonly kind: "attachmentPreparationWarning";
  readonly code: string;
  readonly retryable: boolean;
  /** Opaque occurrence identity when one was safely established. */
  readonly occurrenceIdentity?: string;
}

export interface SelectedAttachmentDerivative {
  readonly occurrenceIdentity: string;
  readonly derivativeIdentity: string;
  readonly derivativeContentHash: string;
}

/**
 * Safe execution state. It contains no derivative text, blob handle, URL,
 * connector locator, source text, file path, or secret material.
 */
export interface AttachmentPreparationOutcome {
  readonly status: "prepared" | "terminal";
  readonly identityHash: string;
  readonly policy: AttachmentPreparationPolicy;
  readonly selectedDerivatives: readonly SelectedAttachmentDerivative[];
  readonly warnings: readonly AttachmentPreparationWarning[];
  /** A completed retry can change evidence and therefore must not be hidden by a no-op. */
  readonly retryRequired: boolean;
}

export interface AttachmentPreparationResult {
  readonly outcome: AttachmentPreparationOutcome;
  /** Server-private derived text used only by trusted chunk/prompt assembly. */
  readonly derivatives: readonly PreparedAttachmentDerivative[];
}

export interface AttachmentPreparationResultInput {
  readonly policy: AttachmentPreparationPolicy;
  readonly derivatives?: readonly PreparedAttachmentDerivative[];
  readonly warnings?: readonly AttachmentPreparationWarning[];
}

const maximumIdentityPartLength = 1_024;
const maximumWarningCodeLength = 200;

function requireIdentifier(value: string, field: string): string {
  if (value.length === 0 || value.length > maximumIdentityPartLength) {
    throw new RangeError(`Attachment preparation ${field} is invalid.`);
  }
  return value;
}

function requireWarningCode(value: string): string {
  if (
    value.length === 0 ||
    value.length > maximumWarningCodeLength ||
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(value)
  ) {
    throw new RangeError("Attachment preparation warning code is invalid.");
  }
  return value;
}

function normalizedPolicy(
  policy: AttachmentPreparationPolicy,
): AttachmentPreparationPolicy {
  if (
    policy.mode !== "disabled" &&
    policy.mode !== "optional" &&
    policy.mode !== "required"
  ) {
    throw new RangeError("Attachment preparation mode is invalid.");
  }
  return Object.freeze({
    mode: policy.mode,
    policyVersion: requireIdentifier(policy.policyVersion, "policy version"),
    accessPolicyHash: requireIdentifier(
      policy.accessPolicyHash,
      "access policy hash",
    ),
  });
}

function selectedDerivative(
  derivative: PreparedAttachmentDerivative,
): SelectedAttachmentDerivative {
  return Object.freeze({
    occurrenceIdentity: requireIdentifier(
      derivative.occurrenceIdentity,
      "occurrence identity",
    ),
    derivativeIdentity: requireIdentifier(
      derivative.derivativeIdentity,
      "derivative identity",
    ),
    derivativeContentHash: requireIdentifier(
      derivative.derivativeContentHash,
      "derivative content hash",
    ),
  });
}

function normalizedWarning(
  warning: AttachmentPreparationWarning,
): AttachmentPreparationWarning {
  if (warning.kind !== "attachmentPreparationWarning") {
    throw new RangeError("Attachment preparation warning kind is invalid.");
  }
  return Object.freeze({
    kind: "attachmentPreparationWarning",
    code: requireWarningCode(warning.code),
    retryable: warning.retryable,
    ...(warning.occurrenceIdentity === undefined
      ? {}
      : {
          occurrenceIdentity: requireIdentifier(
            warning.occurrenceIdentity,
            "warning occurrence identity",
          ),
        }),
  });
}

function derivativeSortKey(value: SelectedAttachmentDerivative): string {
  return JSON.stringify([
    value.occurrenceIdentity,
    value.derivativeIdentity,
    value.derivativeContentHash,
  ]);
}

function warningSortKey(value: AttachmentPreparationWarning): string {
  return JSON.stringify([
    value.occurrenceIdentity ?? null,
    value.code,
    value.retryable,
  ]);
}

function sortUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  kind: string,
): readonly T[] {
  const sorted = [...values].sort((left, right) =>
    key(left).localeCompare(key(right)),
  );
  for (let index = 1; index < sorted.length; index += 1) {
    if (key(sorted[index - 1] as T) === key(sorted[index] as T)) {
      throw new RangeError(`Attachment preparation ${kind} must be unique.`);
    }
  }
  return Object.freeze(sorted);
}

/**
 * Hashes only safe, stable evidence metadata. Searchable derivative text is
 * represented by its already-verified content hash so it never enters safe
 * persistence, logs, diagnostics, or cache keys as plaintext.
 */
export function attachmentPreparationIdentityHash(input: {
  readonly policy: AttachmentPreparationPolicy;
  readonly selectedDerivatives: readonly SelectedAttachmentDerivative[];
  readonly warnings: readonly AttachmentPreparationWarning[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "caseweaver.attachment-preparation.v1",
        policy: normalizedPolicy(input.policy),
        selectedDerivatives: sortUnique(
          input.selectedDerivatives.map((derivative) =>
            Object.freeze({ ...derivative }),
          ),
          derivativeSortKey,
          "selected derivative identities",
        ),
        warnings: sortUnique(
          input.warnings.map(normalizedWarning),
          warningSortKey,
          "warnings",
        ),
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * Produces the only safe state that callers may persist or report. Its
 * derivative text remains on the result's private work-input branch and is
 * never copied into the outcome.
 */
export function createAttachmentPreparationResult(
  input: AttachmentPreparationResultInput,
): AttachmentPreparationResult {
  const policy = normalizedPolicy(input.policy);
  const derivatives = input.derivatives ?? [];
  const selectedDerivatives = sortUnique(
    derivatives.map(selectedDerivative),
    derivativeSortKey,
    "selected derivative identities",
  );
  const warnings = sortUnique(
    (input.warnings ?? []).map(normalizedWarning),
    warningSortKey,
    "warnings",
  );
  if (
    policy.mode === "disabled" &&
    (selectedDerivatives.length > 0 || warnings.length > 0)
  ) {
    throw new RangeError(
      "Disabled attachment preparation cannot produce derivatives or warnings.",
    );
  }
  const terminal = policy.mode === "required" && warnings.length > 0;
  const retryRequired = warnings.some((warning) => warning.retryable);
  const identityHash = attachmentPreparationIdentityHash({
    policy,
    selectedDerivatives,
    warnings,
  });

  const privateDerivatives = sortUnique(
    derivatives.map((derivative) =>
      Object.freeze({
        ...selectedDerivative(derivative),
        searchableText: derivative.searchableText,
      }),
    ),
    derivativeSortKey,
    "selected derivative identities",
  );
  return Object.freeze({
    outcome: Object.freeze({
      status: terminal ? "terminal" : "prepared",
      identityHash,
      policy,
      selectedDerivatives,
      warnings,
      retryRequired,
    }),
    derivatives: privateDerivatives,
  });
}
