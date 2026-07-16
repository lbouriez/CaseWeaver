import {
  createOidcLoginMaterial,
  matchesDigest,
  normalizeTrustedReturnTarget,
  randomUrlSafeValue,
  sha256Base64Url,
  type AuthAuditRequestMetadata,
  type AuthSessionAuditMutationStore,
  type AuthSessionStore,
  type EphemeralSecretProtector,
  type OidcAuthorizationCodeClient,
  type OidcIdentityMapping,
  type OidcIdentityMappingStore,
  type OidcValidatedIdentity,
  type ServerSession,
} from "@caseweaver/administration";
import type { Permission } from "@caseweaver/security";

import {
  clearedSessionCookie,
  csrfMatches,
  parseSessionCookie,
  requiresTrustedOrigin,
  sessionCookie,
} from "./session-security.js";
import { createAuthAuditPlan } from "./audit-compliance.js";

export interface AuthenticatedSessionDto {
  readonly authenticated: true;
  readonly principal: { readonly id: string; readonly displayName: string };
  readonly activeWorkspace: SessionWorkspace;
  readonly workspaces: readonly SessionWorkspace[];
  readonly permissions: readonly Permission[];
  readonly csrfToken: string;
  readonly expiresAt: string;
}

export interface SessionWorkspace {
  readonly id: string;
  readonly name: string;
}

export type SessionDto =
  | AuthenticatedSessionDto
  | Readonly<{
      readonly authenticated: false;
      readonly authentication: Readonly<{
        readonly password: boolean;
        readonly oauth: boolean;
      }>;
    }>;

export interface AuthenticatedRequestContext {
  readonly principalId: string;
  readonly workspaceId: string;
  readonly permissions: readonly Permission[];
  readonly session: ServerSession;
}

export interface SessionServiceIdGenerator {
  next(scope: "login-transaction" | "session"): string;
}

export interface AuthSessionServiceDependencies {
  readonly oidc?: OidcAuthorizationCodeClient;
  readonly sessions: AuthSessionStore;
  readonly sessionAuditMutations: AuthSessionAuditMutationStore;
  readonly mappings: OidcIdentityMappingStore;
  readonly protector: EphemeralSecretProtector;
  readonly ids: SessionServiceIdGenerator;
  readonly workspaceName: (workspaceId: string) => Promise<string | undefined>;
  readonly permissionsFor: (
    input: Readonly<{
      readonly workspaceId: string;
      readonly principalId: string;
    }>,
  ) => Promise<readonly Permission[]>;
  readonly now?: () => Date;
  readonly loginLifetimeMs?: number;
  readonly sessionLifetimeMs?: number;
  readonly secureCookies: boolean;
  readonly allowedOrigins: readonly string[];
  /** Deployment-scoped local operator credential. It is never persisted or returned. */
  readonly passwordAuthentication?: Readonly<{
    readonly login: string;
    readonly password: string;
    readonly workspaceId: string;
    readonly principalId: string;
    readonly displayName: string;
  }>;
}

export class AuthSessionServiceError extends Error {
  public constructor(
    public readonly code:
      | "auth.callback.invalid"
      | "auth.login.invalid"
      | "auth.login.disabled"
      | "auth.identity.unmapped"
      | "auth.session.required"
      | "auth.csrf.invalid"
      | "auth.origin.invalid"
      | "auth.workspace.denied",
  ) {
    super(code);
    this.name = "AuthSessionServiceError";
  }
}

interface ActiveSession {
  readonly sessionDigest: string;
  readonly session: ServerSession;
  readonly csrfToken: string;
}

interface SessionIdentity {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly displayName: string;
}

const defaultLoginLifetimeMs = 10 * 60 * 1_000;
const defaultSessionLifetimeMs = 8 * 60 * 60 * 1_000;

/**
 * Transport-neutral state machine for server-managed OIDC sessions. It exposes
 * no provider tokens and leaves HTTP response/audit composition to its caller.
 */
export class AuthSessionService {
  private readonly now: () => Date;
  private readonly loginLifetimeMs: number;
  private readonly sessionLifetimeMs: number;

