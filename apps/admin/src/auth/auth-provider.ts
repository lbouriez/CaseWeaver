import type { AuthProvider } from "react-admin";

import { type CaseWeaverApiClient, PublicApiError } from "../api/api-client.js";
import type { AuthenticatedSession, Session } from "../api/contracts.js";

export interface SessionAuthProvider extends AuthProvider {
  readonly currentSession: () => Promise<AuthenticatedSession>;
  readonly switchWorkspace: (
    workspaceId: string,
  ) => Promise<AuthenticatedSession>;
  readonly passwordLogin: (
    login: string,
    password: string,
  ) => Promise<AuthenticatedSession>;
}

export interface SessionAuthProviderOptions {
  readonly currentLocation?: () => string;
  readonly currentOrigin?: () => string;
  readonly navigateToLogin?: (url: URL) => void;
}

export function sameOriginReturnTo(
  candidate: string,
  uiOrigin = window.location.origin,
): string {
  try {
    const url = new URL(candidate, uiOrigin);
    if (url.origin !== uiOrigin) return "/";
    // React-Admin reserves this route for the unauthenticated view. Returning
    // an OAuth callback here creates a valid server session, then immediately
    // renders that view again. Keep a deployment subpath for hash routing, but
    // never use the login route itself as an authentication return target.
    if (/^#\/login(?:[/?]|$)/u.test(url.hash))
      return `${url.pathname}${url.search}`;
    if (url.pathname === "/login") return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

function requireAuthenticated(session: Session): AuthenticatedSession {
  if (session.authenticated) return session;
  throw new PublicApiError(
    "unauthenticated",
    "session.required",
    "Your operator session has expired. Sign in to continue.",
  );
}

export function createSessionAuthProvider(
  client: CaseWeaverApiClient,
  options: SessionAuthProviderOptions = {},
): SessionAuthProvider {
  let session: AuthenticatedSession | undefined;
  const currentLocation =
    options.currentLocation ??
    (() =>
      `${window.location.pathname}${window.location.search}${window.location.hash}`);
  const currentOrigin = options.currentOrigin ?? (() => window.location.origin);
  const navigateToLogin =
    options.navigateToLogin ?? ((url) => window.location.assign(url));

  const loadSession = async (): Promise<AuthenticatedSession> => {
    const loaded = requireAuthenticated(await client.session());
    session = loaded;
    return loaded;
  };

  return {
    async login() {
      const returnTo = new URL(
        sameOriginReturnTo(currentLocation(), currentOrigin()),
        currentOrigin(),
      ).toString();
      navigateToLogin(client.loginUrl(returnTo));
    },
    async passwordLogin(login, password) {
      const authenticated = requireAuthenticated(
        await client.passwordLogin({ login, password }),
      );
      session = authenticated;
      return authenticated;
    },
    async logout() {
      try {
        await client.logout();
      } catch (error) {
        // React-Admin invokes logout after a rejected anonymous checkAuth. The
        // API correctly rejects that CSRF-protected mutation, but there is no
        // browser session left to revoke. Clear local state so the login page
        // can render; all other transport or server failures still surface.
        if (
          !(error instanceof PublicApiError) ||
          error.kind !== "unauthenticated"
        ) {
          throw error;
        }
      }
      session = undefined;
    },
    async checkAuth() {
      await loadSession();
    },
    async checkError(error) {
      if (error instanceof PublicApiError && error.kind === "unauthenticated") {
        session = undefined;
        throw error;
      }
    },
    async getIdentity() {
      const loaded = session ?? (await loadSession());
      return {
        id: loaded.principal.id,
        fullName: loaded.principal.displayName,
      };
    },
    async getPermissions() {
      const loaded = session ?? (await loadSession());
      return loaded.permissions;
    },
    currentSession: async () => session ?? loadSession(),
    async switchWorkspace(workspaceId) {
      const updated = requireAuthenticated(
        await client.switchWorkspace(workspaceId),
      );
      session = updated;
      return updated;
    },
  };
}
