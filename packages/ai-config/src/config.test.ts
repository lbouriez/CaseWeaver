import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  type CatalogModel,
  calculateCost,
  conservativeReservationUsage,
  createImmutableBinding,
  decimal,
  InMemoryAiBindingResolver,
  importLiteLlmCatalog,
  type PriceComponent,
  resolvePrices,
} from "./index.js";

const input: PriceComponent = {
  id: "input",
  kind: "input",
  unit: "token",
  amount: decimal("0.001"),
  currency: "USD",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  sourceId: "catalog",
  conditions: {},
};

const output: PriceComponent = {
  ...input,
  id: "output",
  kind: "output",
  amount: decimal("0.002"),
};

const cacheRead: PriceComponent = {
  ...input,
  id: "cache-read",
  kind: "cacheRead",
  amount: decimal("0.0001"),
};

const cacheCreation: PriceComponent = {
  ...input,
  id: "cache-create",
  kind: "cacheCreation",
  amount: decimal("0.0002"),
};

function catalogModel(): CatalogModel {
  return {
    id: "catalog-model",
    snapshotId: "snapshot-1",
    canonicalModel: "model",
    provider: "openai",
    supportedRoles: new Set(["analysis"]),
    capabilities: new Set(["promptCaching"]),
    maximumInputTokens: 100,
    maximumOutputTokens: 50,
    priceComponents: [input, output, cacheRead, cacheCreation],
    rawEntry: {},
  };
}

