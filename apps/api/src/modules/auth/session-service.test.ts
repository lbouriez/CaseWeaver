import type {
  AuthAuditPlan,
  AuthSessionAuditMutationStore,
  AuthSessionStore,
  EphemeralSecretProtector,
  LoginTransaction,
  OidcAuthorizationCodeClient,
  OidcIdentityMapping,
  OidcIdentityMappingStore,
  SealedEphemeralValue,
  ServerSession,
} from "@caseweaver/administration";
import type { Permission } from "@caseweaver/security";
import { describe, expect, it, vi } from "vitest";

import {
  AuthSessionService,
  AuthSessionServiceError,
  type AuthSessionServiceDependencies,
} from "./session-service.js";

class MemorySessionStore implements AuthSessionStore {
  public readonly transactions = new Map<string, LoginTransaction>();
  public readonly sessions = new Map<string, ServerSession>();

  public async createLoginTransaction(
    transaction: LoginTransaction,
  ): Promise<void> {
    this.transactions.set(transaction.stateDigest, transaction);
  }

  public async consumeLoginTransaction(
    stateDigest: string,
    _now: string,
  ): Promise<LoginTransaction | undefined> {
    const transaction = this.transactions.get(stateDigest);
    this.transactions.delete(stateDigest);
    return transaction;
  }

  public async createSession(session: ServerSession): Promise<void> {
    this.sessions.set(session.sessionDigest, session);
  }

  public async findActiveSession(
    sessionDigest: string,
    now: string,
  ): Promise<ServerSession | undefined> {
    const session = this.sessions.get(sessionDigest);
    return session !== undefined && new Date(session.expiresAt) > new Date(now)
      ? session
      : undefined;
  }

  public async revokeSession(
    sessionDigest: string,
    _now: string,
  ): Promise<void> {
    this.sessions.delete(sessionDigest);
  }

  public async rotateSession(
    input: Readonly<{
      readonly previousSessionDigest: string;
      readonly replacement: ServerSession;
      readonly now: string;
    }>,
  ): Promise<boolean> {
    if (
      !(await this.findActiveSession(input.previousSessionDigest, input.now))
    ) {
      return false;
    }
    this.sessions.delete(input.previousSessionDigest);
    this.sessions.set(input.replacement.sessionDigest, input.replacement);
    return true;
  }
}

class MemorySessionAuditMutationStore implements AuthSessionAuditMutationStore {
  public readonly audits: AuthAuditPlan[] = [];

  public constructor(private readonly sessions: MemorySessionStore) {}

  public async createSessionAndRecord(input: {
    readonly session: ServerSession;
    readonly audit: AuthAuditPlan;
  }): Promise<void> {
    await this.sessions.createSession(input.session);
    this.audits.push(input.audit);
  }

  public async revokeSessionAndRecord(input: {
    readonly sessionDigest: string;
    readonly now: string;
    readonly audit: AuthAuditPlan;
  }): Promise<boolean> {
    if (
      (await this.sessions.findActiveSession(
        input.sessionDigest,
        input.now,
      )) === undefined
    ) {
      return false;
    }
    await this.sessions.revokeSession(input.sessionDigest, input.now);
    this.audits.push(input.audit);
    return true;
  }

  public async rotateSessionAndRecord(input: {
    readonly previousSessionDigest: string;
    readonly replacement: ServerSession;
    readonly now: string;
    readonly audit: AuthAuditPlan;
  }): Promise<boolean> {
    const rotated = await this.sessions.rotateSession(input);
    if (rotated) this.audits.push(input.audit);
    return rotated;
  }
}

class TestProtector implements EphemeralSecretProtector {
  public async seal(
    plaintext: string,
    purpose: "oidc-nonce" | "oidc-pkce-verifier" | "session-csrf",
  ): Promise<SealedEphemeralValue> {
    return { keyId: "test-key", ciphertext: `${purpose}.${plaintext}` };
  }

