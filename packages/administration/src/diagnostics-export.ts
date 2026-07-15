const maximumDiagnosticExportEvents = 1_000;
const maximumDiagnosticExportBytes = 1_048_576;
const maximumDiagnosticAttributeDepth = 12;
const redactedValue = "[Redacted]";

export type DiagnosticExportStatus =
  | "requested"
  | "generating"
  | "ready"
  | "failed"
  | "expired"
  | "deleted";

export interface DiagnosticExportObject {
  readonly [key: string]: DiagnosticExportValue;
}

export type DiagnosticExportValue =
  | string
  | number
  | boolean
  | null
  | readonly DiagnosticExportValue[]
  | DiagnosticExportObject;

/** Values must already be redacted at their source; serialization redacts again defensively. */
export interface RedactedDiagnosticExportEvent {
  readonly name: string;
  readonly occurredAt: string;
  readonly severity: "debug" | "info" | "warn" | "error";
  readonly attributes: Readonly<Record<string, DiagnosticExportValue>>;
}

export interface DiagnosticExportRequest {
  readonly id: string;
  readonly workspaceId: string;
  readonly requestedByPrincipalId: string;
  readonly status: DiagnosticExportStatus;
  readonly eventCutoffAt: string;
  readonly maximumEvents: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly artifact?: DiagnosticExportArtifactMetadata;
  /** Server-only private object locator. Never map this to an HTTP DTO or audit. */
  readonly artifactLocator?: DiagnosticExportArtifactLocator;
  readonly failureCode?:
    | "source.unavailable"
    | "content.tooLarge"
    | "storage.unavailable";
}

/** Internal metadata only. It is never an HTTP DTO and exposes no storage key or URL. */
export interface DiagnosticExportArtifactMetadata {
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly contentType: "application/json";
  readonly eventCount: number;
  readonly generatedAt: string;
}

/** Public status shape intentionally excludes artifact handles, keys, and URLs. */
export interface DiagnosticExportStatusDto {
  readonly id: string;
  readonly status: DiagnosticExportStatus;
  readonly eventCutoffAt: string;
  readonly expiresAt: string;
  readonly generatedAt?: string;
  readonly failureCode?: DiagnosticExportRequest["failureCode"];
}

export interface DiagnosticExportArtifactHandle {
  readonly exportId: string;
  readonly workspaceId: string;
}

/** Opaque private-storage locator persisted only by the server-side adapter. */
export interface DiagnosticExportArtifactLocator {
  readonly storageKey: string;
}

export interface DiagnosticExportArtifactStore {
  write(
    input: Readonly<{
      readonly handle: DiagnosticExportArtifactHandle;
      readonly content: Uint8Array;
      readonly contentType: "application/json";
      readonly signal: AbortSignal;
    }>,
  ): Promise<DiagnosticExportArtifactLocator>;
  open(
    input: Readonly<{
      readonly handle: DiagnosticExportArtifactHandle;
      readonly locator: DiagnosticExportArtifactLocator;
      readonly signal: AbortSignal;
    }>,
  ): Promise<AsyncIterable<Uint8Array>>;
  delete(
    input: Readonly<{
      readonly handle: DiagnosticExportArtifactHandle;
      readonly locator: DiagnosticExportArtifactLocator;
    }>,
  ): Promise<void>;
}

export interface DiagnosticExportSource {
  snapshot(
    input: Readonly<{
      readonly workspaceId: string;
      readonly cutoffAt: string;
      readonly maximumEvents: number;
    }>,
  ): Promise<readonly RedactedDiagnosticExportEvent[]>;
}

