import { createHash } from "node:crypto";

import type {
  ExternalReference,
  VersionedOpaqueValue,
} from "@caseweaver/connector-sdk";

import type {
  EmbeddingCacheIdentity,
  NormalizedKnowledgeDocument,
} from "./types.js";

interface CanonicalArray extends ReadonlyArray<CanonicalValue> {}

interface CanonicalObject {
  readonly [key: string]: CanonicalValue;
}

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalArray
  | CanonicalObject;

function canonicalize(value: CanonicalValue): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RangeError(
        "Canonical hashes do not support non-finite numbers.",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value as CanonicalObject;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalize(record[key] as CanonicalValue)}`,
    )
    .join(",")}}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalSha256(value: CanonicalValue): string {
  return sha256(canonicalize(value));
}

export function sameOpaqueValue(
  left: VersionedOpaqueValue | undefined,
  right: VersionedOpaqueValue | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.version === right.version &&
    left.value === right.value
  );
}

export function sameReference(
  left: ExternalReference,
  right: ExternalReference,
): boolean {
  return (
    left.connectorInstanceId === right.connectorInstanceId &&
    left.resourceType === right.resourceType &&
    left.externalId === right.externalId
  );
}

export function normalizedContentHash(
  normalizationProfileVersion: string,
  document: NormalizedKnowledgeDocument,
): string {
  return canonicalSha256({
    normalizationProfileVersion,
    normalizedText: document.normalizedText,
    attachmentIdentity: document.attachmentIdentity ?? null,
  });
}

export function chunkContentHash(content: string): string {
  return sha256(content);
}

export function deterministicChunkId(
  revisionId: string,
  chunkingProfileVersion: string,
  position: number,
): string {
  return canonicalSha256({
    kind: "knowledge.chunk.v1",
    revisionId,
    chunkingProfileVersion,
    position,
  });
}

export function embeddingCacheIdentityKey(
  identity: EmbeddingCacheIdentity,
): string {
  return canonicalSha256({
    kind: "knowledge.embedding-cache.v1",
    chunkHash: identity.chunkHash,
    embeddingBindingVersionId: identity.embeddingBindingVersionId,
    embeddingProfileVersion: identity.embeddingProfileVersion,
    dimensions: identity.dimensions,
    normalizationProfileVersion: identity.normalizationProfileVersion,
  });
}
