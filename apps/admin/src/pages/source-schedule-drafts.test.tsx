import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiClientProvider } from "../api/context.js";
import { SourceScheduleDrafts } from "./source-schedule-drafts.js";

describe("source and schedule drafts", () => {
  it("discovers scoped records and submits resource-specific immutable drafts", async () => {
    const client = {
      list: vi.fn(async (resource: string) => ({
        items:
          resource === "connector-instances"
            ? [
                {
                  id: "connector-1",
                  label: "Knowledge connector",
                  status: "active",
                  summary: "future-bridge",
                },
              ]
            : resource === "collections"
              ? [{ id: "collection-1", label: "Support knowledge" }]
              : resource === "ai-budgets"
                ? [
                    {
                      id: "budget-1",
                      label: "Workspace · workspace-1",
                      status: "hard",
                    },
                  ]
                : resource === "knowledge-sources"
                  ? [
                      {
                        id: "source-1",
                        label: "Existing source",
                        status: "enabled",
                      },
                    ]
                  : [],
        page: { hasNextPage: false },
      })),
      configurationInspection: vi.fn(async () => ({
        id: "source-1",
        resourceType: "knowledge-sources",
        lifecycle: "active" as const,
        revision: 2,
        updatedAt: "2026-07-15T12:00:00.000Z",
        currentVersionId: "source-version-2",
      })),
      listDescriptors: vi.fn(async () => [
        {
          kind: "connector" as const,
          type: "future-bridge",
          version: "1",
          displayName: "Knowledge connector",
          description: "Synthetic knowledge connector.",
          connectorCapabilities: ["knowledgeSource" as const],
          aiCapabilities: [],
          supportedWireApis: [],
          supportedWebhookEventTypes: [],
          settingsSchema: { type: "object" as const },
          uiGroups: [],
          secretSlots: [],
          supportsConfigurationMigration: false,
          supportedTestOperations: [],
        },
      ]),
      createKnowledgeSourceDraft: vi.fn(async () => ({
        id: "source-2",
        label: "New source",
        status: "draft",
        version: "1",
        fields: {},
      })),
      createKnowledgeScheduleDraft: vi.fn(async () => ({
        id: "schedule-1",
        label: "Hourly synchronization",
        status: "draft",
        version: "1",
        fields: {},
      })),
    };
    render(
      <ApiClientProvider client={client as never}>
        <SourceScheduleDrafts scheduleEnabled sourceEnabled />
      </ApiClientProvider>,
    );

    await screen.findByText("Create an inert source draft");
    expect(
      screen.getByText(
        /does not contact a connector, schedule work, or ingest content/u,
      ),
    ).not.toBeNull();
    expect(
      screen.getByText(
        /Collections are created and maintained in Knowledge & Analysis/u,
      ),
    ).not.toBeNull();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Help for Source synchronization policy",
      }),
    );
    expect(
      screen.getByText(
        /feature-level JSON policy for when the source may synchronize/u,
      ),
    ).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    await userEvent.type(
      screen.getByLabelText(/Source display name/u),
      "New source",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Create source draft" }),
    );
    await waitFor(() =>
      expect(client.createKnowledgeSourceDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          displayName: "New source",
          connectorInstanceId: "connector-1",
          collectionId: "collection-1",
          normalizationProfileId: "text-normalization",
          normalizationProfileVersion: "v1",
          chunkingProfileId: "text-chunking",
          chunkingProfileVersion: "v1",
          embeddingBatchSize: 16,
          embeddingBudgetPolicyId: "budget-1",
          attachmentStage: { mode: "disabled" },
          synchronizationPolicy: { triggers: [{ mode: "manual" }] },
          deletionBehavior: "tombstone",
        }),
      ),
    );
    expect(
      JSON.stringify(client.createKnowledgeSourceDraft.mock.calls),
    ).not.toMatch(/secret|token|password/iu);

    await userEvent.type(
      screen.getByLabelText(/Schedule display name/u),
      "Hourly synchronization",
    );
    await waitFor(() =>
      expect(client.configurationInspection).toHaveBeenCalled(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Create schedule draft" }),
    );
    await waitFor(() =>
      expect(client.createKnowledgeScheduleDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          displayName: "Hourly synchronization",
          sourceId: "source-1",
          sourceConfigurationVersionId: "source-version-2",
          cadence: expect.objectContaining({ kind: "interval" }),
        }),
      ),
    );
  }, 15_000);
});