  public constructor(
    private readonly dependencies: AuthSessionServiceDependencies,
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.loginLifetimeMs = validLifetime(
      dependencies.loginLifetimeMs ?? defaultLoginLifetimeMs,
    );
    this.sessionLifetimeMs = validLifetime(
      dependencies.sessionLifetimeMs ?? defaultSessionLifetimeMs,
    );
  }

  public async login(returnTo: string | undefined): Promise<{
    readonly redirectTo: string;
  }> {
    const oidc = this.dependencies.oidc;
    if (oidc === undefined) {
      throw new AuthSessionServiceError("auth.login.disabled");
    }
    const material = createOidcLoginMaterial();
    const now = this.now();
    const [nonce, verifier] = await Promise.all([
      this.dependencies.protector.seal(material.nonce, "oidc-nonce"),
      this.dependencies.protector.seal(material.verifier, "oidc-pkce-verifier"),
    ]);
    await this.dependencies.sessions.createLoginTransaction({
      id: this.dependencies.ids.next("login-transaction"),
      stateDigest: sha256Base64Url(material.state),
      nonce,
      verifier,
      returnPath: normalizeTrustedReturnTarget(
        returnTo,
        this.dependencies.allowedOrigins,
      ),
      expiresAt: at(now, this.loginLifetimeMs),
    });
    const authorizationUrl = await oidc.authorizationUrl({
      state: material.state,
      nonce: material.nonce,
      codeChallenge: material.challenge,
    });
    return Object.freeze({ redirectTo: authorizationUrl.toString() });
  }

  public async callback(
    input: Readonly<{
      readonly code: string | undefined;
      readonly state: string | undefined;
      readonly audit: AuthAuditRequestMetadata;
    }>,
  ): Promise<{
    readonly redirectTo: string;
    readonly setCookie: string;
    readonly session: AuthenticatedSessionDto;
  }> {
    const oidc = this.dependencies.oidc;
    if (oidc === undefined) {
      throw new AuthSessionServiceError("auth.login.disabled");
    }
    if (!isBoundedCallbackValue(input.code, 4_000) || !isState(input.state)) {
      throw new AuthSessionServiceError("auth.callback.invalid");
    }
    const now = this.now();
    const transaction =
      await this.dependencies.sessions.consumeLoginTransaction(
        sha256Base64Url(input.state),
        now.toISOString(),
      );
    if (transaction === undefined) {
      throw new AuthSessionServiceError("auth.callback.invalid");
    }
    let nonce: string;
    let verifier: string;
    try {
      [nonce, verifier] = await Promise.all([
        this.dependencies.protector.open(transaction.nonce, "oidc-nonce"),
        this.dependencies.protector.open(
          transaction.verifier,
          "oidc-pkce-verifier",
        ),
      ]);
    } catch {
      throw new AuthSessionServiceError("auth.callback.invalid");
    }
    let identity: OidcValidatedIdentity;
    try {
      identity = await oidc.exchangeAndValidate({
        code: input.code,
        verifier,
        nonce,
      });
    } catch {
      throw new AuthSessionServiceError("auth.callback.invalid");
    }
    const mappings = orderedMappings(
      await this.dependencies.mappings.findByExternalIdentity({
        issuer: identity.issuer,
        subject: identity.subject,
      }),
    );
    const mapping = mappings[0];
    if (mapping === undefined) {
      throw new AuthSessionServiceError("auth.identity.unmapped");
    }
    const created = await this.createSession(
      mapping,
      identity.expiresAt,
      now,
      input.audit,
    );
    return Object.freeze({
      redirectTo: transaction.returnPath,
      setCookie: created.setCookie,
      session: created.session,
    });
  }

  public async session(cookieHeader: string | undefined): Promise<SessionDto> {
    const active = await this.activeSession(cookieHeader);
    if (active === undefined) {
      return Object.freeze({
        authenticated: false,
        authentication: Object.freeze({
          password: this.dependencies.passwordAuthentication !== undefined,
          oauth: this.dependencies.oidc !== undefined,
        }),
      });
    }
    return this.toSessionDto(active.session, active.csrfToken);
  }