export interface DiagnosticExportRequestStore {
  request(
    input: Readonly<{
      readonly request: DiagnosticExportRequest;
      readonly idempotencyKeyDigest: string;
      readonly requestDigest: string;
    }>,
  ): Promise<
    Readonly<{
      readonly request: DiagnosticExportRequest;
      readonly replayed: boolean;
    }>
  >;
  find(
    input: Readonly<{
      readonly workspaceId: string;
      readonly exportId: string;
    }>,
  ): Promise<DiagnosticExportRequest | undefined>;
  /** Claiming must be fenced/leased by the persistence adapter. */
  claimGeneration(
    input: Readonly<{
      readonly workspaceId: string;
      readonly exportId: string;
      readonly now: string;
    }>,
  ): Promise<DiagnosticExportRequest | undefined>;
  markReady(
    input: Readonly<{
      readonly workspaceId: string;
      readonly exportId: string;
      readonly artifact: DiagnosticExportArtifactMetadata;
      readonly locator: DiagnosticExportArtifactLocator;
    }>,
  ): Promise<void>;
  markFailed(
    input: Readonly<{
      readonly workspaceId: string;
      readonly exportId: string;
      readonly failureCode: NonNullable<DiagnosticExportRequest["failureCode"]>;
    }>,
  ): Promise<void>;
  expireDue(
    input: Readonly<{
      readonly now: string;
      readonly limit: number;
    }>,
  ): Promise<number>;
  claimDeletion(
    input: Readonly<{ readonly now: string; readonly limit: number }>,
  ): Promise<
    readonly Readonly<{
      readonly request: DiagnosticExportRequest;
      readonly claimToken: string;
    }>[]
  >;
  markDeleted(
    input: Readonly<{
      readonly workspaceId: string;
      readonly exportId: string;
      readonly claimToken: string;
    }>,
  ): Promise<void>;
}

/**
 * The accepting HTTP boundary must commit the durable request, its worker
 * command, and the server-owned audit event together. This is intentionally a
 * narrow port: it cannot expose storage data or admit arbitrary queues.
 */
export interface DiagnosticExportRequestMutationStore {
  requestAndEnqueueAndRecord(
    input: Readonly<{
      readonly request: DiagnosticExportRequest;
      readonly idempotencyKeyDigest: string;
      readonly requestDigest: string;
      readonly envelope: EnvelopeFor<"diagnostics.export.generate.v1">;
      readonly audit: AuditRecord;
    }>,
  ): Promise<
    Readonly<{
      readonly request: DiagnosticExportRequest;
      readonly replayed: boolean;
    }>
  >;
}

export interface DiagnosticExportClock {
  now(): string;
}

export interface DiagnosticExportDigest {
  sha256(content: Uint8Array): Promise<string>;
}

export interface RequestDiagnosticExportInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly requestedByPrincipalId: string;
  readonly idempotencyKeyDigest: string;
  readonly requestDigest: string;
  readonly expiresAt: string;
}

/**
 * Creates a bounded immutable export request. HTTP authorization and its atomic
 * audit write remain at the API transaction boundary; this result deliberately
 * contains only audit-safe IDs and lifecycle data.
 */
export async function requestDiagnosticExport(
  store: Pick<DiagnosticExportRequestStore, "request">,
  clock: DiagnosticExportClock,
  input: RequestDiagnosticExportInput,
): Promise<
  Readonly<{
    readonly status: DiagnosticExportStatusDto;
    readonly replayed: boolean;
  }>
> {
  const createdAt = clock.now();
  requireTimestamp(createdAt, "created");
  requireTimestamp(input.expiresAt, "expiry");
  if (new Date(input.expiresAt).getTime() <= new Date(createdAt).getTime()) {
    throw new RangeError("Diagnostic export expiry must be in the future.");
  }
  const request: DiagnosticExportRequest = Object.freeze({
    id: requireIdentifier(input.id, "export ID"),
    workspaceId: requireIdentifier(input.workspaceId, "workspace ID"),
    requestedByPrincipalId: requireIdentifier(
      input.requestedByPrincipalId,
      "principal ID",
    ),
    status: "requested",
    eventCutoffAt: createdAt,
    maximumEvents: maximumDiagnosticExportEvents,
    createdAt,
    expiresAt: input.expiresAt,
  });
  const result = await store.request({
    request,
    idempotencyKeyDigest: requireDigest(input.idempotencyKeyDigest),
    requestDigest: requireDigest(input.requestDigest),
  });
  return Object.freeze({
    status: toDiagnosticExportStatus(result.request),
    replayed: result.replayed,
  });
}

