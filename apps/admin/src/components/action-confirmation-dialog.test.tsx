import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ActionClient } from "./action-confirmation-dialog.js";
import { ActionConfirmationDialog } from "./action-confirmation-dialog.js";

describe("ActionConfirmationDialog", () => {
  it("does not enable confirmation until the server impact preview is returned", async () => {
    const user = userEvent.setup();
    let resolvePreview:
      | ((preview: Awaited<ReturnType<ActionClient["previewAction"]>>) => void)
      | undefined;
    const previewAction = vi.fn<ActionClient["previewAction"]>(
      () =>
        new Promise((resolve) => {
          resolvePreview = resolve;
        }),
    );
    const preview = {
      previewId: "preview-1",
      action: "retention.reap",
      confirmation: "Remove 4 expired records",
      impact: "Four expired retention records will be queued.",
      canConfirm: true,
      estimatedCost: { amount: "0.00", currency: "USD" },
      expiresAt: "2026-07-14T20:00:00.000Z",
    } as const;
    const executeAction = vi.fn<ActionClient["executeAction"]>(async () => ({
      operationId: "operation-1",
      outcome: "accepted",
      message: "Retention operation accepted.",
    }));
    const client: ActionClient = { previewAction, executeAction };
    render(
      <ActionConfirmationDialog
        action="retention.reap"
        client={client}
        label="Queue retention reap"
        target={{ resource: "platform" }}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Queue retention reap" }),
    );
    expect(
      screen
        .getByRole("button", { name: "Confirm operation" })
        .hasAttribute("disabled"),
    ).toBe(true);
    if (resolvePreview === undefined)
      throw new Error("Preview request was not started.");
    resolvePreview(preview);
    await screen.findByText("Four expired retention records will be queued.");
    expect(
      screen
        .getByRole("button", { name: "Confirm operation" })
        .hasAttribute("disabled"),
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "Confirm operation" }));

    await waitFor(() =>
      expect(executeAction).toHaveBeenCalledWith("preview-1"),
    );
  });

  it("shows outcome unknown instead of assuming completion", async () => {
    const user = userEvent.setup();
    const client: ActionClient = {
      previewAction: async () => ({
        previewId: "preview-1",
        action: "retention.reap",
        confirmation: "Confirm",
        impact: "Impact",
        canConfirm: true,
        expiresAt: "2026-07-14T20:00:00.000Z",
      }),
      executeAction: async () => ({
        operationId: "operation-1",
        outcome: "outcome_unknown",
        message: "No response",
      }),
    };
    render(
      <ActionConfirmationDialog
        action="retention.reap"
        client={client}
        label="Queue retention reap"
        target={{ resource: "platform" }}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Queue retention reap" }),
    );
    await screen.findByText("Impact");
    await user.click(screen.getByRole("button", { name: "Confirm operation" }));

    expect(
      await screen.findByText(
        "Outcome unknown. Do not repeat the operation; inspect the durable operation record.",
      ),
    ).not.toBeNull();
  });
});