  public async passwordLogin(
    input: Readonly<{
      readonly login: string;
      readonly password: string;
      readonly origin?: string;
      readonly audit: AuthAuditRequestMetadata;
    }>,
  ): Promise<{
    readonly setCookie: string;
    readonly session: AuthenticatedSessionDto;
  }> {
    const configured = this.dependencies.passwordAuthentication;
    if (configured === undefined) {
      throw new AuthSessionServiceError("auth.login.disabled");
    }
    if (requiresTrustedOrigin(input.origin, this.dependencies.allowedOrigins)) {
      throw new AuthSessionServiceError("auth.origin.invalid");
    }
    if (
      !isBoundedCallbackValue(input.login, 160) ||
      !isBoundedCallbackValue(input.password, 1_024)
    ) {
      throw new AuthSessionServiceError("auth.login.invalid");
    }
    const loginMatches = matchesDigest(
      input.login,
      sha256Base64Url(configured.login),
    );
    const passwordMatches = matchesDigest(
      input.password,
      sha256Base64Url(configured.password),
    );
    if (!loginMatches || !passwordMatches) {
      throw new AuthSessionServiceError("auth.login.invalid");
    }
    return this.createSession(configured, undefined, this.now(), input.audit);
  }

  public async resolve(
    input: Readonly<{
      readonly cookieHeader: string | undefined;
      readonly mutation: boolean;
      readonly origin?: string;
      readonly csrfToken?: string;
    }>,
  ): Promise<AuthenticatedRequestContext> {
    const active = await this.activeSession(input.cookieHeader);
    if (active === undefined) {
      throw new AuthSessionServiceError("auth.session.required");
    }
    if (input.mutation) {
      if (
        requiresTrustedOrigin(input.origin, this.dependencies.allowedOrigins)
      ) {
        throw new AuthSessionServiceError("auth.origin.invalid");
      }
      if (!csrfMatches(input.csrfToken, active.csrfToken)) {
        throw new AuthSessionServiceError("auth.csrf.invalid");
      }
    }
    const permissions = await this.dependencies.permissionsFor({
      workspaceId: active.session.workspaceId,
      principalId: active.session.principalId,
    });
    return Object.freeze({
      principalId: active.session.principalId,
      workspaceId: active.session.workspaceId,
      permissions: Object.freeze([...permissions]),
      session: active.session,
    });
  }

  public async logout(
    input: Readonly<{
      readonly cookieHeader: string | undefined;
      readonly origin?: string;
      readonly csrfToken?: string;
      readonly audit: AuthAuditRequestMetadata;
    }>,
  ): Promise<{ readonly setCookie: string }> {
    const active = await this.requireMutation(input);
    const revoked =
      await this.dependencies.sessionAuditMutations.revokeSessionAndRecord({
        sessionDigest: active.sessionDigest,
        now: this.now().toISOString(),
        audit: this.successAudit(input.audit, {
          workspaceId: active.session.workspaceId,
          actorPrincipalId: active.session.principalId,
          action: "auth.logout.succeeded",
          targetType: "auth-session",
          targetId: active.session.id,
        }),
      });
    if (!revoked) throw new AuthSessionServiceError("auth.session.required");
    return Object.freeze({
      setCookie: clearedSessionCookie(this.dependencies.secureCookies),
    });
  }

  public async switchWorkspace(
    input: Readonly<{
      readonly cookieHeader: string | undefined;
      readonly origin?: string;
      readonly csrfToken?: string;
      readonly workspaceId: string;
      readonly audit: AuthAuditRequestMetadata;
    }>,
  ): Promise<{
    readonly setCookie: string;
    readonly session: AuthenticatedSessionDto;
  }> {
    const active = await this.requireMutation(input);
    const currentMapping =
      await this.dependencies.mappings.findByWorkspacePrincipal({
        workspaceId: active.session.workspaceId,
        principalId: active.session.principalId,
      });
    if (currentMapping === undefined) {
      throw new AuthSessionServiceError("auth.workspace.denied");
    }
    const mappings = await this.dependencies.mappings.findByExternalIdentity({
      issuer: currentMapping.issuer,
      subject: currentMapping.subject,
    });
    const selected = mappings.find(
      (mapping) => mapping.workspaceId === input.workspaceId,
    );
    if (selected === undefined) {
      throw new AuthSessionServiceError("auth.workspace.denied");
    }
    const rotationNow = this.now();
    const created = await this.newSession(selected, rotationNow);
    const rotated =
      await this.dependencies.sessionAuditMutations.rotateSessionAndRecord({
        previousSessionDigest: active.sessionDigest,
        replacement: created.serverSession,
        now: rotationNow.toISOString(),
        audit: this.successAudit(input.audit, {
          workspaceId: selected.workspaceId,
          actorPrincipalId: active.session.principalId,
          action: "auth.workspace.switch.succeeded",
          targetType: "workspace",
          targetId: selected.workspaceId,
        }),
      });
    if (!rotated) throw new AuthSessionServiceError("auth.session.required");
    return Object.freeze({
      setCookie: created.setCookie,
      session: created.session,
    });
  }