  public async open(
    value: SealedEphemeralValue,
    purpose: "oidc-nonce" | "oidc-pkce-verifier" | "session-csrf",
  ): Promise<string> {
    const prefix = `${purpose}.`;
    if (value.keyId !== "test-key" || !value.ciphertext.startsWith(prefix)) {
      throw new Error("sealed value is invalid");
    }
    return value.ciphertext.slice(prefix.length);
  }
}

const mappings: readonly OidcIdentityMapping[] = [
  {
    id: "mapping-a",
    workspaceId: "workspace-a",
    principalId: "principal-a",
    issuer: "https://issuer.example",
    subject: "subject-a",
    displayName: "Operator A",
  },
  {
    id: "mapping-b",
    workspaceId: "workspace-b",
    principalId: "principal-b",
    issuer: "https://issuer.example",
    subject: "subject-a",
    displayName: "Operator A",
  },
];

function mappingStore(): OidcIdentityMappingStore {
  return {
    findByExternalIdentity: async ({ issuer, subject }) =>
      issuer === "https://issuer.example" && subject === "subject-a"
        ? mappings
        : [],
    findByWorkspacePrincipal: async ({ workspaceId, principalId }) =>
      mappings.find(
        (mapping) =>
          mapping.workspaceId === workspaceId &&
          mapping.principalId === principalId,
      ),
  };
}

function createService() {
  const sessions = new MemorySessionStore();
  const sessionAuditMutations = new MemorySessionAuditMutationStore(sessions);
  const oidc: OidcAuthorizationCodeClient = {
    authorizationUrl: vi.fn(async (input) => {
      const url = new URL("https://issuer.example/authorize");
      url.searchParams.set("state", input.state);
      return url;
    }),
    exchangeAndValidate: vi.fn(async ({ nonce, verifier }) => {
      expect(nonce.length).toBeGreaterThan(20);
      expect(verifier.length).toBeGreaterThan(20);
      return {
        issuer: "https://issuer.example",
        subject: "subject-a",
        displayName: "Operator A",
        expiresAt: "2026-01-02T00:00:00.000Z",
      };
    }),
  };
  const dependencies: AuthSessionServiceDependencies = {
    oidc,
    sessions,
    sessionAuditMutations,
    mappings: mappingStore(),
    protector: new TestProtector(),
    ids: {
      next: (scope) =>
        `${scope}-${sessions.sessions.size + sessions.transactions.size + 1}`,
    },
    workspaceName: async (id) =>
      id === "workspace-a"
        ? "Operations"
        : id === "workspace-b"
          ? "Staging"
          : undefined,
    permissionsFor: async () => ["configuration.read" as Permission],
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    secureCookies: true,
    allowedOrigins: ["https://admin.example"],
  };
  return {
    service: new AuthSessionService(dependencies),
    sessions,
    sessionAuditMutations,
    oidc,
  };
}

const audit = Object.freeze({
  occurredAt: "2026-01-01T00:00:00.000Z",
  requestId: "request-a",
  correlationId: "correlation-a",
});

