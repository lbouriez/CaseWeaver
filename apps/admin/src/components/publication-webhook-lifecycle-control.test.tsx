import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PublicationWebhookLifecycleControl } from "./publication-webhook-lifecycle-control.js";

describe("publication and webhook lifecycle control", () => {
  it("loads the server-owned revision then transitions a webhook without resubmitting its settings or references", async () => {
    const client = {
      configurationInspection: vi.fn(async () => ({
        id: "webhook-1",
        resourceType: "webhook-endpoints",
        lifecycle: "draft" as const,
        revision: 4,
        updatedAt: "2026-07-15T12:00:00.000Z",
      })),
      transitionPublicationProfile: vi.fn(),
      transitionWebhookEndpoint: vi.fn(async () => ({
        id: "webhook-1",
        label: "Case events",
        status: "active",
        version: "5",
        fields: {},
      })),
    };
    const completed = vi.fn(async () => undefined);
    render(
      <PublicationWebhookLifecycleControl
        client={client as never}
        onCompleted={completed}
        resource="webhook-endpoints"
        resourceId="webhook-1"
        status="draft"
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Activate" }));
    await screen.findByText("Activate webhook endpoint");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Activate",
      }),
    );

    await waitFor(() =>
      expect(client.transitionWebhookEndpoint).toHaveBeenCalledWith(
        "webhook-1",
        { expectedRevision: 4, lifecycle: "active" },
      ),
    );
    expect(client.configurationInspection).toHaveBeenCalledWith("webhook-1");
    expect(
      JSON.stringify(client.transitionWebhookEndpoint.mock.calls),
    ).not.toMatch(/settings|secret|reference|body|header|token/iu);
    expect(completed).toHaveBeenCalledOnce();
  });
});
