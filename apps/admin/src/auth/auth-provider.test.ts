import { describe, expect, it, vi } from "vitest";

import { CaseWeaverApiClient } from "../api/api-client.js";
import {
  createSessionAuthProvider,
  sameOriginReturnTo,
} from "./auth-provider.js";

const authenticatedSession = {
  authenticated: true as const,
  principal: { id: "principal-1", displayName: "A. Operator" },
  activeWorkspace: { id: "workspace-1", name: "Operations" },
  workspaces: [{ id: "workspace-1", name: "Operations" }],
  permissions: ["configuration.read"],
  csrfToken: "a-valid-csrf-token",
  expiresAt: "2026-07-14T20:00:00.000Z",
};

describe("session auth provider", () => {
  it("allows only same-origin return paths", () => {
    expect(
      sameOriginReturnTo(
        "/operations?filter=failed",
        "https://ui.example.test",
      ),
    ).toBe("/operations?filter=failed");
    expect(
      sameOriginReturnTo(
        "https://attacker.example.test",
        "https://ui.example.test",
      ),
    ).toBe("/");
    expect(
      sameOriginReturnTo(
        "https://ui.example.test/control/#/login",
        "https://ui.example.test",
      ),
    ).toBe("/control/");
    expect(
      sameOriginReturnTo(
        "https://ui.example.test/login",
        "https://ui.example.test",
      ),
    ).toBe("/");
  });

  it("redirects browser login through the API without persisting a token", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
      { fetchImplementation },
    );
    const navigateToLogin = vi.fn();
    const provider = createSessionAuthProvider(client, {
      currentLocation: () => "https://attacker.example.test/steal",
      currentOrigin: () => "https://ui.example.test",
      navigateToLogin,
    });

    await provider.login({});

    expect(navigateToLogin).toHaveBeenCalledWith(
      new URL(
        "https://api.example.test/v1/auth/login?returnTo=https%3A%2F%2Fui.example.test%2F",
      ),
    );
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it("uses the server session permissions and rejects anonymous sessions", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(authenticatedSession), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    const provider = createSessionAuthProvider(
      new CaseWeaverApiClient(
        { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
        { fetchImplementation },
      ),
    );

    const getPermissions = provider.getPermissions;
    if (getPermissions === undefined)
      throw new Error("Permissions provider is required.");
    await expect(getPermissions({})).resolves.toEqual(["configuration.read"]);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("clears an anonymous browser session locally when React-Admin requests logout", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: "session.required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const provider = createSessionAuthProvider(
      new CaseWeaverApiClient(
        { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
        { fetchImplementation },
      ),
    );

    await expect(provider.logout({})).resolves.toBeUndefined();
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("preserves logout failures other than an unauthenticated session", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: "service.unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const provider = createSessionAuthProvider(
      new CaseWeaverApiClient(
        { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
        { fetchImplementation },
      ),
    );

    await expect(provider.logout({})).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});
