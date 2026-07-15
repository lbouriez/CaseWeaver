import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { AesGcmEphemeralSecretProtector } from "./ephemeral-secret-protector.js";

describe("AesGcmEphemeralSecretProtector", () => {
  it("purpose-binds sealed ephemeral values", async () => {
    const protector = new AesGcmEphemeralSecretProtector(
      "key-1",
      randomBytes(32).toString("base64url"),
    );
    const sealed = await protector.seal("only-server", "oidc-nonce");
    await expect(protector.open(sealed, "oidc-nonce")).resolves.toBe(
      "only-server",
    );
    await expect(protector.open(sealed, "session-csrf")).rejects.toThrow();
  });
});
