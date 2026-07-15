import { describe, expect, it, vi } from "vitest";

import { StandardsOidcClient } from "./oidc-client.js";

const discovery = {
  issuer: "https://issuer.example",
  authorization_endpoint: "https://issuer.example/authorize",
  token_endpoint: "https://issuer.example/token",
  jwks_uri: "https://issuer.example/keys",
};

describe("StandardsOidcClient", () => {
  it("uses provider discovery and sends S256 authorization-code parameters", async () => {
    const fetchImplementation = vi.fn(
      async () => new Response(JSON.stringify(discovery), { status: 200 }),
    ) as unknown as typeof fetch;
    const client = new StandardsOidcClient({
      issuer: "https://issuer.example",
      clientId: "caseweaver-admin",
      redirectUri: "https://caseweaver.example/v1/auth/callback",
      scopes: ["openid", "profile"],
      fetchImplementation,
    });
    const url = await client.authorizationUrl({
      state: "state-value",
      nonce: "nonce-value",
      codeChallenge: "challenge-value",
    });

    expect(url.origin).toBe("https://issuer.example");
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("nonce")).toBe("nonce-value");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value");
  });

  it("rejects non-HTTPS OIDC bootstrap endpoints", () => {
    expect(
      () =>
        new StandardsOidcClient({
          issuer: "http://issuer.example",
          clientId: "caseweaver-admin",
          redirectUri: "https://caseweaver.example/v1/auth/callback",
          scopes: ["openid"],
        }),
    ).toThrow("HTTPS");
  });
});