  private async requireMutation(
    input: Readonly<{
      readonly cookieHeader: string | undefined;
      readonly origin?: string;
      readonly csrfToken?: string;
    }>,
  ): Promise<ActiveSession> {
    const active = await this.activeSession(input.cookieHeader);
    if (active === undefined) {
      throw new AuthSessionServiceError("auth.session.required");
    }
    if (requiresTrustedOrigin(input.origin, this.dependencies.allowedOrigins)) {
      throw new AuthSessionServiceError("auth.origin.invalid");
    }
    if (!csrfMatches(input.csrfToken, active.csrfToken)) {
      throw new AuthSessionServiceError("auth.csrf.invalid");
    }
    return active;
  }

  private async activeSession(
    cookieHeader: string | undefined,
  ): Promise<ActiveSession | undefined> {
    const sessionValue = parseSessionCookie(
      cookieHeader,
      this.dependencies.secureCookies,
    );
    if (sessionValue === undefined) return undefined;
    const session = await this.dependencies.sessions.findActiveSession(
      sha256Base64Url(sessionValue),
      this.now().toISOString(),
    );
    if (session === undefined) return undefined;
    try {
      const csrfToken = await this.dependencies.protector.open(
        session.csrf,
        "session-csrf",
      );
      if (!matchesDigest(csrfToken, session.csrfDigest)) return undefined;
      return Object.freeze({
        sessionDigest: sha256Base64Url(sessionValue),
        session,
        csrfToken,
      });
    } catch {
      return undefined;
    }
  }

  private async createSession(
    identity: SessionIdentity,
    identityExpiresAt: string | undefined,
    now: Date,
    audit: AuthAuditRequestMetadata,
  ) {
    const created = await this.newSession(identity, now, identityExpiresAt);
    await this.dependencies.sessionAuditMutations.createSessionAndRecord({
      session: created.serverSession,
      audit: this.successAudit(audit, {
        workspaceId: identity.workspaceId,
        actorPrincipalId: identity.principalId,
        action: "auth.login.succeeded",
        targetType: "auth-session",
        targetId: created.serverSession.id,
      }),
    });
    return created;
  }

  private successAudit(
    metadata: AuthAuditRequestMetadata,
    input: Readonly<{
      readonly workspaceId: string;
      readonly actorPrincipalId: string;
      readonly action:
        | "auth.login.succeeded"
        | "auth.logout.succeeded"
        | "auth.workspace.switch.succeeded";
      readonly targetType: "auth-session" | "workspace";
      readonly targetId: string;
    }>,
  ) {
    return createAuthAuditPlan({
      ...metadata,
      ...input,
      outcome: "succeeded",
    });
  }

  private async newSession(
    identity: SessionIdentity,
    now: Date,
    identityExpiresAt?: string,
  ): Promise<{
    readonly serverSession: ServerSession;
    readonly setCookie: string;
    readonly session: AuthenticatedSessionDto;
  }> {
    const rawSession = randomUrlSafeValue(32);
    const csrfToken = randomUrlSafeValue(32);
    const expiresAt = sessionExpiry(
      now,
      this.sessionLifetimeMs,
      identityExpiresAt,
    );
    const csrf = await this.dependencies.protector.seal(
      csrfToken,
      "session-csrf",
    );
    const serverSession: ServerSession = Object.freeze({
      id: this.dependencies.ids.next("session"),
      sessionDigest: sha256Base64Url(rawSession),
      csrfDigest: sha256Base64Url(csrfToken),
      csrf,
      principalId: identity.principalId,
      workspaceId: identity.workspaceId,
      expiresAt,
    });
    return Object.freeze({
      serverSession,
      setCookie: sessionCookie(
        rawSession,
        new Date(expiresAt),
        this.dependencies.secureCookies,
      ),
      session: await this.toSessionDto(serverSession, csrfToken),
    });
  }

