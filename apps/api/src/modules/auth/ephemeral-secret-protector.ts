import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type {
  EphemeralSecretProtector,
  SealedEphemeralValue,
} from "@caseweaver/administration";

type Purpose = "oidc-nonce" | "oidc-pkce-verifier" | "session-csrf";

/**
 * Deployment-keyed AES-256-GCM protection for the only ephemeral values which
 * must survive an OIDC redirect.  Ciphertexts are purpose-bound and contain no
 * plaintext in URLs, logs, or API DTOs.
 */
export class AesGcmEphemeralSecretProtector
  implements EphemeralSecretProtector
{
  private readonly key: Buffer;

  public constructor(
    private readonly keyId: string,
    encodedKey: string,
  ) {
    this.key = decodeKey(encodedKey);
  }

  public async seal(
    plaintext: string,
    purpose: Purpose,
  ): Promise<SealedEphemeralValue> {
    if (plaintext.length === 0 || plaintext.length > 4_096) {
      throw new Error("Ephemeral plaintext is invalid.");
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(purpose, "utf8"));
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return Object.freeze({
      keyId: this.keyId,
      ciphertext: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
        "base64url",
      ),
    });
  }

  public async open(
    value: SealedEphemeralValue,
    purpose: Purpose,
  ): Promise<string> {
    if (
      value.keyId !== this.keyId ||
      !/^[A-Za-z0-9_-]{38,8192}$/u.test(value.ciphertext)
    ) {
      throw new Error("Ephemeral ciphertext is invalid.");
    }
    try {
      const encoded = Buffer.from(value.ciphertext, "base64url");
      if (encoded.length < 29)
        throw new Error("Ephemeral ciphertext is invalid.");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        encoded.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from(purpose, "utf8"));
      decipher.setAuthTag(encoded.subarray(12, 28));
      const plaintext = Buffer.concat([
        decipher.update(encoded.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
      if (plaintext.length === 0 || plaintext.length > 4_096)
        throw new Error("Ephemeral plaintext is invalid.");
      return plaintext;
    } catch {
      throw new Error("Ephemeral ciphertext is invalid.");
    }
  }
}

function decodeKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/_-]{43,44}={0,2}$/u.test(value)) {
    throw new Error("OIDC ephemeral encryption key is invalid.");
  }
  const key = Buffer.from(
    value,
    value.includes("-") || value.includes("_") ? "base64url" : "base64",
  );
  if (key.length !== 32)
    throw new Error("OIDC ephemeral encryption key is invalid.");
  return key;
}
