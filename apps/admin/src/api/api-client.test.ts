import { describe, expect, it, vi } from "vitest";

import { CaseWeaverApiClient } from "./api-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CaseWeaverApiClient", () => {
  it("uses cookie credentials, action correlation, and a fixed session endpoint", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        authenticated: true,
        principal: { id: "principal-1", displayName: "A. Operator" },
        activeWorkspace: { id: "workspace-1", name: "Operations" },
        workspaces: [{ id: "workspace-1", name: "Operations" }],
        permissions: ["configuration.read"],
        csrfToken: "a-valid-csrf-token",
        expiresAt: "2026-07-14T20:00:00.000Z",
      }),
    );
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
      { fetchImplementation, createActionId: () => "action-1" },
    );

    await client.session();

    expect(fetchImplementation).toHaveBeenCalledWith(
      new URL("https://api.example.test/v1/auth/session"),
      expect.objectContaining({
        credentials: "include",
        headers: expect.any(Headers),
      }),
    );
    const init = fetchImplementation.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("X-CaseWeaver-UI-Action-ID")).toBe(
      "action-1",
    );
    expect(new Headers(init?.headers).get("X-CaseWeaver-Request-Mode")).toBe(
      "user",
    );
  });

  it("sends the session CSRF token and idempotency header for workspace changes", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          principal: { id: "principal-1", displayName: "A. Operator" },
          activeWorkspace: { id: "workspace-1", name: "Operations" },
          workspaces: [{ id: "workspace-1", name: "Operations" }],
          permissions: ["configuration.read"],
          csrfToken: "a-valid-csrf-token",
          expiresAt: "2026-07-14T20:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          principal: { id: "principal-1", displayName: "A. Operator" },
          activeWorkspace: { id: "workspace-2", name: "Staging" },
          workspaces: [{ id: "workspace-2", name: "Staging" }],
          permissions: ["configuration.read"],
          csrfToken: "another-valid-csrf-token",
          expiresAt: "2026-07-14T20:00:00.000Z",
        }),
      );
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
      { fetchImplementation, createActionId: () => "action-2" },
    );

    await client.session();
    await client.switchWorkspace("workspace-2");

    const init = fetchImplementation.mock.calls[1]?.[1];
    expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe(
      "a-valid-csrf-token",
    );
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("action-2");
  });

  it("only exposes resource-specific request methods and marks polling explicitly", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      jsonResponse({ items: [], page: { hasNextPage: false } }),
    );
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test/control", uiTitle: "Control" },
      { fetchImplementation },
    );

    await client.list("dead-letters", {}, { mode: "passive_poll" });

    expect(Object.hasOwn(client, "requestJson")).toBe(false);
    expect(Object.hasOwn(client, "request")).toBe(false);
    expect(fetchImplementation.mock.calls[0]?.[0]).toEqual(
      new URL(
        "https://api.example.test/control/v1/admin/operations/dead-letters",
      ),
    );
    const init = fetchImplementation.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("X-CaseWeaver-Request-Mode")).toBe(
      "passive_poll",
    );
  });

  it("maps missing planned endpoints to a visible unavailable failure", async () => {
    const client = new CaseWeaverApiClient(
      { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
      {
        fetchImplementation: async () =>
          jsonResponse({ code: "route.missing" }, 404),
      },
    );

    await expect(client.list("connector-instances")).rejects.toMatchObject({
      kind: "unavailable",
      code: "route.missing",
    });
  });
});
