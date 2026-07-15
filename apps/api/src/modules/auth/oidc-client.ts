import { createPublicKey, verify } from "node:crypto";

import type {
  OidcAuthorizationCodeClient,
  OidcValidatedIdentity,
} from "@caseweaver/administration";
import { z } from "zod";

const discoverySchema = z
  .object({
    issuer: z.url(),
    authorization_endpoint: z.url(),
    token_endpoint: z.url(),
    jwks_uri: z.url(),
  })
  .passthrough();
const jwksSchema = z
  .object({
    keys: z.array(
      z
        .object({
          kty: z.string(),
          kid: z.string().min(1).max(200).optional(),
          use: z.string().optional(),
          alg: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .strict();
const tokenSchema = z
  .object({ id_token: z.string().min(1).max(32_000) })
  .passthrough();

export interface OidcClientConfiguration {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly redirectUri: string;
  readonly audience?: string;
  readonly scopes: readonly string[];
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
}

interface Discovery {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
}

function base64UrlJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function boundedDisplayName(value: unknown, subject: string): string {
  if (typeof value !== "string") return subject;
  const normalized = value.trim().replace(/[\r\n\t]/gu, " ");
  return normalized.length === 0 ? subject : normalized.slice(0, 160);
}

/** Provider-neutral OIDC client. Token material is never returned to callers. */
export class StandardsOidcClient implements OidcAuthorizationCodeClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => Date;
  private discovery: Promise<Discovery> | undefined;

  public constructor(private readonly configuration: OidcClientConfiguration) {
    const issuer = new URL(configuration.issuer);
    const callback = new URL(configuration.redirectUri);
    if (issuer.protocol !== "https:" || callback.protocol !== "https:") {
      throw new Error("OIDC issuer and callback URL must use HTTPS.");
    }
    if (
      configuration.scopes.length === 0 ||
      !configuration.scopes.includes("openid")
    ) {
      throw new Error("OIDC scopes must include openid.");
    }
    this.fetchImplementation = configuration.fetchImplementation ?? fetch;
    this.now = configuration.now ?? (() => new Date());
  }

  public async authorizationUrl(
    input: Readonly<{
      readonly state: string;
      readonly nonce: string;
      readonly codeChallenge: string;
    }>,
  ): Promise<URL> {
    const discovery = await this.getDiscovery();
    const url = new URL(discovery.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.configuration.clientId);
    url.searchParams.set("redirect_uri", this.configuration.redirectUri);
    url.searchParams.set("scope", this.configuration.scopes.join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("nonce", input.nonce);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url;
  }

  public async exchangeAndValidate(
    input: Readonly<{
      readonly code: string;
      readonly verifier: string;
      readonly nonce: string;
    }>,
  ): Promise<OidcValidatedIdentity> {
    const discovery = await this.getDiscovery();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: this.configuration.redirectUri,
      client_id: this.configuration.clientId,
      code_verifier: input.verifier,
    });
    const headers = new Headers({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    if (this.configuration.clientSecret !== undefined) {
      headers.set(
        "Authorization",
        `Basic ${Buffer.from(`${this.configuration.clientId}:${this.configuration.clientSecret}`).toString("base64")}`,
      );
    }
    const response = await this.fetchImplementation(discovery.tokenEndpoint, {
      method: "POST",
      headers,
      body: body.toString(),
    });
    if (!response.ok) throw new Error("OIDC token exchange failed.");
    const token = tokenSchema.parse(await response.json()).id_token;
    return this.validateIdToken(token, discovery, input.nonce);
  }

  private async getDiscovery(): Promise<Discovery> {
    this.discovery ??= this.loadDiscovery();
    return this.discovery;
  }

  private async loadDiscovery(): Promise<Discovery> {
    const issuer = new URL(this.configuration.issuer);
    const wellKnown = new URL(
      ".well-known/openid-configuration",
      issuer.toString().endsWith("/") ? issuer : new URL(`${issuer}/`),
    );
    const response = await this.fetchImplementation(wellKnown);
    if (!response.ok) throw new Error("OIDC discovery failed.");
    const value = discoverySchema.parse(await response.json());
    if (value.issuer !== this.configuration.issuer)
      throw new Error("OIDC issuer mismatch.");
    return Object.freeze({
      issuer: value.issuer,
      authorizationEndpoint: value.authorization_endpoint,
      tokenEndpoint: value.token_endpoint,
      jwksUri: value.jwks_uri,
    });
  }

  private async validateIdToken(
    token: string,
    discovery: Discovery,
    nonce: string,
  ): Promise<OidcValidatedIdentity> {
    const segments = token.split(".");
    if (
      segments.length !== 3 ||
      segments.some((segment) => segment.length === 0)
    ) {
      throw new Error("OIDC ID token is invalid.");
    }
    const [encodedHeader, encodedClaims, encodedSignature] = segments as [
      string,
      string,
      string,
    ];
    const header = z
      .object({ alg: z.literal("RS256"), kid: z.string().min(1).max(200) })
      .strict()
      .parse(base64UrlJson(encodedHeader));
    const claims = z
      .object({
        iss: z.url(),
        sub: z.string().min(1).max(512),
        aud: z.union([z.string(), z.array(z.string()).min(1)]),
        exp: z.number().int(),
        iat: z.number().int(),
        nbf: z.number().int().optional(),
        nonce: z.string().min(1).max(1_000),
        azp: z.string().optional(),
        name: z.string().optional(),
        preferred_username: z.string().optional(),
      })
      .passthrough()
      .parse(base64UrlJson(encodedClaims));
    const jwksResponse = await this.fetchImplementation(discovery.jwksUri);
    if (!jwksResponse.ok) throw new Error("OIDC key retrieval failed.");
    const key = jwksSchema
      .parse(await jwksResponse.json())
      .keys.find(
        (candidate) =>
          candidate.kid === header.kid &&
          candidate.kty === "RSA" &&
          candidate.use !== "enc",
      );
    if (key === undefined) throw new Error("OIDC signing key is unavailable.");
    const validSignature = verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedClaims}`, "utf8"),
      createPublicKey({ key, format: "jwk" }),
      Buffer.from(encodedSignature, "base64url"),
    );
    if (!validSignature) throw new Error("OIDC ID token signature is invalid.");
    const audience = this.configuration.audience ?? this.configuration.clientId;
    const audiences =
      typeof claims.aud === "string" ? [claims.aud] : claims.aud;
    const now = Math.floor(this.now().getTime() / 1_000);
    if (
      claims.iss !== discovery.issuer ||
      !audiences.includes(audience) ||
      (audiences.length > 1 && claims.azp !== this.configuration.clientId) ||
      claims.exp <= now ||
      claims.iat > now + 60 ||
      (claims.nbf !== undefined && claims.nbf > now + 60) ||
      claims.nonce !== nonce
    ) {
      throw new Error("OIDC ID token claims are invalid.");
    }
    return Object.freeze({
      issuer: claims.iss,
      subject: claims.sub,
      displayName: boundedDisplayName(
        claims.name ?? claims.preferred_username,
        claims.sub,
      ),
      expiresAt: new Date(claims.exp * 1_000).toISOString(),
    });
  }
}
