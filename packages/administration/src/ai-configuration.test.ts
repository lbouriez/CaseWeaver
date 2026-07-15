import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  AiConfigurationStore,
  TrustedAiConfigurationContext,
} from "./ai-configuration.js";
import {
  ActivateAiModelBinding,
  CreateAiModelBindingDraft,
  CreateAiPriceOverride,
  ImportAiCatalogSnapshot,
  ReplaceAiBudgetPolicy,
  SetAiWorkspaceRoleDefault,
} from "./ai-configuration.js";
import { AdministrationValidationError } from "./errors.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const timestamp = "2026-07-15T12:00:00.000Z";

const context: TrustedAiConfigurationContext = Object.freeze({
  workspaceId: "workspace-1",
  actorPrincipalId: "principal-1",
  occurredAt: timestamp,
  origin: "admin_ui",
  requestId: "request-1",
  correlationId: "correlation-1",
});

const mutation = Object.freeze({
  keyDigest: digest("key"),
  requestDigest: digest("request"),
});

function store(): AiConfigurationStore {
  return {
    importCatalogAndRecord: vi.fn(),
    createBindingDraftAndRecord: vi.fn(),
    createBindingVersionDraftAndRecord: vi.fn(),
    transitionBindingAndRecord: vi.fn(),
    setRoleDefaultAndRecord: vi.fn(),
    createPriceOverrideAndRecord: vi.fn(),
    replaceBudgetPolicyAndRecord: vi.fn(),
  };
}

function catalogModel() {
  return Object.freeze({
    id: "catalog-1:model-1",
    snapshotId: "catalog-1",
    canonicalModel: "model-1",
    provider: "provider-type",
    supportedRoles: new Set(["analysis"]),
    capabilities: new Set(["structuredOutput"]),
    maximumInputTokens: 100,
    maximumOutputTokens: 50,
    priceComponents: [],
    rawEntry: {},
  });
}

function binding() {
  return Object.freeze({
    bindingId: "binding-1",
    version: 1,
    role: "analysis" as const,
    providerInstanceVersionId: "provider-version-1",
    providerType: "provider-type",
    endpoint: "https://provider.example.test",
    canonicalModel: "model-1",
    wireApi: "chatCompletions" as const,
    secretReference: "secret-reference-1",
    catalogModel: catalogModel(),
    requiredCapabilities: ["structuredOutput"] as const,
    maximumInputTokens: 100,
    maximumOutputTokens: 50,
  });
}

describe("AI configuration authoring", () => {
  it("creates a server-audited immutable binding draft without exposing its secret reference in the audit", async () => {
    const fake = store();
    await new CreateAiModelBindingDraft(fake).execute(
      { binding: binding(), mutation },
      context,
    );

    const call = vi.mocked(fake.createBindingDraftAndRecord).mock.calls[0]?.[0];
    expect(call?.binding.bindingVersionId).toBe("binding-1:1");
    expect(call?.audit.action).toBe("admin.aiBinding.draft.create");
    expect(call?.audit.afterHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(call?.audit)).not.toContain("secret-reference-1");
  });

  it("rejects a binding whose catalog model cannot perform its selected role", async () => {
    const fake = store();
    await expect(
      new CreateAiModelBindingDraft(fake).execute(
        { binding: { ...binding(), role: "vision" }, mutation },
        context,
      ),
    ).rejects.toBeInstanceOf(AdministrationValidationError);
    expect(fake.createBindingDraftAndRecord).not.toHaveBeenCalled();
  });

  it("keeps lifecycle action and optimistic concurrency server-owned", async () => {
    const fake = store();
    await new ActivateAiModelBinding(fake).execute(
      { bindingId: "binding-1", expectedRevision: 1, mutation },
      context,
    );
    expect(fake.transitionBindingAndRecord).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: "active", expectedRevision: 1 }),
    );
    const audit = vi.mocked(fake.transitionBindingAndRecord).mock.calls[0]?.[0]
      ?.audit;
    expect(audit?.action).toBe("admin.aiBinding.activate");
    expect(audit?.permission).toBe("configuration.manage");
  });

  it("validates a conditional price override through the shared price resolver", async () => {
    const fake = store();
    await new CreateAiPriceOverride(fake).execute(
      {
        overrideId: "price-override-1",
        scope: "workspace",
        provider: "provider-type",
        canonicalModel: "model-1",
        effectiveFrom: timestamp,
        components: [
          {
            kind: "input",
            unit: "token",
            amount: "0.001",
            currency: "USD",
            conditions: { providerRegion: "ca-east" },
          },
        ],
        mutation,
      },
      context,
    );
    const call = vi.mocked(fake.createPriceOverrideAndRecord).mock
      .calls[0]?.[0];
    expect(call?.override.components[0]?.conditions).toEqual({
      providerRegion: "ca-east",
    });
    expect(call?.audit.afterHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses unsupported price conditions instead of accepting an incomplete price", async () => {
    const fake = store();
    await expect(
      new CreateAiPriceOverride(fake).execute(
        {
          overrideId: "price-override-1",
          scope: "workspace",
          provider: "provider-type",
          canonicalModel: "model-1",
          effectiveFrom: timestamp,
          components: [
            {
              kind: "input",
              unit: "token",
              amount: "0.001",
              currency: "USD",
              conditions: { unsupported: "value" },
            },
          ],
          mutation,
        },
        context,
      ),
    ).rejects.toBeInstanceOf(AdministrationValidationError);
  });

  it("permits the initial role-default and budget-policy revisions only at revision zero", async () => {
    const fake = store();
    await new SetAiWorkspaceRoleDefault(fake).execute(
      {
        role: "analysis",
        bindingVersionId: "binding-1:1",
        expectedRevision: 0,
        mutation,
      },
      context,
    );
    await new ReplaceAiBudgetPolicy(fake).execute(
      {
        budgetPolicyId: "budget-1",
        scope: "workspace",
        scopeKey: "all",
        limitAmount: "10",
        currency: "USD",
        hard: true,
        expectedRevision: 0,
        mutation,
      },
      context,
    );
    expect(fake.setRoleDefaultAndRecord).toHaveBeenCalled();
    expect(fake.replaceBudgetPolicyAndRecord).toHaveBeenCalled();
  });

  it("imports a pinned server-side catalog and records only a safe catalog digest in the audit", async () => {
    const fake = store();
    const raw = new TextEncoder().encode(
      JSON.stringify({
        "provider/model-1": {
          litellm_provider: "provider",
          mode: "chat",
          input_cost_per_token: 0.001,
          output_cost_per_token: 0.002,
        },
      }),
    );
    await new ImportAiCatalogSnapshot(fake).execute(
      {
        import: {
          snapshotId: "catalog-1",
          rawBytes: raw,
          upstreamUrl: "https://catalog.example.test/model_prices.json",
          upstreamCommitSha: "deadbeef",
          fetchedAt: timestamp,
          verifiedSha256: createHash("sha256").update(raw).digest("hex"),
        },
        mutation,
      },
      context,
    );
    const call = vi.mocked(fake.importCatalogAndRecord).mock.calls[0]?.[0];
    expect(call?.catalog.models).toHaveLength(1);
    expect(call?.audit.afterHash).toBe(call?.catalog.sha256);
    expect(JSON.stringify(call?.audit)).not.toContain("model_prices.json");
  });
});
