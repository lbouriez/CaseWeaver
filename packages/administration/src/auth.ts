import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const returnPathPattern = /^\/(?!\/)[^\r\n]*$/u;

export interface OidcLoginMaterial {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly challenge: string;
}

/** Generates PKCE material that is retained only by the server-side login transaction. */
export function createOidcLoginMaterial(): OidcLoginMaterial {
  const verifier = randomUrlSafeValue(48);
  return Object.freeze({
    state: randomUrlSafeValue(32),
    nonce: randomUrlSafeValue(32),
    verifier,
    challenge: sha256Base64Url(verifier),
  });
}

export function randomUrlSafeValue(bytes: number): string {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) {
    throw new RangeError("Random value size must be between 16 and 128 bytes.");
  }
  return randomBytes(bytes).toString("base64url");
}

/** Only a same-origin relative path may survive an identity-provider round trip. */
export function normalizeReturnPath(value: string | undefined): string {
  if (value === undefined || value.length === 0) return "/";
  if (value.length > 2_000 || !returnPathPattern.test(value)) {
    throw new Error("Return path is invalid.");
  }
  return value;
}

/**
 * Pins the post-login target to one configured console origin. Relative paths
 * remain supported for direct API callers, but the stored value is always an
 * absolute trusted UI URL so a separately hosted SPA does not land on the API
 * origin after the OIDC callback. This is an allow-list check, never a
 * reflection of a browser-supplied origin.
 */
export function normalizeTrustedReturnTarget(
  value: string | undefined,
  allowedOrigins: readonly string[],
): string {
  const origin = allowedOrigins[0];
  if (origin === undefined) {
    throw new Error("A trusted administration origin is required.");
  }
  const allowed = new Set(
    allowedOrigins.map((candidate) => new URL(candidate).origin),
  );
  const candidate =
    value === undefined || value.length === 0
      ? new URL("/", origin)
      : returnPathPattern.test(value)
        ? new URL(value, origin)
        : new URL(value);
  if (
    candidate.username.length > 0 ||
    candidate.password.length > 0 ||
    !allowed.has(candidate.origin) ||
    candidate.toString().length > 2_000
  ) {
    throw new Error("Return target is invalid.");
  }
  return candidate.toString();
}

/** Persist hashes, never state/nonce/verifier/session/CSRF values. */
export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function matchesDigest(value: string, digest: string): boolean {
  const calculated = Buffer.from(sha256Base64Url(value), "utf8");
  const expected = Buffer.from(digest, "utf8");
  return (
    calculated.length === expected.length &&
    timingSafeEqual(calculated, expected)
  );
}

export interface OidcValidatedIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly displayName: string;
  readonly expiresAt: string;
}

/**
 * The provider adapter owns discovery, token exchange, JWKS signature and claim
 * validation. It must not return token material to callers.
 */
export interface OidcAuthorizationCodeClient {
  authorizationUrl(
    input: Readonly<{
      readonly state: string;
      readonly nonce: string;
      readonly codeChallenge: string;
    }>,
  ): Promise<URL>;
  exchangeAndValidate(
    input: Readonly<{
      readonly code: string;
      readonly verifier: string;
      readonly nonce: string;
    }>,
  ): Promise<OidcValidatedIdentity>;
}

export interface LoginTransaction {
  readonly id: string;
  readonly stateDigest: string;
  /**
   * State can be verified from a digest, but OIDC requires the original nonce
   * and verifier during the callback. They are short-lived, purpose-bound,
   * authenticated-encryption payloads; they are never returned to a browser.
   */
  readonly nonce: SealedEphemeralValue;
  readonly verifier: SealedEphemeralValue;
  readonly returnPath: string;
  readonly expiresAt: string;
}

export interface SealedEphemeralValue {
  readonly keyId: string;
  readonly ciphertext: string;
}

/**
 * Deployment-owned authenticated encryption for short-lived callback secrets.
 * Implementations must bind ciphertext to `purpose`, support key rotation, and
 * reject malformed or modified payloads without revealing the plaintext.
 */
export interface EphemeralSecretProtector {
  seal(
    plaintext: string,
    purpose: "oidc-nonce" | "oidc-pkce-verifier" | "session-csrf",
  ): Promise<SealedEphemeralValue>;
  open(
    value: SealedEphemeralValue,
    purpose: "oidc-nonce" | "oidc-pkce-verifier" | "session-csrf",
  ): Promise<string>;
}

