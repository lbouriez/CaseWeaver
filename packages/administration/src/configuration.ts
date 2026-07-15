export type ConfigurationLifecycle =
  | "draft"
  | "active"
  | "disabled"
  | "superseded";

export interface VersionedConfiguration {
  readonly id: string;
  readonly workspaceId: string;
  readonly resourceType: string;
  readonly revision: number;
  readonly lifecycle: ConfigurationLifecycle;
  readonly currentVersionId?: string;
}

export interface ImmutableConfigurationVersion {
  readonly id: string;
  readonly workspaceId: string;
  readonly configurationId: string;
  readonly version: number;
  readonly canonicalSettings: string;
  readonly secretReferenceIds: readonly string[];
  readonly displayName?: string;
  readonly descriptor?: ConfigurationDescriptorReference;
}

export interface MutationIdentity {
  readonly operation: string;
  readonly keyDigest: string;
  readonly requestDigest: string;
}

export interface StoredMutationResult {
  readonly requestDigest: string;
  readonly resourceId: string;
}

export type IdempotencyResolution =
  | Readonly<{ readonly kind: "new" }>
  | Readonly<{ readonly kind: "replay"; readonly resourceId: string }>
  | Readonly<{ readonly kind: "conflict" }>;

export function resolveIdempotency(
  stored: StoredMutationResult | undefined,
  request: MutationIdentity,
): IdempotencyResolution {
  if (stored === undefined) {
    return Object.freeze({ kind: "new" });
  }
  if (stored.requestDigest === request.requestDigest) {
    return Object.freeze({ kind: "replay", resourceId: stored.resourceId });
  }
  return Object.freeze({ kind: "conflict" });
}

export function requireExpectedRevision(
  configuration: VersionedConfiguration,
  expectedRevision: number,
): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new RangeError("Expected revision must be a positive safe integer.");
  }
  if (configuration.revision !== expectedRevision) {
    throw new ConfigurationConflictError();
  }
}

export class ConfigurationConflictError extends Error {
  public constructor() {
    super("Configuration was changed by another operation.");
    this.name = "ConfigurationConflictError";
  }
}

export function canonicalizeConfiguration(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Configuration contains a non-finite number.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, canonicalize(object[key])]),
    );
  }
  throw new TypeError("Configuration must be JSON-compatible.");
}
import type { ConfigurationDescriptorReference } from "./descriptor.js";
