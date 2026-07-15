import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  PrivacyPurgeDialog,
  type PrivacyPurgeClient,
} from "./privacy-purge-dialog.js";

describe("PrivacyPurgeDialog", () => {
  it("sends the reason only to the dedicated preview request then clears browser state", async () => {
    const user = userEvent.setup();
    const reason = "Verified data-subject deletion request";
    const previewPrivacyPurge = vi.fn<
      PrivacyPurgeClient["previewPrivacyPurge"]
    >(async () => ({
      previewId: "preview-1",
      action: "privacy.purge",
      confirmation: "Purge this case snapshot for privacy?",
      impact: "The existing privacy workflow will tombstone governed content.",
      canConfirm: true,
      expiresAt: "2026-07-16T12:00:00.000Z",
    }));
    const client: PrivacyPurgeClient = {
      previewPrivacyPurge,
      executeAction: vi.fn<PrivacyPurgeClient["executeAction"]>(async () => ({
        operationId: "snapshot-1",
        outcome: "accepted",
        message: "Accepted",
      })),
    };
    render(<PrivacyPurgeDialog client={client} snapshotId="snapshot-1" />);

    await user.click(
      screen.getByRole("button", { name: "Request privacy purge" }),
    );
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), reason);
    await user.click(
      screen.getByRole("button", { name: "Request server preview" }),
    );

    await waitFor(() =>
      expect(previewPrivacyPurge).toHaveBeenCalledWith("snapshot-1", reason),
    );
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(screen.queryByText(reason)).toBeNull();
    expect(
      screen.getByText(
        "The existing privacy workflow will tombstone governed content.",
      ),
    ).not.toBeNull();
  });
});