export interface ServerSession {
  readonly id: string;
  readonly sessionDigest: string;
  readonly csrfDigest: string;
  /** Sealed synchronizer token; decrypted only for the authenticated session DTO. */
  readonly csrf: SealedEphemeralValue;
  readonly principalId: string;
  readonly workspaceId: string;
  readonly expiresAt: string;
}

export interface OidcIdentityMapping {
  readonly id: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly displayName: string;
}

/** Resolves only server-managed identity mappings; callers never supply roles. */
export interface OidcIdentityMappingStore {
  findByExternalIdentity(
    input: Readonly<{
      readonly issuer: string;
      readonly subject: string;
    }>,
  ): Promise<readonly OidcIdentityMapping[]>;
  findByWorkspacePrincipal(
    input: Readonly<{
      readonly workspaceId: string;
      readonly principalId: string;
    }>,
  ): Promise<OidcIdentityMapping | undefined>;
}

export interface AuthSessionStore {
  createLoginTransaction(transaction: LoginTransaction): Promise<void>;
  consumeLoginTransaction(
    stateDigest: string,
    now: string,
  ): Promise<LoginTransaction | undefined>;
  createSession(session: ServerSession): Promise<void>;
  findActiveSession(
    sessionDigest: string,
    now: string,
  ): Promise<ServerSession | undefined>;
  revokeSession(sessionDigest: string, now: string): Promise<void>;
  /** Revokes the presented session and creates a fresh one atomically. */
  rotateSession(
    input: Readonly<{
      readonly previousSessionDigest: string;
      readonly replacement: ServerSession;
      readonly now: string;
    }>,
  ): Promise<boolean>;
}

/**
 * Trusted request metadata that may accompany an authentication mutation audit.
 * The session service supplies the actor, workspace, action, outcome, and
 * target from server-validated state; callers cannot override those fields.
 */
export interface AuthAuditRequestMetadata {
  readonly occurredAt: string;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly uiActionId?: string;
  readonly idempotencyKeyDigest?: string;
  readonly clientAddress?: string;
  readonly userAgent?: string;
}

/** Server-owned auth action codes. Browser callers never supply these values. */
export const authAuditActions = [
  "auth.login.initiated",
  "auth.login.succeeded",
  "auth.login.failed",
  "auth.session.read",
  "auth.session.denied",
  "auth.logout.succeeded",
  "auth.logout.denied",
  "auth.workspace.switch.succeeded",
  "auth.workspace.switch.denied",
] as const;

export type AuthAuditAction = (typeof authAuditActions)[number];

export const authAuditReasonCodes = [
  "callback.invalid",
  "identity.unmapped",
  "session.required",
  "csrf.invalid",
  "origin.invalid",
  "workspace.denied",
  "audit.unavailable",
] as const;

export type AuthAuditReasonCode = (typeof authAuditReasonCodes)[number];

export interface AuthAuditEvent {
  /** Omit only for unauthenticated outcomes recorded by installation audit storage. */
  readonly workspaceId?: string;
  readonly actorPrincipalId?: string;
  readonly action: AuthAuditAction;
  readonly outcome: "attempted" | "succeeded" | "failed" | "denied";
  readonly targetType: "oidc-login" | "auth-session" | "workspace";
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
 * Every auth action is security-sensitive. A route/composition adapter must
 * persist this plan durably; login/session mutations require the same database
 * transaction as the corresponding session state change.
 */
export interface AuthAuditPlan {
  readonly event: AuthAuditEvent;
  readonly failClosed: true;
}

export interface AuthAuditRecorder {
  record(plan: AuthAuditPlan): Promise<void>;
}

/**
 * Commits a successful server-session mutation and its authoritative audit
 * event as one durability boundary. This port deliberately has no method for
 * arbitrary audit writes, login transactions, tokens, cookies, or CSRF text.
 */
export interface AuthSessionAuditMutationStore {
  createSessionAndRecord(
    input: Readonly<{
      readonly session: ServerSession;
      readonly audit: AuthAuditPlan;
    }>,
  ): Promise<void>;
  revokeSessionAndRecord(
    input: Readonly<{
      readonly sessionDigest: string;
      readonly now: string;
      readonly audit: AuthAuditPlan;
    }>,
  ): Promise<boolean>;
  rotateSessionAndRecord(
    input: Readonly<{
      readonly previousSessionDigest: string;
      readonly replacement: ServerSession;
      readonly now: string;
      readonly audit: AuthAuditPlan;
    }>,
  ): Promise<boolean>;
}
