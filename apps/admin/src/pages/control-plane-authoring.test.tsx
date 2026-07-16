import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ControlPlaneAuthoring } from "./control-plane-authoring.js";

describe("control-plane authoring", () => {
  it("creates publication and webhook drafts using opaque registration IDs and updates public links with a server revision", async () => {
    const client = {
      createPublicationProfileDraft: vi.fn(async () => ({
        id: "publication-1",
        label: "Release note",
        status: "draft",
        version: "1",
        fields: {},
      })),
      createWebhookEndpointDraft: vi.fn(async () => ({
        id: "webhook-1",
        label: "Case events",
        status: "draft",
        version: "1",
        fields: {},
      })),
      configurationInspection: vi.fn(),
      transitionPublicationProfile: vi.fn(),
      transitionWebhookEndpoint: vi.fn(),
      list: vi.fn(async (resource: string) => ({
        items:
          resource === "connector-instances"
            ? [
                {
                  id: "connector-1",
                  label: "Webhook adapter",
                  status: "active",
                  summary: "future-webhook",
                },
              ]
            : [
                {
                  id: "registration-1",
                  label: "Signing reference",
                  status: "active",
                },
              ],
        page: { hasNextPage: false },
      })),
      platformLinks: vi.fn(async () => ({
        workspaceId: "workspace-1",
        configurationId: "platform-links:workspace-1",
        configurationVersionId: "platform-version-2",
        revision: 2,
        lifecycle: "active",
        settings: {
          apiPublicBaseUrl: "https://api.example.test/v1",
          webhookPublicBaseUrl: "https://hooks.example.test/ingress",
        },
      })),
      listDescriptors: vi.fn(async () => [
        {
          kind: "connector" as const,
          type: "future-webhook",
          version: "1",
          displayName: "Webhook adapter",
          description: "Synthetic webhook connector.",
          connectorCapabilities: ["webhookAdapter" as const],
          aiCapabilities: [],
          supportedWireApis: [],
          supportedWebhookEventTypes: ["caseChanged"],
          settingsSchema: { type: "object" as const },
          uiGroups: [],
          secretSlots: [],
          supportsConfigurationMigration: false,
          supportedTestOperations: [],
        },
      ]),
      savePlatformLinks: vi.fn(async () => ({
        id: "platform-links",
        label: "Public links",
        status: "active",
        version: "3",
        fields: {},
      })),
    };
    const completed = vi.fn();
    render(
      <ControlPlaneAuthoring
        client={client as never}
        onCompleted={completed}
        platformEnabled
        publicationEnabled
        webhookEnabled
      />,
    );
    const user = userEvent.setup();

    await screen.findByRole("checkbox", { name: "Signing reference" });
    await screen.findByDisplayValue("https://api.example.test/v1");
    await user.click(
      screen.getByRole("button", { name: "Help for Webhook event types" }),
    );
    expect(
      screen.getByText(
        /event codes that this endpoint is permitted to receive/u,
      ),
    ).not.toBeNull();
    await user.keyboard("{Escape}");

    await user.type(
      screen.getByLabelText(/^Publication profile display name/u),
      "Release note",
    );
    fireEvent.change(screen.getByLabelText(/^Publication definition/u), {
      target: { value: '{"analysisDestination":"destination-1"}' },
    });
    await user.click(
      screen.getByRole("button", { name: "Create publication profile draft" }),
    );
    await waitFor(() =>
      expect(client.createPublicationProfileDraft).toHaveBeenCalledWith({
        displayName: "Release note",
        definition: { analysisDestination: "destination-1" },
      }),
    );

    await user.type(
      screen.getByLabelText(/^Webhook display name/u),
      "Case events",
    );
    await user.type(
      screen.getByLabelText(/^Verified event types/u),
      "caseChanged",
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Signing reference" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Create webhook endpoint draft" }),
    );
    await waitFor(() =>
      expect(client.createWebhookEndpointDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          displayName: "Case events",
          connectorInstanceId: "connector-1",
          verifiedEventTypes: ["caseChanged"],
          secretReferenceRegistrationIds: ["registration-1"],
        }),
      ),
    );
    expect(
      JSON.stringify(client.createWebhookEndpointDraft.mock.calls),
    ).not.toMatch(/vault:|secret[-_ ]?value|password|token/iu);

    await user.clear(screen.getByLabelText(/^Public API base URL/u));
    await user.type(
      screen.getByLabelText(/^Public API base URL/u),
      "https://api.example.test/v2",
    );
    await user.click(screen.getByRole("button", { name: "Save public links" }));
    await waitFor(() =>
      expect(client.savePlatformLinks).toHaveBeenCalledWith({
        apiPublicBaseUrl: "https://api.example.test/v2",
        webhookPublicBaseUrl: "https://hooks.example.test/ingress",
        expectedRevision: 2,
      }),
    );
  }, 15_000);

  it("fails closed when JSON configuration contains a credential-shaped field", async () => {
    const createPublicationProfileDraft = vi.fn();
    render(
      <ControlPlaneAuthoring
        client={
          {
            createPublicationProfileDraft,
          } as never
        }
        onCompleted={vi.fn()}
        platformEnabled={false}
        publicationEnabled
        webhookEnabled={false}
      />,
    );
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText(/^Publication profile display name/u),
      "Unsafe policy",
    );
    fireEvent.change(screen.getByLabelText(/^Publication definition/u), {
      target: { value: '{"apiKey":"must-not-be-retained"}' },
    });
    await user.click(
      screen.getByRole("button", { name: "Create publication profile draft" }),
    );

    expect(createPublicationProfileDraft).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).not.toBeNull();
    expect(document.body.textContent).not.toContain("must-not-be-retained");
    expect(
      (screen.getByLabelText(/^Publication definition/u) as HTMLTextAreaElement)
        .value,
    ).toBe("{}");
  });
});
