import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiClientProvider } from "../api/context.js";
import { DescriptorCatalog } from "./descriptor-catalog.js";

describe("DescriptorCatalog", () => {
  it("wires server-discovered connector draft-test preview and confirmation without creating a draft", async () => {
    const client = {
      listDescriptors: vi.fn(async () => [
        {
          kind: "connector" as const,
          type: "fixture-source",
          version: "v1",
          displayName: "Fixture source",
          description: "A descriptor fixture.",
          connectorCapabilities: ["knowledgeSource" as const],
          aiCapabilities: [],
          supportedWireApis: [],
          supportedWebhookEventTypes: [],
          settingsSchema: {
            type: "object" as const,
            properties: { endpoint: { type: "string" as const } },
            required: ["endpoint"],
          },
          uiGroups: [],
          secretSlots: [],
          supportsConfigurationMigration: false,
          supportedTestOperations: ["connector.test"],
        },
      ]),
      list: vi.fn(async () => ({
        items: [],
        page: { hasNextPage: false },
      })),
      connectorDraftTestOperations: vi.fn(async () => [
        {
          operation: "connector.test",
          requiresConfirmation: true,
          requiresIdempotencyKey: true,
        },
      ]),
      previewConnectorDraftTest: vi.fn(async () => ({
        descriptorType: "fixture-source",
        descriptorVersion: "v1",
        testOperation: "connector.test",
        canConfirm: true,
        confirmationId: "confirmation-1",
        impact: "The server will run one bounded connection check.",
        expiresAt: "2026-07-16T12:05:00.000Z",
      })),
      runConnectorDraftTest: vi.fn(async () => ({
        id: "test-1",
        descriptorType: "fixture-source",
        descriptorVersion: "v1",
        testOperation: "connector.test",
        outcome: "succeeded" as const,
        completedAt: "2026-07-16T12:01:00.000Z",
        idempotency: "created" as const,
      })),
      createDescriptorDraft: vi.fn(),
    };
    render(
      <ApiClientProvider client={client as never}>
        <DescriptorCatalog kind="connector" title="Connector drafts" />
      </ApiClientProvider>,
    );
    const user = userEvent.setup();

    await user.type(
      await screen.findByRole("textbox", { name: "endpoint" }),
      "https://connector.example.test",
    );
    await waitFor(() =>
      expect(client.connectorDraftTestOperations).toHaveBeenCalledWith(
        "fixture-source",
        expect.any(AbortSignal),
      ),
    );
    await user.click(
      screen.getByRole("button", { name: "Preview configuration test" }),
    );
    await waitFor(() =>
      expect(client.previewConnectorDraftTest).toHaveBeenCalledWith(
        "fixture-source",
        "connector.test",
        { endpoint: "https://connector.example.test" },
      ),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Confirm and run configuration test",
      }),
    );
    await waitFor(() =>
      expect(client.runConnectorDraftTest).toHaveBeenCalledWith(
        "fixture-source",
        "connector.test",
        { endpoint: "https://connector.example.test" },
        "confirmation-1",
      ),
    );
    expect(client.createDescriptorDraft).not.toHaveBeenCalled();
  });

  it("saves an AI provider inactive and requires a separate server-reviewed activation", async () => {
    const onActivated = vi.fn();
    const client = {
      listDescriptors: vi.fn(async () => [
        {
          kind: "ai-provider" as const,
          type: "fixture-compatible-provider",
          version: "v1",
          displayName: "Fixture-compatible provider",
          description: "A provider descriptor fixture.",
          connectorCapabilities: [],
          aiCapabilities: ["analysis" as const],
          supportedWireApis: ["chatCompletions"],
          supportedWebhookEventTypes: [],
          settingsSchema: {
            type: "object" as const,
            properties: { endpoint: { type: "string" as const } },
            required: ["endpoint"],
          },
          uiGroups: [],
          secretSlots: [],
          supportsConfigurationMigration: false,
          supportedTestOperations: [],
        },
      ]),
      list: vi.fn(async () => ({
        items: [],
        page: { hasNextPage: false },
      })),
      createDescriptorDraft: vi.fn(async () => ({
        id: "provider-draft-1",
        label: "OpenRouter",
        status: "draft",
        version: "1",
        fields: { descriptorType: "fixture-compatible-provider" },
      })),
      previewAction: vi.fn(async () => ({
        previewId: "activation-preview-1",
        canConfirm: true,
        confirmation: "Activate this provider.",
        impact: "The provider will become eligible for model bindings.",
        expiresAt: "2026-07-17T12:05:00.000Z",
      })),
      executeAction: vi.fn(async () => ({
        operationId: "activation-operation-1",
        outcome: "completed" as const,
        message: "Provider activated.",
      })),
    };
    render(
      <ApiClientProvider client={client as never}>
        <DescriptorCatalog
          kind="ai-provider"
          onActivated={onActivated}
          title="Configure an AI provider"
        />
      </ApiClientProvider>,
    );
    const user = userEvent.setup();

    await user.clear(
      await screen.findByRole("textbox", { name: "Instance display name" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Instance display name" }),
      "OpenRouter",
    );
    await user.type(
      screen.getByRole("textbox", { name: "endpoint" }),
      "https://provider.example.test",
    );
    await user.click(
      screen.getByRole("button", { name: "Save inactive provider" }),
    );

    await screen.findByText(/Provider OpenRouter was saved inactive/u);
    expect(client.createDescriptorDraft).toHaveBeenCalledWith("ai-provider", {
      descriptorType: "fixture-compatible-provider",
      displayName: "OpenRouter",
      settings: { endpoint: "https://provider.example.test" },
    });

    await user.click(
      screen.getByRole("button", { name: "Review and activate provider" }),
    );
    await screen.findByText("Activate this provider.");
    await user.click(screen.getByRole("button", { name: "Confirm operation" }));

    await waitFor(() => expect(onActivated).toHaveBeenCalledOnce());
    expect(client.executeAction).toHaveBeenCalledWith("activation-preview-1");
    await screen.findByText(/Provider OpenRouter is active/u);
  });
});
