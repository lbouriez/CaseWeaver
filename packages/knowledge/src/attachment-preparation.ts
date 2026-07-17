import { createHash } from "node:crypto";

import type {
  ActivatedAttachmentPreparation,
  AttachmentPreparationOutcome,
  AttachmentPreparationPolicy,
  AttachmentPreparationResult,
  AttachmentPreparationWarning,
  PreparedAttachment,
  SelectedAttachmentDerivative,
} from "./types.js";

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

/**
 * Stable, safe identity for the immutable policy selected by a source version.
 *
 * This intentionally excludes every attachment occurrence, derivative, warning,
 * and any source content. It is safe to retain on the active knowledge item so
 * the ingestion no-op path can tell a legacy/no-policy revision from a revision
 * prepared under a different immutable policy without persisting the policy
 * itself on that read model.
 */
export function attachmentPreparationPolicyIdentityHash(
  policy: AttachmentPreparationPolicy,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "caseweaver.attachment-preparation-policy.v1",
        policy: normalizedPolicy(policy),
      }),
      "utf8",
    )
    .digest("hex");
}

function selectedDerivative(
  derivative: PreparedAttachment | SelectedAttachmentDerivative,
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
 * This is intentionally byte-for-byte compatible with the attachment package's
 * identity factory. The knowledge consumer validates only this safe projection
 * rather than importing a sibling feature package or receiving any blob/locator.
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
            Object.freeze({ ...selectedDerivative(derivative) }),
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
 * Creates the only attachment result shape that may cross into an activation
 * mutation. Policy is deliberately omitted: it belongs to the immutable source
 * configuration, and its hash is carried separately for no-op comparison.
 */
export function activatedAttachmentPreparation(
  outcome: AttachmentPreparationOutcome,
): ActivatedAttachmentPreparation {
  return Object.freeze({
    status: outcome.status,
    identityHash: outcome.identityHash,
    selectedDerivatives: Object.freeze(
      outcome.selectedDerivatives.map(selectedDerivative),
    ),
    warnings: Object.freeze(outcome.warnings.map(normalizedWarning)),
    retryRequired: outcome.retryRequired,
  });
}

function samePolicy(
  left: AttachmentPreparationPolicy,
  right: AttachmentPreparationPolicy,
): boolean {
  return (
    left.mode === right.mode &&
    left.policyVersion === right.policyVersion &&
    left.accessPolicyHash === right.accessPolicyHash
  );
}

function sameDerivative(
  left: SelectedAttachmentDerivative,
  right: SelectedAttachmentDerivative,
): boolean {
  return (
    left.occurrenceIdentity === right.occurrenceIdentity &&
    left.derivativeIdentity === right.derivativeIdentity &&
    left.derivativeContentHash === right.derivativeContentHash
  );
}

function sameWarning(
  left: AttachmentPreparationWarning,
  right: AttachmentPreparationWarning,
): boolean {
  return (
    left.kind === right.kind &&
    left.code === right.code &&
    left.retryable === right.retryable &&
    left.occurrenceIdentity === right.occurrenceIdentity
  );
}

function safeDerivatives(
  derivatives: readonly PreparedAttachment[],
): readonly PreparedAttachment[] {
  return sortUnique(
    derivatives.map((derivative) => {
      if (typeof derivative.searchableText !== "string") {
        throw new RangeError(
          "Attachment preparation searchable text is invalid.",
        );
      }
      return Object.freeze({
        ...selectedDerivative(derivative),
        searchableText: derivative.searchableText,
      });
    }),
    derivativeSortKey,
    "selected derivative identities",
  );
}

/**
 * Fails closed when an attachment implementation returns an outcome that does
 * not faithfully describe its selected derivative work. Only a copied safe
 * projection and server-private derivative text are returned to ingestion.
 */
export function validateAttachmentPreparationResult(input: {
  readonly result: AttachmentPreparationResult;
  readonly policy: AttachmentPreparationPolicy;
}): AttachmentPreparationResult {
  const policy = normalizedPolicy(input.policy);
  const outcomePolicy = normalizedPolicy(input.result.outcome.policy);
  if (!samePolicy(policy, outcomePolicy)) {
    throw new RangeError(
      "Attachment preparation outcome does not match the pinned policy.",
    );
  }
  const derivatives = safeDerivatives(input.result.derivatives);
  const selectedDerivatives = sortUnique(
    derivatives.map(selectedDerivative),
    derivativeSortKey,
    "selected derivative identities",
  );
  const claimedDerivatives = sortUnique(
    input.result.outcome.selectedDerivatives.map(selectedDerivative),
    derivativeSortKey,
    "selected derivative identities",
  );
  if (
    selectedDerivatives.length !== claimedDerivatives.length ||
    selectedDerivatives.some(
      (derivative, index) =>
        !sameDerivative(
          derivative,
          claimedDerivatives[index] as SelectedAttachmentDerivative,
        ),
    )
  ) {
    throw new RangeError(
      "Attachment preparation outcome selected derivatives are inconsistent.",
    );
  }
  const warnings = sortUnique(
    input.result.outcome.warnings.map(normalizedWarning),
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
  const expectedStatus =
    policy.mode === "required" && warnings.length > 0 ? "terminal" : "prepared";
  const retryRequired = warnings.some((warning) => warning.retryable);
  const identityHash = attachmentPreparationIdentityHash({
    policy,
    selectedDerivatives,
    warnings,
  });
  if (
    input.result.outcome.status !== expectedStatus ||
    input.result.outcome.retryRequired !== retryRequired ||
    input.result.outcome.identityHash !== identityHash
  ) {
    throw new RangeError("Attachment preparation outcome is invalid.");
  }
  const claimedWarnings = sortUnique(
    input.result.outcome.warnings.map(normalizedWarning),
    warningSortKey,
    "warnings",
  );
  if (
    warnings.length !== claimedWarnings.length ||
    warnings.some(
      (warning, index) =>
        !sameWarning(
          warning,
          claimedWarnings[index] as AttachmentPreparationWarning,
        ),
    )
  ) {
    throw new RangeError("Attachment preparation warnings are inconsistent.");
  }
  return Object.freeze({
    outcome: Object.freeze({
      status: expectedStatus,
      identityHash,
      policy,
      selectedDerivatives,
      warnings,
      retryRequired,
    }),
    derivatives,
    ...(input.result.attemptId === undefined
      ? {}
      : { attemptId: requireIdentifier(input.result.attemptId, "attempt ID") }),
  });
}

export function unavailableAttachmentPreparation(
  policy: AttachmentPreparationPolicy,
): AttachmentPreparationResult {
  const normalized = normalizedPolicy(policy);
  const warnings: readonly AttachmentPreparationWarning[] =
    normalized.mode === "disabled"
      ? []
      : [
          Object.freeze({
            kind: "attachmentPreparationWarning",
            code: "attachment.preparation-unavailable",
            retryable: true,
          }),
        ];
  const selectedDerivatives: readonly SelectedAttachmentDerivative[] = [];
  const retryRequired = warnings.some((warning) => warning.retryable);
  return Object.freeze({
    outcome: Object.freeze({
      status:
        normalized.mode === "required" && warnings.length > 0
          ? "terminal"
          : "prepared",
      identityHash: attachmentPreparationIdentityHash({
        policy: normalized,
        selectedDerivatives,
        warnings,
      }),
      policy: normalized,
      selectedDerivatives,
      warnings,
      retryRequired,
    }),
    derivatives: [],
  });
}