/** Runs outside an HTTP request after the durable request has been claimed. */
export async function generateDiagnosticExport(
  store: DiagnosticExportRequestStore,
  source: DiagnosticExportSource,
  artifacts: DiagnosticExportArtifactStore,
  digest: DiagnosticExportDigest,
  clock: DiagnosticExportClock,
  input: Readonly<{
    readonly workspaceId: string;
    readonly exportId: string;
    readonly signal: AbortSignal;
  }>,
): Promise<DiagnosticExportStatusDto | undefined> {
  const claimed = await store.claimGeneration({
    workspaceId: input.workspaceId,
    exportId: input.exportId,
    now: clock.now(),
  });
  if (claimed === undefined) return undefined;
  const handle = { workspaceId: claimed.workspaceId, exportId: claimed.id };
  let writtenLocator: DiagnosticExportArtifactLocator | undefined;
  let events: readonly RedactedDiagnosticExportEvent[];
  try {
    events = await source.snapshot({
      workspaceId: claimed.workspaceId,
      cutoffAt: claimed.eventCutoffAt,
      maximumEvents: claimed.maximumEvents,
    });
  } catch {
    await store.markFailed({
      workspaceId: claimed.workspaceId,
      exportId: claimed.id,
      failureCode: "source.unavailable",
    });
    return toDiagnosticExportStatus({
      ...claimed,
      status: "failed",
      failureCode: "source.unavailable",
    });
  }
  try {
    const serialized = serializeDiagnosticExport({
      cutoffAt: claimed.eventCutoffAt,
      generatedAt: clock.now(),
      events,
    });
    const locator = await artifacts.write({
      handle,
      content: serialized.content,
      contentType: serialized.contentType,
      signal: input.signal,
    });
    writtenLocator = locator;
    const artifact: DiagnosticExportArtifactMetadata = {
      contentSha256: await digest.sha256(serialized.content),
      byteLength: serialized.byteLength,
      contentType: serialized.contentType,
      eventCount: serialized.eventCount,
      generatedAt: clock.now(),
    };
    await store.markReady({
      workspaceId: claimed.workspaceId,
      exportId: claimed.id,
      locator,
      artifact,
    });
    writtenLocator = undefined;
    return toDiagnosticExportStatus({
      ...claimed,
      status: "ready",
      artifact,
    });
  } catch (error) {
    if (writtenLocator !== undefined) {
      // A storage write can succeed while the fenced metadata transition loses
      // its claim. Remove the now-unreachable private object best-effort; its
      // locator is never returned or logged.
      try {
        await artifacts.delete({ handle, locator: writtenLocator });
      } catch {
        // A later expiration/retention sweep is still safe to retry. Do not
        // replace the original terminal generation failure with storage detail.
      }
    }
    const failureCode =
      error instanceof RangeError ? "content.tooLarge" : "storage.unavailable";
    await store.markFailed({
      workspaceId: claimed.workspaceId,
      exportId: claimed.id,
      failureCode,
    });
    // Expiration may have won the race with the failed transition. Return the
    // authoritative durable state rather than inventing a stale failed DTO.
    const terminal = await store.find({
      workspaceId: claimed.workspaceId,
      exportId: claimed.id,
    });
    return terminal === undefined
      ? undefined
      : toDiagnosticExportStatus(terminal);
  }
}

