import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiClientProvider } from "../api/context.js";
import { AiConfigurationAuthoring } from "./ai-configuration-authoring.js";

describe("AI configuration authoring", () => {
  it("refreshes only the server-owned trusted catalog and never receives catalog bytes", async () => {
    const client = {
      list: vi.fn(async () => ({
        items: [],
        page: { hasNextPage: false },
      })),
      refreshAiCatalog: vi.fn(async () => ({
        id: "catalog-1",
        label: "Trusted catalog snapshot",
        status: "pinned",
        fields: {},
      })),
    };
    render(
      <ApiClientProvider client={client as never}>
        <AiConfigurationAuthoring
          bindingsEnabled={false}
          budgetsEnabled={false}
          catalogRefreshEnabled
          pricingEnabled={false}
          rolesEnabled={false}
        />
      </ApiClientProvider>,
    );

    await userEvent.setup().click(
      await screen.findByRole("button", {
        name: "Refresh trusted model catalog",
      }),
    );

    await screen.findByText(/Trusted catalog snapshot was refreshed/u);
    expect(client.refreshAiCatalog).toHaveBeenCalledWith();
    expect(JSON.stringify(client.refreshAiCatalog.mock.calls)).not.toMatch(
      /raw|github|token|secret|locator/iu,
    );
  });

  it("uses a provider-owned inventory and a server-issued provider-test confirmation", async () => {
    const client = {
      list: vi.fn(async (resource: string) => ({
        items:
          resource === "ai-provider-instances"
            ? [
                {
                  id: "provider-1",
                  label: "Configured provider",
                  status: "active",
                },
              ]
            : resource === "ai-catalog-snapshots"
              ? [{ id: "catalog-1", label: "Pinned catalog" }]
              : resource === "ai-bindings"
                ? [
                    {
                      id: "binding-1",
                      label: "analysis",
                      status: "active",
                      version: "2",
                      summary: "binding-version-1",
                    },
                  ]
                : resource === "ai-role-defaults"
                  ? [{ id: "analysis", label: "analysis", version: "1" }]
                  : [],
        page: { hasNextPage: false },
      })),
      aiBindingOptions: vi.fn(async () => ({
        items: [
          {
            catalogSnapshotId: "catalog-1",
            canonicalModel: "provider/model-1",
            catalogProvider: "provider",
          },
        ],
      })),
      refreshAiProviderModels: vi.fn(async () => ({
        id: "provider-inventory-1",
        label: "Provider model inventory",
        status: "refreshed",
        summary: "2 available models; 1 with trusted pricing",
        fields: {},
      })),
      createAiBindingDraft: vi.fn(async () => ({
        id: "binding-2",
        label: "New binding",
        status: "draft",
        version: "1",
        fields: {},
      })),
      transitionAiBinding: vi.fn(async () => ({
        id: "binding-2",
        label: "New binding",
        status: "active",
        version: "2",
        fields: {},
      })),
      setAiRoleDefault: vi.fn(async () => ({
        id: "analysis",
        label: "AI role default analysis",
        status: "configured",
        version: "2",
        fields: {},
      })),
      createAiPriceOverride: vi.fn(async () => ({
        id: "price-1",
        label: "AI price override price-1",
        status: "configured",
        fields: {},
      })),
      replaceAiBudget: vi.fn(async () => ({
        id: "budget-1",
        label: "AI budget budget-1",
        status: "active",
        version: "1",
        fields: {},
      })),
      providerCapabilityTestOperations: vi.fn(async () => ({
        items: [
          {
            operation: "provider.test",
            requiresConfirmation: true,
            requiresIdempotencyKey: true,
          },
        ],
      })),
      previewProviderCapabilityTest: vi.fn(async () => ({
        providerInstanceId: "provider-1",
        providerInstanceVersionId: "provider-version-1",
        bindingVersionId: "binding-version-1",
        testOperation: "provider.test",
        pricingStatus: "known" as const,
        canConfirm: true,
        confirmationId: "confirmation-1",
        confirmation: "Run provider test",
        impact: "A hard-budget, bounded test will run.",
        estimatedCost: { amount: "0.001", currency: "USD" },
        expiresAt: "2026-07-15T12:05:00.000Z",
      })),
      runProviderCapabilityTest: vi.fn(async () => ({
        id: "test-1",
        providerInstanceId: "provider-1",
        providerInstanceVersionId: "provider-version-1",
        bindingVersionId: "binding-version-1",
        testOperation: "provider.test",
        outcome: "succeeded" as const,
        completedAt: "2026-07-15T12:01:00.000Z",
        idempotency: "created" as const,
      })),
    };
    render(
      <ApiClientProvider client={client as never}>
        <AiConfigurationAuthoring
          bindingsEnabled
          budgetsEnabled
          pricingEnabled
          rolesEnabled
        />
      </ApiClientProvider>,
    );
    const user = userEvent.setup();
    await screen.findByText("Create a model binding draft");
    expect(
      screen.getByText(
        /referenced value must be present in the API deployment environment/u,
      ),
    ).not.toBeNull();
    await user.type(
      screen.getByRole("textbox", {
        name: "Filter provider models",
      }),
      "embedding",
    );
    await waitFor(() =>
      expect(client.aiBindingOptions).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: "embedding" }),
        expect.anything(),
      ),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Refresh models available from provider",
      }),
    );
    await waitFor(() =>
      expect(client.refreshAiProviderModels).toHaveBeenCalledWith("provider-1"),
    );
    expect(
      JSON.stringify(client.refreshAiProviderModels.mock.calls),
    ).not.toMatch(/secret|locator|endpoint|token/iu);
    await user.click(
      screen.getByRole("button", { name: "Help for Budget scope" }),
    );
    expect(
      screen.getByText(/where the API evaluates this cost limit/u),
    ).not.toBeNull();
    await user.keyboard("{Escape}");
    await user.click(
      screen.getByRole("button", { name: "Create binding draft" }),
    );
    await waitFor(() =>
      expect(client.createAiBindingDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          providerInstanceId: "provider-1",
          catalogSnapshotId: "catalog-1",
          canonicalModel: "provider/model-1",
        }),
      ),
    );
    const createPricingOverride = screen.getByRole("button", {
      name: "Create pricing override",
    });
    expect(createPricingOverride.hasAttribute("disabled")).toBe(true);
    await user.type(screen.getByLabelText("Output price amount"), "0.000002");
    await user.click(createPricingOverride);
    await waitFor(() =>
      expect(client.createAiPriceOverride).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "provider",
          canonicalModel: "provider/model-1",
          components: [
            expect.objectContaining({ kind: "input", amount: "0.001" }),
            expect.objectContaining({ kind: "output", amount: "0.000002" }),
          ],
        }),
      ),
    );
    await user.click(
      screen.getByRole("button", { name: "Preview provider test impact" }),
    );
    await screen.findByText("A hard-budget, bounded test will run.");
    await user.click(
      screen.getByRole("button", { name: "Confirm and run provider test" }),
    );
    await waitFor(() =>
      expect(client.runProviderCapabilityTest).toHaveBeenCalledWith(
        "provider-1",
        "provider.test",
        "confirmation-1",
      ),
    );
    expect(
      JSON.stringify(client.runProviderCapabilityTest.mock.calls),
    ).not.toMatch(/secret|locator|endpoint/iu);
  }, 15_000);
});