  private async toSessionDto(
    session: ServerSession,
    csrfToken: string,
  ): Promise<AuthenticatedSessionDto> {
    const localIdentity = this.localIdentityFor(session);
    if (localIdentity !== undefined) {
      return this.sessionDtoForIdentity(session, csrfToken, localIdentity, [
        localIdentity.workspaceId,
      ]);
    }
    const currentMapping =
      await this.dependencies.mappings.findByWorkspacePrincipal({
        workspaceId: session.workspaceId,
        principalId: session.principalId,
      });
    if (currentMapping === undefined) {
      throw new AuthSessionServiceError("auth.session.required");
    }
    const mappings = orderedMappings(
      await this.dependencies.mappings.findByExternalIdentity({
        issuer: currentMapping.issuer,
        subject: currentMapping.subject,
      }),
    );
    return this.sessionDtoForIdentity(
      session,
      csrfToken,
      currentMapping,
      mappings.map((mapping) => mapping.workspaceId),
    );
  }

  private localIdentityFor(
    session: ServerSession,
  ): SessionIdentity | undefined {
    const configured = this.dependencies.passwordAuthentication;
    if (
      configured === undefined ||
      configured.workspaceId !== session.workspaceId ||
      configured.principalId !== session.principalId
    ) {
      return undefined;
    }
    return configured;
  }

  private async sessionDtoForIdentity(
    session: ServerSession,
    csrfToken: string,
    identity: SessionIdentity,
    workspaceIds: readonly string[],
  ): Promise<AuthenticatedSessionDto> {
    const memberships = await Promise.all(
      workspaceIds.map(async (workspaceId) =>
        this.workspaceMembership(workspaceId),
      ),
    );
    const activeWorkspace = memberships.find(
      (membership) => membership.id === session.workspaceId,
    );
    if (activeWorkspace === undefined) {
      throw new AuthSessionServiceError("auth.session.required");
    }
    const permissions = await this.dependencies.permissionsFor({
      workspaceId: session.workspaceId,
      principalId: session.principalId,
    });
    return Object.freeze({
      authenticated: true,
      principal: Object.freeze({
        id: session.principalId,
        displayName: identity.displayName,
      }),
      activeWorkspace,
      workspaces: Object.freeze(memberships),
      permissions: Object.freeze([...permissions]),
      csrfToken,
      expiresAt: session.expiresAt,
    });
  }

  private async workspaceMembership(
    workspaceId: string,
  ): Promise<SessionWorkspace> {
    const name = await this.dependencies.workspaceName(workspaceId);
    if (name === undefined)
      throw new AuthSessionServiceError("auth.session.required");
    return Object.freeze({ id: workspaceId, name });
  }
}

function validLifetime(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < 60_000 ||
    value > 24 * 60 * 60 * 1_000
  ) {
    throw new RangeError("Authentication lifetime is invalid.");
  }
  return value;
}

function at(now: Date, lifetimeMs: number): string {
  return new Date(now.getTime() + lifetimeMs).toISOString();
}

function sessionExpiry(
  now: Date,
  lifetimeMs: number,
  identityExpiresAt?: string,
): string {
  const configured = now.getTime() + lifetimeMs;
  if (identityExpiresAt === undefined)
    return new Date(configured).toISOString();
  const identityExpiry = new Date(identityExpiresAt).getTime();
  if (!Number.isFinite(identityExpiry) || identityExpiry <= now.getTime()) {
    throw new AuthSessionServiceError("auth.callback.invalid");
  }
  return new Date(Math.min(configured, identityExpiry)).toISOString();
}

function orderedMappings(
  mappings: readonly OidcIdentityMapping[],
): readonly OidcIdentityMapping[] {
  return Object.freeze(
    [...mappings].sort(
      (left, right) =>
        left.workspaceId.localeCompare(right.workspaceId) ||
        left.principalId.localeCompare(right.principalId),
    ),
  );
}

function isState(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9_-]{22,512}$/u.test(value);
}

function isBoundedCallbackValue(
  value: string | undefined,
  maximumLength: number,
): value is string {
  return (
    value !== undefined && value.length > 0 && value.length <= maximumLength
  );
}
