import { describe, expect, it } from "vitest";

import {
  createOidcLoginMaterial,
  matchesDigest,
  normalizeReturnPath,
  normalizeTrustedReturnTarget,
  type OidcIdentityMappingStore,
  sha256Base64Url,
  type SealedEphemeralValue,
} from "./auth.js";

describe("OIDC login material", () => {
  it("uses S256 PKCE and unique opaque browser values", () => {
    const material = createOidcLoginMaterial();
    expect(material.challenge).toBe(sha256Base64Url(material.verifier));
    expect(material.state).not.toBe(material.nonce);
    expect(matchesDigest(material.state, sha256Base64Url(material.state))).toBe(
      true,
    );
  });

  it("accepts only same-origin relative return paths", () => {
    expect(normalizeReturnPath("/operations?tab=jobs")).toBe(
      "/operations?tab=jobs",
    );
    expect(() => normalizeReturnPath("https://attacker.example")).toThrow();
    expect(() => normalizeReturnPath("//attacker.example")).toThrow();
  });

  it("pins post-login redirects to a configured UI origin", () => {
    expect(
      normalizeTrustedReturnTarget("/operations?tab=jobs", [
        "https://admin.example",
      ]),
    ).toBe("https://admin.example/operations?tab=jobs");
    expect(
      normalizeTrustedReturnTarget("https://admin.example/knowledge", [
        "https://admin.example",
      ]),
    ).toBe("https://admin.example/knowledge");
    expect(() =>
      normalizeTrustedReturnTarget("https://attacker.example/steal", [
        "https://admin.example",
      ]),
    ).toThrow(/return target/iu);
  });

  it("models recoverable callback secrets as sealed values, not hashes", () => {
    const nonce: SealedEphemeralValue = {
      keyId: "active-key",
      ciphertext: "opaque-authenticated-ciphertext",
    };
    const store: OidcIdentityMappingStore = {
      findByExternalIdentity: async () => [],
      findByWorkspacePrincipal: async () => undefined,
    };

    expect(nonce.keyId).toBe("active-key");
    expect(store.findByExternalIdentity).toBeTypeOf("function");
  });
});
