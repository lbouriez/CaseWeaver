import { createHash } from "node:crypto";

import { sha256Digest, type Sha256Digest } from "@caseweaver/domain";

import { ConnectorIdempotencyConflictError } from "./errors.js";
import type {
  AttachmentMetadata,
  NormalizedActor,
  NormalizedCase,
} from "./schemas.js";

export const CASE_NORMALIZATION_VERSION =
  "caseweaver.case-normalization.v1" as const;

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

function canonicalize(value: unknown, inArray = false): CanonicalJson {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        "Canonical JSON does not support non-finite numbers.",
      );
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, true));
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        "Canonical JSON accepts plain objects, arrays, and primitive values only.",
      );
    }

    const output: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) {
        continue;
      }
      output[key] = canonicalize(item);
    }
    return output;
  }

  if (value === undefined && !inArray) {
    throw new TypeError("Top-level canonical JSON cannot be undefined.");
  }

  throw new TypeError("Canonical JSON accepts JSON-compatible values only.");
}

/**
 * Produces JSON with lexicographically sorted object keys while retaining every array's
 * original order. Undefined object properties are omitted, matching JSON semantics.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256CanonicalJson(value: unknown): Sha256Digest {
  return sha256Digest(
    createHash("sha256").update(canonicalJson(value), "utf8").digest("hex"),
  );
}

function actorRevisionInput(actor: NormalizedActor): object {
  return {
    externalId: actor.externalId,
    displayName: actor.displayName,
    kind: actor.kind,
  };
}

function attachmentRevisionInput(attachment: AttachmentMetadata): object {
  return {
    reference: attachment.reference,
    fileName: attachment.fileName,
    mediaType: attachment.mediaType,
    contentLength: attachment.contentLength,
    contentHash: attachment.contentHash,
    externalRevision: attachment.externalRevision,
  };
}

/**
 * Selects only neutral content-bearing fields. Connector metadata, source observation
 * time, and original (potentially non-normalized) message bodies are intentionally
 * excluded from a case revision.
 */
export function normalizedCaseRevisionInput(
  caseSnapshot: NormalizedCase,
  normalizationVersion = CASE_NORMALIZATION_VERSION,
): object {
  return {
    normalizationVersion,
    case: {
      reference: caseSnapshot.reference,
      externalRevision: caseSnapshot.externalRevision,
      subject: caseSnapshot.subject,
      lifecycle: caseSnapshot.lifecycle,
      priority: caseSnapshot.priority,
      category: caseSnapshot.category,
      tags: caseSnapshot.tags,
      actors:
        caseSnapshot.actors === undefined
          ? undefined
          : {
              requester:
                caseSnapshot.actors.requester === undefined
                  ? undefined
                  : actorRevisionInput(caseSnapshot.actors.requester),
              assignee:
                caseSnapshot.actors.assignee === undefined
                  ? undefined
                  : actorRevisionInput(caseSnapshot.actors.assignee),
              participants:
                caseSnapshot.actors.participants?.map(actorRevisionInput),
              tenant:
                caseSnapshot.actors.tenant === undefined
                  ? undefined
                  : actorRevisionInput(caseSnapshot.actors.tenant),
              company:
                caseSnapshot.actors.company === undefined
                  ? undefined
                  : actorRevisionInput(caseSnapshot.actors.company),
            },
      timestamps: caseSnapshot.timestamps,
      access:
        caseSnapshot.access === undefined
          ? undefined
          : {
              scope: caseSnapshot.access.scope,
              principals:
                caseSnapshot.access.principals?.map(actorRevisionInput),
              groups: caseSnapshot.access.groups,
            },
      resolution: caseSnapshot.resolution,
    },
    messages: caseSnapshot.messages.map((message) => ({
      externalId: message.externalId,
      sequence: message.sequence,
      author:
        message.author === undefined
          ? undefined
          : actorRevisionInput(message.author),
      sentAt: message.sentAt,
      visibility: message.visibility,
      body: {
        format: message.body.format,
        normalizedText: message.body.normalizedText,
      },
      externalRevision: message.externalRevision,
      attachments: message.attachments.map(attachmentRevisionInput),
    })),
    attachments: caseSnapshot.attachments.map(attachmentRevisionInput),
  };
}

export function normalizedCaseRevision(
  caseSnapshot: NormalizedCase,
  normalizationVersion = CASE_NORMALIZATION_VERSION,
): Sha256Digest {
  return sha256CanonicalJson(
    normalizedCaseRevisionInput(caseSnapshot, normalizationVersion),
  );
}

export interface IdempotencyRequest {
  readonly key: string;
  readonly requestHash: Sha256Digest;
}

export function sameIdempotencyRequest(
  existing: IdempotencyRequest,
  incoming: IdempotencyRequest,
): boolean {
  return (
    existing.key === incoming.key &&
    existing.requestHash === incoming.requestHash
  );
}

/**
 * An idempotency key may be reused only for the exact canonical request it first named.
 * The error deliberately contains neither request body nor request hash.
 */
export function assertIdempotencyRequest(
  operation: string,
  existing: IdempotencyRequest,
  incoming: IdempotencyRequest,
): void {
  if (
    existing.key === incoming.key &&
    existing.requestHash !== incoming.requestHash
  ) {
    throw new ConnectorIdempotencyConflictError(operation);
  }
}
