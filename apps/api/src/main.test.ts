import { canonicalizeConfiguration } from "@caseweaver/administration";
import { describe, expect, it } from "vitest";
import {
  aiBindingDraftRequestIdentity,
  aiPriceOverrideRequestIdentity,
  createTrustedAiCatalogRefreshMutation,
  trustedAiCatalogRefreshFailureKind,
} from "./main.js";
import { digestIdempotencyKey } from "./modules/administration/operation-dispatcher.js";

describe("trusted AI catalog refresh composition", () => {
  it("uses the AI configuration store's fixed-width digest contract", () => {
    const mutation = createTrustedAiCatalogRefreshMutation(
      "browser-idempotency-key",
    );

    expect(mutation).toEqual({
      keyDigest: digestIdempotencyKey("browser-idempotency-key"),
      requestDigest: digestIdempotencyKey("trusted-litellm-catalog-refresh-v1"),
    });
    expect(mutation.keyDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(mutation.requestDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("reduces refresh failures to safe operational categories", () => {
    const source = new Error("do not log this");
    source.name = "TrustedAiCatalogSourceError";
    const persistence = new Error("do not log this");
    persistence.name = "PrismaClientKnownRequestError";
    const validation = new Error("do not log this");
    validation.name = "AdministrationValidationError";

    expect(trustedAiCatalogRefreshFailureKind(source)).toBe("source");
    expect(trustedAiCatalogRefreshFailureKind(persistence)).toBe("persistence");
    expect(trustedAiCatalogRefreshFailureKind(validation)).toBe("validation");
    expect(
      trustedAiCatalogRefreshFailureKind(new Error("do not log this")),
    ).toBe("unknown");
  });
});

describe("AI binding draft composition", () => {
  it("omits absent optional limits from the canonical mutation identity", () => {
    const identity = aiBindingDraftRequestIdentity({
      providerInstanceId: "provider-1",
      catalogSnapshotId: "provider-inventory-1",
      canonicalModel: "provider/model-1",
      role: "embedding",
    });

    expect(identity).toEqual({
      providerInstanceId: "provider-1",
      catalogSnapshotId: "provider-inventory-1",
      canonicalModel: "provider/model-1",
      role: "embedding",
      requiredCapabilities: [],
    });
    expect(() => canonicalizeConfiguration(identity)).not.toThrow();
  });
});

describe("AI pricing override composition", () => {
  it("omits optional workspace-only fields from the canonical mutation identity", () => {
    const identity = aiPriceOverrideRequestIdentity({
      scope: "workspace",
      provider: "openai-compatible",
      canonicalModel: "provider/model-1",
      effectiveFrom: "2026-07-30T00:00:00.000Z",
      components: [
        { kind: "input", unit: "token", amount: "0.000001", currency: "USD" },
      ],
    });

    expect(identity).not.toHaveProperty("bindingVersionId");
    expect(identity).not.toHaveProperty("effectiveTo");
    expect(() => canonicalizeConfiguration(identity)).not.toThrow();
  });
});
