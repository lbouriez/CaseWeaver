import { describe, expect, it } from "vitest";

import { createOidcAdministrationApiFixture } from "../../test-support/administration-oidc-fixture.js";

const adminOrigin = "https://admin.example.test";

function sessionCookie(setCookie: string): string {
  const value = setCookie.split(";", 1)[0];
  if (value === undefined || value.length === 0) {
    throw new Error("session cookie missing");
  }
  return value;
}

describe("OIDC administration API integration", () => {
  it("accepts deployment-configured password credentials without exposing them and creates the normal server session", async () => {
    const built = createOidcAdministrationApiFixture({
      allowedAdminOrigins: [adminOrigin],
      passwordAuthentication: { login: "admin", password: "admin" },
    });
    const signedIn = await built.app.inject({
      method: "POST",
      url: "/v1/auth/login/password",
      headers: {
        origin: adminOrigin,
        "idempotency-key": "password-login-request-0001",
      },
      payload: { login: "admin", password: "admin" },
    });

    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json()).toMatchObject({
      authenticated: true,
      principal: {
        id: "local-password-administrator",
        displayName: "Local administrator",
      },
    });
    expect(signedIn.headers["set-cookie"]).toContain("HttpOnly");
    expect(signedIn.body).not.toContain('"password"');

    const rejected = await built.app.inject({
      method: "POST",
      url: "/v1/auth/login/password",
      headers: {
        origin: adminOrigin,
        "idempotency-key": "password-login-request-0002",
      },
      payload: { login: "admin", password: "incorrect" },
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.body).not.toContain("incorrect");
    expect(JSON.stringify(built.auditPlans)).not.toContain(
      '"password":"admin"',
    );
    expect(built.auditPlans).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          action: "auth.login.failed",
          targetType: "password-login",
          reasonCode: "credentials.invalid",
        }),
      }),
    );
    await built.app.close();
  });

  it("runs the token-free login, callback, session, workspace rotation, and logout journey with server-owned audit", async () => {
    const built = createOidcAdministrationApiFixture({
      allowedAdminOrigins: [adminOrigin],
    });
    const login = await built.app.inject({
      method: "GET",
      url: "/v1/auth/login?returnTo=%2Foperations",
    });
    expect(login.statusCode).toBe(302);
    const authorization = new URL(login.headers.location ?? "");
    const state = authorization.searchParams.get("state");
    expect(authorization.origin).toBe("https://issuer.example.test");
    expect(state).toBeTruthy();

    const callback = await built.app.inject({
      method: "GET",
      url: `/v1/auth/callback?code=authorization-code-for-test&state=${encodeURIComponent(state ?? "")}`,
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(`${adminOrigin}/operations`);
    const firstCookie = sessionCookie(String(callback.headers["set-cookie"]));
    expect(firstCookie).toMatch(/^caseweaver-session=/u);
    expect(String(callback.headers["set-cookie"])).toContain("HttpOnly");
    expect(callback.body).not.toContain("authorization-code-for-test");

    const session = await built.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { cookie: firstCookie },
    });
    expect(session.statusCode).toBe(200);
    const sessionBody = session.json();
    expect(sessionBody).toMatchObject({
      authenticated: true,
      activeWorkspace: { id: "workspace-a", name: "Operations" },
      principal: { id: "principal-a", displayName: "Operator" },
    });
    expect(session.body).not.toContain("access_token");
    expect(session.body).not.toContain("authorization-code-for-test");

    const switched = await built.app.inject({
      method: "POST",
      url: "/v1/auth/session/workspace",
      headers: {
        cookie: firstCookie,
        origin: adminOrigin,
        "x-csrf-token": sessionBody.csrfToken,
        "idempotency-key": "switch-workspace-request-0001",
      },
      payload: { workspaceId: "workspace-b" },
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({
      authenticated: true,
      activeWorkspace: { id: "workspace-b", name: "Research" },
    });
    const secondCookie = sessionCookie(String(switched.headers["set-cookie"]));
    expect(secondCookie).not.toBe(firstCookie);

    const staleSession = await built.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { cookie: firstCookie },
    });
    expect(staleSession.json()).toEqual({
      authenticated: false,
      authentication: { password: false, oauth: true },
    });

    const switchedBody = switched.json();
    const logout = await built.app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: {
        cookie: secondCookie,
        origin: adminOrigin,
        "x-csrf-token": switchedBody.csrfToken,
        "idempotency-key": "logout-session-request-0001",
      },
    });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");

    const loggedOutSession = await built.app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { cookie: secondCookie },
    });
    expect(loggedOutSession.json()).toEqual({
      authenticated: false,
      authentication: { password: false, oauth: true },
    });

    expect(built.auditPlans.map((plan) => plan.event.action)).toEqual(
      expect.arrayContaining([
        "auth.login.initiated",
        "auth.login.succeeded",
        "auth.session.read",
        "auth.workspace.switch.succeeded",
        "auth.logout.succeeded",
      ]),
    );
    const audit = JSON.stringify(built.auditPlans);
    expect(audit).not.toContain("authorization-code-for-test");
    expect(audit).not.toContain(state ?? "missing-state");
    expect(audit).not.toContain(sessionBody.csrfToken);
    await built.app.close();
  });

  it("fails a browser mutation with an invalid CSRF token and audits the denied workspace switch", async () => {
    const built = createOidcAdministrationApiFixture({
      allowedAdminOrigins: [adminOrigin],
    });
    const login = await built.app.inject({
      method: "GET",
      url: "/v1/auth/login",
    });
    const state = new URL(login.headers.location ?? "").searchParams.get(
      "state",
    );
    const callback = await built.app.inject({
      method: "GET",
      url: `/v1/auth/callback?code=authorization-code-for-test&state=${encodeURIComponent(state ?? "")}`,
    });
    const cookie = sessionCookie(String(callback.headers["set-cookie"]));
    const denied = await built.app.inject({
      method: "POST",
      url: "/v1/auth/session/workspace",
      headers: {
        cookie,
        origin: adminOrigin,
        "x-csrf-token": "incorrect-csrf-token",
        "idempotency-key": "csrf-denied-request-0001",
      },
      payload: { workspaceId: "workspace-b" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain("incorrect-csrf-token");
    expect(built.auditPlans).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          action: "auth.workspace.switch.denied",
          outcome: "denied",
          reasonCode: "csrf.invalid",
        }),
      }),
    );
    await built.app.close();
  });
});