describe("AI binding and catalog configuration", () => {
  it("creates immutable validated bindings and resolves explicit IDs before defaults", async () => {
    const binding = createImmutableBinding({
      workspaceId: "workspace-1",
      bindingId: "binding-1",
      version: 1,
      role: "analysis",
      providerInstanceVersionId: "provider-version-1",
      providerType: "openai-compatible",
      endpoint: "https://models.example",
      canonicalModel: "model",
      wireApi: "chatCompletions",
      secretReference: "vault:model",
      catalogModel: catalogModel(),
      requiredCapabilities: ["promptCaching"],
      maximumInputTokens: 100,
      maximumOutputTokens: 50,
    });
    const resolver = new InMemoryAiBindingResolver({
      bindings: [binding],
      defaults: [
        {
          workspaceId: "workspace-1",
          role: "analysis",
          bindingVersionId: "binding-1:1",
        },
      ],
    });

    await expect(
      resolver.resolve({
        workspaceId: "workspace-1",
        role: "analysis",
        bindingVersionId: "binding-1:1",
        inputTokens: 101,
      }),
    ).rejects.toMatchObject({ code: "ai.capability" });
    await expect(
      resolver.resolve({ workspaceId: "workspace-1", role: "analysis" }),
    ).resolves.toBe(binding);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(() =>
      createImmutableBinding({
        workspaceId: "workspace-1",
        bindingId: "binding-2",
        version: 1,
        role: "vision",
        providerInstanceVersionId: "provider-version-1",
        providerType: "openai-compatible",
        endpoint: "https://models.example",
        canonicalModel: "model",
        wireApi: "chatCompletions",
        secretReference: "vault:model",
        catalogModel: catalogModel(),
      }),
    ).toThrow(/role/);
  });

  it("imports raw LiteLLM bytes, preserves unknown fields, and rejects malformed prices", () => {
    const source = JSON.stringify({
      "provider/model": {
        litellm_provider: "openai",
        mode: "chat",
        max_input_tokens: 100,
        max_output_tokens: 20,
        input_cost_per_token: 0.001,
        output_cost_per_token: 0.002,
        future_field: { survives: true },
      },
    });
    const bytes = new TextEncoder().encode(source);
    const imported = importLiteLlmCatalog({
      snapshotId: "snapshot-1",
      rawBytes: bytes,
      upstreamUrl: "https://example.invalid/catalog.json",
      upstreamCommitSha: "abcdef0",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      verifiedSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(imported.models[0]?.rawEntry.future_field).toEqual({
      survives: true,
    });

    const malformed = new TextEncoder().encode(
      JSON.stringify({
        "provider/model": {
          litellm_provider: "openai",
          input_cost_per_token: "NaN",
        },
      }),
    );
    expect(() =>
      importLiteLlmCatalog({
        snapshotId: "snapshot-2",
        rawBytes: malformed,
        upstreamUrl: "https://example.invalid/catalog.json",
        upstreamCommitSha: "abcdef0",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        verifiedSha256: createHash("sha256").update(malformed).digest("hex"),
      }),
    ).toThrow(/decimal/);
  });

  it("prices all token components, preserves zero as known, and applies precedence", () => {
    const context = {
      at: "2026-02-01T00:00:00.000Z",
      currency: "USD",
    };
    const bindingInput: PriceComponent = {
      ...input,
      id: "binding-input",
      amount: decimal("0"),
      sourceId: "binding",
    };
    const resolution = resolvePrices(
      {
        bindingOverrides: [bindingInput],
        workspaceOverrides: [],
        installationOverrides: [],
        catalogComponents: [input, output, cacheRead, cacheCreation],
      },
      ["input", "output", "cacheRead", "cacheCreation"],
      context,
    );
    const cost = calculateCost(resolution, {
      input: 2,
      output: 3,
      cacheRead: 4,
      cacheCreation: 5,
    });
    expect(cost).toMatchObject({ status: "known", amount: "0.0074" });
    expect(
      conservativeReservationUsage({
        maximumInputTokens: 10,
        maximumOutputTokens: 5,
        mayUsePromptCache: true,
      }),
    ).toEqual({
      input: 10,
      output: 5,
      cacheRead: 10,
      cacheCreation: 10,
      image: 0,
      audio: 0,
    });
  });

  it("does not report unknown or unsupported conditional prices as zero and rejects ties", () => {
    const context = {
      at: "2026-02-01T00:00:00.000Z",
      currency: "USD",
    };
    expect(
      calculateCost(
        resolvePrices(
          {
            bindingOverrides: [],
            workspaceOverrides: [],
            installationOverrides: [],
            catalogComponents: [],
          },
          ["input"],
          context,
        ),
        { input: 1 },
      ),
    ).toMatchObject({ status: "unknown", amount: undefined });

    const unsupported: PriceComponent = {
      ...input,
      conditions: { unrecognizedCondition: "x" },
    };
    expect(
      resolvePrices(
        {
          bindingOverrides: [],
          workspaceOverrides: [],
          installationOverrides: [],
          catalogComponents: [unsupported],
        },
        ["input"],
        context,
      ),
    ).toMatchObject({ status: "incomplete" });

    expect(() =>
      resolvePrices(
        {
          bindingOverrides: [],
          workspaceOverrides: [],
          installationOverrides: [],
          catalogComponents: [input, { ...input, id: "input-tied" }],
        },
        ["input"],
        context,
      ),
    ).toThrow(/tied/);
  });

  it("applies scope precedence before condition specificity and effective time", () => {
    const context = {
      at: "2026-06-01T00:00:00.000Z",
      currency: "USD",
      providerRegion: "us-east",
    };
    const catalog = { ...input, id: "catalog", amount: decimal("0.001") };
    const installation = {
      ...input,
      id: "installation",
      amount: decimal("0.002"),
      conditions: { providerRegion: "us-east" },
    };
    const workspaceGeneric = {
      ...input,
      id: "workspace-generic",
      amount: decimal("0.003"),
      effectiveFrom: "2026-05-01T00:00:00.000Z",
    };
    const workspaceSpecific = {
      ...input,
      id: "workspace-specific",
      amount: decimal("0.004"),
      conditions: { providerRegion: "us-east" },
    };
    const binding = {
      ...input,
      id: "binding",
      amount: decimal("0.005"),
    };

    const bindingResolution = resolvePrices(
      {
        bindingOverrides: [binding],
        workspaceOverrides: [workspaceGeneric, workspaceSpecific],
        installationOverrides: [installation],
        catalogComponents: [catalog],
      },
      ["input"],
      context,
    );
    expect(bindingResolution.components[0]?.component?.id).toBe("binding");

    const workspaceResolution = resolvePrices(
      {
        bindingOverrides: [],
        workspaceOverrides: [workspaceGeneric, workspaceSpecific],
        installationOverrides: [installation],
        catalogComponents: [catalog],
      },
      ["input"],
      context,
    );
    expect(workspaceResolution.components[0]?.component?.id).toBe(
      "workspace-specific",
    );

    const newestResolution = resolvePrices(
      {
        bindingOverrides: [],
        workspaceOverrides: [
          { ...workspaceGeneric, id: "workspace-old" },
          {
            ...workspaceGeneric,
            id: "workspace-new",
            effectiveFrom: "2026-05-15T00:00:00.000Z",
          },
        ],
        installationOverrides: [installation],
        catalogComponents: [catalog],
      },
      ["input"],
      context,
    );
    expect(newestResolution.components[0]?.component?.id).toBe("workspace-new");
  });

  it("marks malformed recognized conditions incomplete rather than falling back", () => {
    const malformedCondition: PriceComponent = {
      ...input,
      id: "malformed-condition",
      conditions: { providerRegion: true },
    };

    expect(
      resolvePrices(
        {
          bindingOverrides: [],
          workspaceOverrides: [malformedCondition],
          installationOverrides: [],
          catalogComponents: [input],
        },
        ["input"],
        {
          at: "2026-02-01T00:00:00.000Z",
          currency: "USD",
          providerRegion: "us-east",
        },
      ),
    ).toMatchObject({ status: "incomplete" });
  });

  it("does not fall back for unsupported condition keys", () => {
    const resolution = resolvePrices(
      {
        bindingOverrides: [],
        workspaceOverrides: [
          {
            ...input,
            id: "unsupported-workspace-condition",
            conditions: { futureCondition: "enabled" },
          },
        ],
        installationOverrides: [],
        catalogComponents: [input],
      },
      ["input"],
      {
        at: "2026-02-01T00:00:00.000Z",
        currency: "USD",
      },
    );

    expect(resolution).toMatchObject({ status: "incomplete" });
    expect(resolution.components[0]).not.toHaveProperty("component");
  });

  it("does not fall back for malformed or context-incomplete conditions", () => {
    const completeContext = {
      at: "2026-02-01T00:00:00.000Z",
      currency: "USD",
      providerRegion: "us-east",
      serviceTier: "standard",
      batchMode: false,
      contextTier: "default",
      mediaType: "text",
      inputTokenCount: 10,
    };
    const malformedConditions: readonly PriceComponent["conditions"][] = [
      { providerRegion: true },
      { serviceTier: "" },
      { batchMode: "false" },
      { contextTier: 1 },
      { mediaType: false },
      { inputTokenThreshold: -1 },
      { inputTokenThreshold: 1.5 },
      { inputTokenThreshold: Number.MAX_SAFE_INTEGER + 1 },
    ];

    for (const conditions of malformedConditions) {
      expect(
        resolvePrices(
          {
            bindingOverrides: [],
            workspaceOverrides: [{ ...input, conditions }],
            installationOverrides: [],
            catalogComponents: [input],
          },
          ["input"],
          completeContext,
        ),
      ).toMatchObject({ status: "incomplete" });
    }

    for (const [conditions, context] of [
      [
        { providerRegion: "us-east" },
        { ...completeContext, providerRegion: undefined },
      ],
      [
        { serviceTier: "standard" },
        { ...completeContext, serviceTier: undefined },
      ],
      [{ batchMode: false }, { ...completeContext, batchMode: undefined }],
      [
        { contextTier: "default" },
        { ...completeContext, contextTier: undefined },
      ],
      [{ mediaType: "text" }, { ...completeContext, mediaType: undefined }],
      [
        { inputTokenThreshold: 10 },
        { ...completeContext, inputTokenCount: undefined },
      ],
    ] as const) {
      expect(
        resolvePrices(
          {
            bindingOverrides: [],
            workspaceOverrides: [{ ...input, conditions }],
            installationOverrides: [],
            catalogComponents: [input],
          },
          ["input"],
          context,
        ),
      ).toMatchObject({ status: "incomplete" });
    }

    expect(
      resolvePrices(
        {
          bindingOverrides: [],
          workspaceOverrides: [
            {
              ...input,
              conditions: {
                providerRegion: "eu-west",
                batchMode: "false",
              },
            },
          ],
          installationOverrides: [],
          catalogComponents: [input],
        },
        ["input"],
        completeContext,
      ),
    ).toMatchObject({ status: "incomplete" });

    expect(
      resolvePrices(
        {
          bindingOverrides: [],
          workspaceOverrides: [
            { ...input, conditions: { providerRegion: "eu-west" } },
          ],
          installationOverrides: [],
          catalogComponents: [input],
        },
        ["input"],
        completeContext,
      ),
    ).toMatchObject({
      status: "known",
      components: [{ component: { id: "input" }, status: "known" }],
    });
  });
});