/** Marks due requests terminal, then performs leased private-object cleanup. */
export async function expireDiagnosticExports(
  store: DiagnosticExportRequestStore,
  artifacts: DiagnosticExportArtifactStore,
  clock: DiagnosticExportClock,
  limit = 25,
): Promise<Readonly<{ readonly expired: number; readonly deleted: number }>> {
  const now = clock.now();
  const expired = await store.expireDue({ now, limit });
  const claims = await store.claimDeletion({ now, limit });
  let deleted = 0;
  for (const claim of claims) {
    const locator = claim.request.artifactLocator;
    if (locator !== undefined) {
      await artifacts.delete({
        handle: {
          workspaceId: claim.request.workspaceId,
          exportId: claim.request.id,
        },
        locator,
      });
    }
    await store.markDeleted({
      workspaceId: claim.request.workspaceId,
      exportId: claim.request.id,
      claimToken: claim.claimToken,
    });
    deleted += 1;
  }
  return Object.freeze({ expired, deleted });
}

export interface SerializedDiagnosticExport {
  readonly content: Uint8Array;
  readonly byteLength: number;
  readonly eventCount: number;
  readonly contentType: "application/json";
}

export function diagnosticExportLimits(): Readonly<{
  readonly maximumEvents: number;
  readonly maximumBytes: number;
}> {
  return Object.freeze({
    maximumEvents: maximumDiagnosticExportEvents,
    maximumBytes: maximumDiagnosticExportBytes,
  });
}

/** Creates a deterministic JSON artifact with no storage locator or URL. */
export function serializeDiagnosticExport(
  input: Readonly<{
    readonly cutoffAt: string;
    readonly generatedAt: string;
    readonly events: readonly RedactedDiagnosticExportEvent[];
  }>,
): SerializedDiagnosticExport {
  requireTimestamp(input.cutoffAt, "cutoff");
  requireTimestamp(input.generatedAt, "generated");
  if (input.events.length > maximumDiagnosticExportEvents) {
    throw new RangeError("Diagnostic export event limit exceeded.");
  }
  const events = input.events.map(redactEvent).sort(compareDiagnosticEvents);
  const json = stableJson({
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    cutoffAt: input.cutoffAt,
    events,
  });
  const content = new TextEncoder().encode(json);
  if (content.byteLength > maximumDiagnosticExportBytes) {
    throw new RangeError("Diagnostic export byte limit exceeded.");
  }
  return Object.freeze({
    content,
    byteLength: content.byteLength,
    eventCount: events.length,
    contentType: "application/json",
  });
}

export function toDiagnosticExportStatus(
  request: DiagnosticExportRequest,
): DiagnosticExportStatusDto {
  return Object.freeze({
    id: request.id,
    status: request.status,
    eventCutoffAt: request.eventCutoffAt,
    expiresAt: request.expiresAt,
    ...(request.status === "ready" && request.artifact !== undefined
      ? { generatedAt: request.artifact.generatedAt }
      : {}),
    ...(request.status === "failed" && request.failureCode !== undefined
      ? { failureCode: request.failureCode }
      : {}),
  });
}

export function transitionDiagnosticExport(
  request: DiagnosticExportRequest,
  next: DiagnosticExportStatus,
  input: Readonly<{
    readonly artifact?: DiagnosticExportArtifactMetadata;
    readonly failureCode?: NonNullable<DiagnosticExportRequest["failureCode"]>;
  }> = {},
): DiagnosticExportRequest {
  const allowed: Readonly<
    Record<DiagnosticExportStatus, readonly DiagnosticExportStatus[]>
  > = {
    requested: ["generating", "failed", "expired"],
    generating: ["ready", "failed", "expired"],
    ready: ["expired"],
    failed: ["expired"],
    expired: ["deleted"],
    deleted: [],
  };
  if (!allowed[request.status].includes(next)) {
    throw new Error("Diagnostic export state transition is invalid.");
  }
  if (next === "ready" && input.artifact === undefined) {
    throw new Error("Ready diagnostic export requires artifact metadata.");
  }
  if (next !== "ready" && input.artifact !== undefined) {
    throw new Error(
      "Only a ready diagnostic export may retain artifact metadata.",
    );
  }
  if (next === "failed" && input.failureCode === undefined) {
    throw new Error("Failed diagnostic export requires a failure code.");
  }
  if (next !== "failed" && input.failureCode !== undefined) {
    throw new Error(
      "Only a failed diagnostic export may retain a failure code.",
    );
  }
  return Object.freeze({
    ...omitTerminalMetadata(request),
    status: next,
    ...(input.artifact === undefined ? {} : { artifact: input.artifact }),
    ...(input.failureCode === undefined
      ? {}
      : { failureCode: input.failureCode }),
  });
}

