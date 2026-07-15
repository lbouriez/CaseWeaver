import { isIP } from "node:net";

import {
  authAuditActions,
  authAuditReasonCodes,
  type AuthAuditAction,
  type AuthAuditEvent,
  type AuthAuditPlan,
  type AuthAuditReasonCode,
} from "@caseweaver/administration";

const opaqueIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export interface AuthAuditPlanInput {
  readonly workspaceId?: string;
  readonly actorPrincipalId?: string;
  readonly action: AuthAuditAction;
  readonly outcome: AuthAuditEvent["outcome"];
  readonly targetType: AuthAuditEvent["targetType"];
  readonly targetId?: string;
  readonly reasonCode?: AuthAuditReasonCode;
  readonly occurredAt: string;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly uiActionId?: string;
  readonly idempotencyKeyDigest?: string;
  readonly clientAddress?: string;
  readonly userAgent?: string;
}

/**
 * Produces a route-invokable, secret-free audit plan. It intentionally accepts
 * only fixed server action/reason codes and opaque correlation identifiers.
 */
export function createAuthAuditPlan(input: AuthAuditPlanInput): AuthAuditPlan {
  if (!(authAuditActions as readonly string[]).includes(input.action)) {
    throw new RangeError("Auth audit action is invalid.");
  }
  if (
    input.reasonCode !== undefined &&
    !(authAuditReasonCodes as readonly string[]).includes(input.reasonCode)
  ) {
    throw new RangeError("Auth audit reason is invalid.");
  }
  if (!isTimestamp(input.occurredAt)) {
    throw new RangeError("Auth audit timestamp is invalid.");
  }
  const workspaceId = safeIdentifier(input.workspaceId, "workspace");
  const actorPrincipalId = safeIdentifier(input.actorPrincipalId, "principal");
  if (
    requiresAuthenticatedScope(input.action) &&
    (workspaceId === undefined || actorPrincipalId === undefined)
  ) {
    throw new RangeError("Authenticated auth audit scope is required.");
  }
  const targetId = safeIdentifier(input.targetId, "target");
  const requestId = safeIdentifier(input.requestId, "request");
  const correlationId = safeIdentifier(input.correlationId, "correlation");
  const uiActionId = safeIdentifier(input.uiActionId, "ui action");
  const idempotencyKeyDigest = safeDigest(input.idempotencyKeyDigest);
  const clientAddress = safeIpAddress(input.clientAddress);
  const userAgent = safeUserAgent(input.userAgent);
  return Object.freeze({
    failClosed: true,
    event: Object.freeze({
      action: input.action,
      outcome: input.outcome,
      targetType: input.targetType,
      occurredAt: input.occurredAt,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(actorPrincipalId === undefined ? {} : { actorPrincipalId }),
      ...(targetId === undefined ? {} : { targetId }),
      ...(input.reasonCode === undefined
        ? {}
        : { reasonCode: input.reasonCode }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(correlationId === undefined ? {} : { correlationId }),
      ...(uiActionId === undefined ? {} : { uiActionId }),
      ...(idempotencyKeyDigest === undefined ? {} : { idempotencyKeyDigest }),
      ...(clientAddress === undefined ? {} : { clientAddress }),
      ...(userAgent === undefined ? {} : { userAgent }),
    }),
  });
}

/** Exact-origin allow-list comparison; it never reflects an arbitrary origin. */
export function isTrustedBrowserOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (origin === undefined || origin.length > 2_000) return false;
  const normalized = canonicalOrigin(origin);
  return (
    normalized !== undefined &&
    allowedOrigins.some((allowed) => canonicalOrigin(allowed) === normalized)
  );
}

/**
 * `forwardedClientAddress` must be supplied only by a framework configured with
 * an explicit trusted-proxy policy. Raw X-Forwarded-For is never parsed here.
 */
export function resolveAuditClientAddress(
  input: Readonly<{
    readonly directAddress?: string;
    readonly forwardedClientAddress?: string;
    readonly proxyTrusted: boolean;
  }>,
): string | undefined {
  if (
    input.proxyTrusted &&
    safeIpAddress(input.forwardedClientAddress) !== undefined
  ) {
    return safeIpAddress(input.forwardedClientAddress);
  }
  return safeIpAddress(input.directAddress);
}

function canonicalOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.origin === value ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function safeIdentifier(
  value: string | undefined,
  _label: string,
): string | undefined {
  return value !== undefined && opaqueIdentifier.test(value)
    ? value
    : undefined;
}

function safeDigest(value: string | undefined): string | undefined {
  return value !== undefined && /^[A-Za-z0-9_-]{22,128}$/u.test(value)
    ? value
    : undefined;
}

function safeIpAddress(value: string | undefined): string | undefined {
  return value !== undefined && isIP(value) !== 0 ? value : undefined;
}

function safeUserAgent(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > 512)
    return undefined;
  return value.includes("\r") || value.includes("\n") || value.includes("\0")
    ? undefined
    : value;
}

function isTimestamp(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && value === date.toISOString();
}

function requiresAuthenticatedScope(action: AuthAuditAction): boolean {
  return (
    action === "auth.session.read" ||
    action === "auth.logout.succeeded" ||
    action === "auth.workspace.switch.succeeded"
  );
}
