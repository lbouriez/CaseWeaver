import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Session } from "./api/contracts.js";
import { OperatorSessionGate, SessionAwareLoginPage } from "./app.js";

const authenticatedSession = {
  authenticated: true as const,
  principal: { id: "principal-1", displayName: "A. Operator" },
  activeWorkspace: { id: "workspace-1", name: "Operations" },
  workspaces: [{ id: "workspace-1", name: "Operations" }],
  permissions: ["configuration.read"],
  csrfToken: "in-memory-csrf-token",
  expiresAt: "2030-01-01T00:00:00.000Z",
};

describe("operator session gate", () => {
  it("leaves React-Admin's login route when the API cookie session is already authenticated", async () => {
    const onAuthenticated = vi.fn();
    const authenticateWithPassword = vi.fn(async () => authenticatedSession);
    render(
      <SessionAwareLoginPage
        authenticateWithPassword={authenticateWithPassword}
        client={{ session: vi.fn(async () => authenticatedSession) }}
        onAuthenticated={onAuthenticated}
        onOauthLogin={vi.fn()}
      />,
    );

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
    expect(authenticateWithPassword).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("renders only password authentication when OAuth is not configured and clears the browser-side credential state after sign-in", async () => {
    const passwordLogin = vi.fn(async () => authenticatedSession);
    render(
      <OperatorSessionGate
        authProvider={{
          login: vi.fn(async () => undefined),
          logout: vi.fn(async () => undefined),
          passwordLogin,
        }}
        client={{
          session: vi.fn(async () => ({
            authenticated: false as const,
            authentication: { password: true, oauth: false },
          })),
        }}
        renderAuthenticated={() => <p>Authenticated console</p>}
      />,
    );

    await userEvent.type(await screen.findByLabelText(/^Login/u), "admin");
    await userEvent.type(screen.getByLabelText(/^Password/u), "admin");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await screen.findByText("Authenticated console");
    expect(passwordLogin).toHaveBeenCalledWith("admin", "admin");
    expect(
      screen.queryByRole("button", {
        name: "Continue with configured identity provider",
      }),
    ).toBeNull();
  });

  it("renders the sign-in control before React-Admin for an anonymous session", async () => {
    const login = vi.fn(async () => undefined);
    render(
      <OperatorSessionGate
        authProvider={{
          login,
          logout: vi.fn(async () => undefined),
          passwordLogin: vi.fn(async () => authenticatedSession),
        }}
        client={{
          session: vi.fn(async () => ({
            authenticated: false as const,
            authentication: { password: true, oauth: true },
          })),
        }}
        renderAuthenticated={() => <p>Authenticated console</p>}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Continue with configured identity provider",
      }),
    );
    expect(login).toHaveBeenCalledWith({});
    expect(screen.queryByText("Authenticated console")).toBeNull();
  });

  it("mounts authenticated content and returns to sign-in after successful server logout", async () => {
    const logout = vi.fn(async () => undefined);
    render(
      <OperatorSessionGate
        authProvider={{
          login: vi.fn(async () => undefined),
          logout,
          passwordLogin: vi.fn(async () => authenticatedSession),
        }}
        client={{
          session: vi
            .fn()
            .mockResolvedValueOnce(authenticatedSession)
            .mockResolvedValueOnce({
              authenticated: false as const,
              authentication: { password: true, oauth: true },
            }),
        }}
        renderAuthenticated={(signOut) => (
          <button onClick={() => void signOut()} type="button">
            Test sign out
          </button>
        )}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Test sign out" }),
    );
    await screen.findByRole("button", {
      name: "Continue with configured identity provider",
    });
    expect(logout).toHaveBeenCalledWith({});
  });

  it("shows a generic retry state when session lookup is unavailable", async () => {
    const session = vi
      .fn<(signal?: AbortSignal) => Promise<Session>>()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({
        authenticated: false as const,
        authentication: { password: true, oauth: true },
      });
    render(
      <OperatorSessionGate
        authProvider={{
          login: vi.fn(async () => undefined),
          logout: vi.fn(async () => undefined),
          passwordLogin: vi.fn(async () => authenticatedSession),
        }}
        client={{ session }}
        renderAuthenticated={() => <p>Authenticated console</p>}
      />,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Retry session check" }),
    );
    await waitFor(() => expect(session).toHaveBeenCalledTimes(2));
    await screen.findByRole("button", {
      name: "Continue with configured identity provider",
    });
    expect(screen.queryByText("network unavailable")).toBeNull();
  });
});
