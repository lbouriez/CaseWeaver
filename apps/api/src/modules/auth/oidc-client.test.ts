import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { StandardsOidcClient } from "./oidc-client.js";

const discovery = {
  issuer: "https://issuer.example",
  authorization_endpoint: "https://issuer.example/authorize",
  token_endpoint: "https://issuer.example/token",
  jwks_uri: "https://issuer.example/keys",
};

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function identityClientWithSigningKey(
  keyMetadata: Readonly<Record<string, string | undefined>> = {
    use: "sig",
    alg: "RS256",
  },
) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const now = Math.floor(Date.now() / 1_000);
  const encodedHeader = base64UrlJson({
    alg: "RS256",
    kid: "provider-key-1",
    // Standard, interoperable header metadata must not weaken validation.
    typ: "JWT",
  });
  const encodedClaims = base64UrlJson({
    iss: discovery.issuer,
    sub: "operator-subject",
    aud: "caseweaver-admin",
    exp: now + 300,
    iat: now,
    nonce: "nonce-value",
    name: "OIDC Operator",
  });
  const signed = `${encodedHeader}.${encodedClaims}`;
  const idToken = `${signed}.${sign(
    "RSA-SHA256",
    Buffer.from(signed, "utf8"),
    privateKey,
  ).toString("base64url")}`;
  const jwk = publicKey.export({ format: "jwk" });
  const fetchSpy = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url === discovery.token_endpoint) {
      return new Response(JSON.stringify({ id_token: idToken }), {
        status: 200,
      });
    }
    if (url === discovery.jwks_uri) {
      return new Response(
        JSON.stringify({
          keys: [{ ...jwk, kid: "provider-key-1", ...keyMetadata }],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify(discovery), { status: 200 });
  });
  return {
    client: new StandardsOidcClient({
      issuer: discovery.issuer,
      clientId: "caseweaver-admin",
      redirectUri: "https://caseweaver.example/v1/auth/callback",
      scopes: ["openid", "profile"],
      fetchImplementation: fetchSpy as unknown as typeof fetch,
    }),
    fetchSpy,
  };
}

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
    expect(
      () =>
        new StandardsOidcClient({
          issuer: "https://operator:password@issuer.example",
          clientId: "caseweaver-admin",
          redirectUri: "https://caseweaver.example/v1/auth/callback",
          scopes: ["openid"],
        }),
    ).toThrow("without credentials");
  });

  it("accepts standard JWT header metadata while enforcing the signing key and algorithm", async () => {
    const { client, fetchSpy } = identityClientWithSigningKey();

    await expect(
      client.exchangeAndValidate({
        code: "authorization-code",
        verifier: "pkce-verifier",
        nonce: "nonce-value",
      }),
    ).resolves.toMatchObject({
      issuer: discovery.issuer,
      subject: "operator-subject",
      displayName: "OIDC Operator",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    for (const [, options] of fetchSpy.mock.calls) {
      expect(options).toMatchObject({ redirect: "error" });
    }
  });

  it("accepts a signing key when use and alg are omitted", async () => {
    const { client } = identityClientWithSigningKey({});
    await expect(
      client.exchangeAndValidate({
        code: "authorization-code",
        verifier: "pkce-verifier",
        nonce: "nonce-value",
      }),
    ).resolves.toMatchObject({ subject: "operator-subject" });
  });

  it.each([
    [{ use: "enc", alg: "RS256" }, "encryption-use key"],
    [{ use: "sig", alg: "RS512" }, "different algorithm key"],
  ])("rejects a %s", async (metadata) => {
    const { client } = identityClientWithSigningKey(metadata);
    await expect(
      client.exchangeAndValidate({
        code: "authorization-code",
        verifier: "pkce-verifier",
        nonce: "nonce-value",
      }),
    ).rejects.toThrow("signing key is unavailable");
  });

  it("rejects discovered credential-bearing or insecure endpoints", async () => {
    for (const invalidDiscovery of [
      {
        ...discovery,
        authorization_endpoint: "http://issuer.example/authorize",
      },
      {
        ...discovery,
        token_endpoint: "https://operator:password@issuer.example/token",
      },
      { ...discovery, jwks_uri: "http://issuer.example/keys" },
    ]) {
      const fetchImplementation = vi.fn(
        async () =>
          new Response(JSON.stringify(invalidDiscovery), { status: 200 }),
      ) as unknown as typeof fetch;
      const client = new StandardsOidcClient({
        issuer: discovery.issuer,
        clientId: "caseweaver-admin",
        redirectUri: "https://caseweaver.example/v1/auth/callback",
        scopes: ["openid"],
        fetchImplementation,
      });
      await expect(
        client.authorizationUrl({
          state: "state-value",
          nonce: "nonce-value",
          codeChallenge: "challenge-value",
        }),
      ).rejects.toThrow("HTTPS without credentials");
    }
  });

  it("does not cache a failed discovery response", async () => {
    let attempts = 0;
    const fetchImplementation = vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(null, { status: 503 })
        : new Response(JSON.stringify(discovery), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new StandardsOidcClient({
      issuer: discovery.issuer,
      clientId: "caseweaver-admin",
      redirectUri: "https://caseweaver.example/v1/auth/callback",
      scopes: ["openid"],
      fetchImplementation,
    });

    await expect(
      client.authorizationUrl({
        state: "state-value",
        nonce: "nonce-value",
        codeChallenge: "challenge-value",
      }),
    ).rejects.toThrow("OIDC discovery failed");
    await expect(
      client.authorizationUrl({
        state: "state-value",
        nonce: "nonce-value",
        codeChallenge: "challenge-value",
      }),
    ).resolves.toMatchObject({ pathname: "/authorize" });
    expect(attempts).toBe(2);
  });
});
