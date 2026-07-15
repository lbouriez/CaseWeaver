import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SourceScheduleLifecycleControl } from "./source-schedule-lifecycle-control.js";

describe("source and schedule lifecycle control", () => {
  it("loads a server-owned revision and submits only the optimistic lifecycle transition", async () => {
    const client = {
      configurationInspection: vi.fn(async () => ({
        id: "source-1",
        resourceType: "knowledge-sources",
        lifecycle: "draft" as const,
        revision: 4,
        updatedAt: "2026-07-15T12:00:00.000Z",
      })),
      transitionKnowledgeSource: vi.fn(async () => ({
        id: "source-1",
        label: "Support knowledge",
        status: "enabled",
        version: "5",
        fields: {},
      })),
      transitionKnowledgeSchedule: vi.fn(),
    };
    const completed = vi.fn(async () => undefined);
    render(
      <SourceScheduleLifecycleControl
        client={client as never}
        onCompleted={completed}
        resource="knowledge-sources"
        resourceId="source-1"
        status="disabled"
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Activate" }));
    await screen.findByText("Activate source");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Activate",
      }),
    );

    await waitFor(() =>
      expect(client.transitionKnowledgeSource).toHaveBeenCalledWith(
        "source-1",
        {
          expectedRevision: 4,
          lifecycle: "active",
        },
      ),
    );
    expect(client.configurationInspection).toHaveBeenCalledWith("source-1");
    expect(completed).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(client.transitionKnowledgeSource.mock.calls),
    ).not.toMatch(/connector|collection|settings|secret|token/iu);
  });
});
