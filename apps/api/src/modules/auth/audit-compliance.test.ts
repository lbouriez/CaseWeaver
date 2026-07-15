import { describe, expect, it } from "vitest";

import {
  createAuthAuditPlan,
  isTrustedBrowserOrigin,
  resolveAuditClientAddress,
} from "./audit-compliance.js";

describe("auth audit and compliance helpers", () => {
  it("creates fail-closed, server-coded audit plans without arbitrary payloads", () => {
    const plan = createAuthAuditPlan({
      workspaceId: "workspace-1",
      actorPrincipalId: "principal-1",
      action: "auth.workspace.switch.succeeded",
      outcome: "succeeded",
      targetType: "workspace",
      targetId: "workspace-2",
      occurredAt: "2026-07-15T12:00:00.000Z",
      requestId: "request-1",
      clientAddress: "192.0.2.8",
      userAgent: "CaseWeaver Admin",
    });
    expect(plan).toMatchObject({
      failClosed: true,
      event: {
        action: "auth.workspace.switch.succeeded",
        workspaceId: "workspace-1",
        clientAddress: "192.0.2.8",
      },
    });
    expect(plan.event).not.toHaveProperty("token");
    expect(() =>
      createAuthAuditPlan({
        action: "auth.login.succeeded",
        outcome: "succeeded",
        targetType: "auth-session",
        occurredAt: "not-a-timestamp",
      }),
    ).toThrow("timestamp");
  });

  it("allows only exact configured browser origins", () => {
    expect(
      isTrustedBrowserOrigin("https://admin.example", [
        "https://admin.example",
      ]),
    ).toBe(true);
    expect(
      isTrustedBrowserOrigin("https://admin.example/path", [
        "https://admin.example",
      ]),
    ).toBe(false);
    expect(
      isTrustedBrowserOrigin("https://attacker.example", [
        "https://admin.example",
      ]),
    ).toBe(false);
  });

  it("uses forwarded client addresses only after trusted-proxy resolution", () => {
    expect(
      resolveAuditClientAddress({
        directAddress: "10.0.0.4",
        forwardedClientAddress: "198.51.100.4",
        proxyTrusted: false,
      }),
    ).toBe("10.0.0.4");
    expect(
      resolveAuditClientAddress({
        directAddress: "10.0.0.4",
        forwardedClientAddress: "198.51.100.4",
        proxyTrusted: true,
      }),
    ).toBe("198.51.100.4");
  });

  it("requires server-derived scope for authenticated events and drops unsafe metadata", () => {
    expect(() =>
      createAuthAuditPlan({
        action: "auth.logout.succeeded",
        outcome: "succeeded",
        targetType: "auth-session",
        occurredAt: "2026-07-15T12:00:00.000Z",
      }),
    ).toThrow("scope");
    const plan = createAuthAuditPlan({
      action: "auth.login.failed",
      outcome: "failed",
      targetType: "oidc-login",
      reasonCode: "callback.invalid",
      occurredAt: "2026-07-15T12:00:00.000Z",
      userAgent: "secret\nvalue",
      clientAddress: "not-an-address",
    });
    expect(plan.event).not.toHaveProperty("userAgent");
    expect(plan.event).not.toHaveProperty("clientAddress");
  });

  it("allows unauthenticated denial records without fabricating an actor", () => {
    expect(
      createAuthAuditPlan({
        workspaceId: "workspace-1",
        action: "auth.session.denied",
        outcome: "denied",
        targetType: "auth-session",
        reasonCode: "session.required",
        occurredAt: "2026-07-15T12:00:00.000Z",
      }).event,
    ).not.toHaveProperty("actorPrincipalId");
  });
});