describe("server-managed OIDC session service", () => {
  it("retains PKCE/nonce only as sealed server material and returns a token-free session", async () => {
    const { service, sessions, sessionAuditMutations } = createService();
    const login = await service.login("/operations?tab=jobs");
    const state = new URL(login.redirectTo).searchParams.get("state");
    expect(state).toBeTruthy();
    expect([...sessions.transactions.values()][0]).toMatchObject({
      nonce: { keyId: "test-key" },
      verifier: { keyId: "test-key" },
    });
    expect([...sessions.transactions.values()][0]?.nonce.ciphertext).not.toBe(
      state,
    );

    const callback = await service.callback({
      code: "authorization-code",
      state,
      audit,
    });
    expect(callback.redirectTo).toBe(
      "https://admin.example/operations?tab=jobs",
    );
    expect(callback.setCookie).toContain("HttpOnly");
    expect(callback.session).toMatchObject({
      authenticated: true,
      activeWorkspace: { id: "workspace-a", name: "Operations" },
      workspaces: [{ id: "workspace-a" }, { id: "workspace-b" }],
      permissions: ["configuration.read"],
    });
    expect(callback.session).not.toHaveProperty("accessToken");
    expect(sessionAuditMutations.audits).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          action: "auth.login.succeeded",
          workspaceId: "workspace-a",
          actorPrincipalId: "principal-a",
          targetId: expect.stringMatching(/^session-/u),
        }),
      }),
    ]);
    expect(JSON.stringify(sessionAuditMutations.audits)).not.toContain(
      callback.session.csrfToken,
    );
    await expect(service.session(callback.setCookie)).resolves.toMatchObject({
      authenticated: true,
      csrfToken: callback.session.csrfToken,
    });
  });

  it("rejects callback replay and malformed state without invoking token exchange", async () => {
    const { service, oidc } = createService();
    const login = await service.login("/");
    const state = new URL(login.redirectTo).searchParams.get("state");
    await service.callback({ code: "authorization-code", state, audit });
    await expect(
      service.callback({ code: "authorization-code", state, audit }),
    ).rejects.toMatchObject({ code: "auth.callback.invalid" });
    await expect(
      service.callback({ code: "authorization-code", state: "invalid", audit }),
    ).rejects.toMatchObject({ code: "auth.callback.invalid" });
    expect(oidc.exchangeAndValidate).toHaveBeenCalledTimes(1);
  });

  it("requires trusted origin and CSRF then rotates the opaque session on workspace switch", async () => {
    const { service } = createService();
    const login = await service.login("/");
    const state = new URL(login.redirectTo).searchParams.get("state");
    const callback = await service.callback({
      code: "authorization-code",
      state,
      audit,
    });
    await expect(
      service.switchWorkspace({
        cookieHeader: callback.setCookie,
        origin: "https://attacker.example",
        csrfToken: callback.session.csrfToken,
        workspaceId: "workspace-b",
        audit,
      }),
    ).rejects.toMatchObject({ code: "auth.origin.invalid" });
    await expect(
      service.switchWorkspace({
        cookieHeader: callback.setCookie,
        origin: "https://admin.example",
        csrfToken: "incorrect",
        workspaceId: "workspace-b",
        audit,
      }),
    ).rejects.toMatchObject({ code: "auth.csrf.invalid" });
    const switched = await service.switchWorkspace({
      cookieHeader: callback.setCookie,
      origin: "https://admin.example",
      csrfToken: callback.session.csrfToken,
      workspaceId: "workspace-b",
      audit,
    });
    expect(switched.session.activeWorkspace).toEqual({
      id: "workspace-b",
      name: "Staging",
    });
    await expect(service.session(callback.setCookie)).resolves.toEqual({
      authenticated: false,
    });
  });

  it("requires CSRF for logout and clears the cookie after revoking the server session", async () => {
    const { service } = createService();
    const login = await service.login("/");
    const state = new URL(login.redirectTo).searchParams.get("state");
    const callback = await service.callback({
      code: "authorization-code",
      state,
      audit,
    });
    await expect(
      service.logout({
        cookieHeader: callback.setCookie,
        origin: "https://admin.example",
        audit,
      }),
    ).rejects.toBeInstanceOf(AuthSessionServiceError);
    await expect(
      service.logout({
        cookieHeader: callback.setCookie,
        origin: "https://admin.example",
        csrfToken: callback.session.csrfToken,
        audit,
      }),
    ).resolves.toMatchObject({
      setCookie: expect.stringContaining("Max-Age=0"),
    });
    await expect(service.session(callback.setCookie)).resolves.toEqual({
      authenticated: false,
    });
  });

  it("does not create a browser session when atomic success audit persistence fails", async () => {
    const { service, sessions, sessionAuditMutations } = createService();
    const login = await service.login("/");
    const state = new URL(login.redirectTo).searchParams.get("state");
    vi.spyOn(sessionAuditMutations, "createSessionAndRecord").mockRejectedValue(
      new Error("audit.persistence.failed"),
    );

    await expect(
      service.callback({ code: "authorization-code", state, audit }),
    ).rejects.toThrow("audit.persistence.failed");
    expect(sessions.sessions.size).toBe(0);
  });
});
