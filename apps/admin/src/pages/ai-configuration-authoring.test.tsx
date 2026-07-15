import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiClientProvider } from "../api/context.js";
import { AiConfigurationAuthoring } from "./ai-configuration-authoring.js";

describe("AI configuration authoring", () => {
  it("uses only server-discovered identities and a server-issued provider-test confirmation", async () => {
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
              : resource === "ai-models"
                ? [
                    {
                      id: "model-1",
                      label: "provider/model-1",
                      summary: "provider",
                    },
                  ]
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
  });
});