/** Prevent stale persistence fields from crossing a state transition. */
function omitTerminalMetadata(
  request: DiagnosticExportRequest,
): Omit<DiagnosticExportRequest, "artifact" | "failureCode"> {
  const { artifact: _artifact, failureCode: _failureCode, ...base } = request;
  return base;
}

const sensitiveNames = new Set([
  "apikey",
  "authorization",
  "body",
  "connectionstring",
  "content",
  "cookie",
  "credential",
  "databaseurl",
  "header",
  "message",
  "password",
  "payload",
  "privatekey",
  "prompt",
  "query",
  "raw",
  "request",
  "response",
  "secret",
  "text",
  "token",
  "url",
]);

function redactEvent(
  event: RedactedDiagnosticExportEvent,
): RedactedDiagnosticExportEvent {
  if (!/^[a-z][a-z0-9_.-]{0,119}$/u.test(event.name)) {
    throw new RangeError("Diagnostic event name is invalid.");
  }
  requireTimestamp(event.occurredAt, "event");
  return Object.freeze({
    name: event.name,
    occurredAt: event.occurredAt,
    severity: event.severity,
    attributes: redactAttributes(event.attributes, 0),
  });
}

function redactAttributes(
  attributes: Readonly<Record<string, DiagnosticExportValue>>,
  depth: number,
): Readonly<Record<string, DiagnosticExportValue>> {
  if (depth > maximumDiagnosticAttributeDepth) {
    return Object.freeze({ value: redactedValue });
  }
  return Object.freeze(
    Object.fromEntries(
      Object.keys(attributes)
        .sort()
        .map((key) => [
          key,
          isSensitiveName(key)
            ? redactedValue
            : redactValue(attributes[key] ?? null, depth + 1),
        ]),
    ),
  );
}

function redactValue(
  value: DiagnosticExportValue,
  depth: number,
): DiagnosticExportValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number")
    return Number.isFinite(value) ? value : redactedValue;
  if (depth > maximumDiagnosticAttributeDepth) return redactedValue;
  if (isDiagnosticArray(value)) {
    return Object.freeze(value.map((item) => redactValue(item, depth + 1)));
  }
  return redactAttributes(value, depth + 1);
}

function isDiagnosticArray(
  value: DiagnosticExportValue,
): value is readonly DiagnosticExportValue[] {
  return Array.isArray(value);
}

function isSensitiveName(name: string): boolean {
  const normalized = name.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
  return (
    sensitiveNames.has(normalized) ||
    [...sensitiveNames].some(
      (sensitive) =>
        normalized.startsWith(sensitive) || normalized.endsWith(sensitive),
    )
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function compareDiagnosticEvents(
  left: RedactedDiagnosticExportEvent,
  right: RedactedDiagnosticExportEvent,
): number {
  return (
    left.occurredAt.localeCompare(right.occurredAt) ||
    left.name.localeCompare(right.name) ||
    left.severity.localeCompare(right.severity) ||
    stableJson(left.attributes).localeCompare(stableJson(right.attributes))
  );
}

function requireTimestamp(value: string, label: string): void {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new RangeError(`Diagnostic export ${label} timestamp is invalid.`);
  }
}

function requireIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)) {
    throw new RangeError(`Diagnostic export ${label} is invalid.`);
  }
  return value;
}

function requireDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/iu.test(value)) {
    throw new RangeError("Diagnostic export digest is invalid.");
  }
  return value.toLowerCase();
}
import type { EnvelopeFor } from "@caseweaver/domain";
import type { AuditRecord } from "@caseweaver/security";
