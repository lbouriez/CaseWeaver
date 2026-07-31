import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SecretReferenceDependenciesDialog } from "./secret-reference-dependencies-dialog.js";

describe("SecretReferenceDependenciesDialog", () => {
  it("shows only safe active configuration identities from the dedicated dependency read", async () => {
    const client = {
      secretReferenceDependencies: vi.fn(async () => ({
        items: [
          {
            configurationId: "provider-configuration-1",
            resourceType: "ai-provider-instances",
          },
        ],
      })),
    };
    render(
      <SecretReferenceDependenciesDialog
        client={client}
        secretReferenceId="secret-reference-1"
      />,
    );

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Inspect dependencies" }));

    expect(await screen.findByText("provider-configuration-1")).not.toBeNull();
    expect(client.secretReferenceDependencies).toHaveBeenCalledWith(
      "secret-reference-1",
    );
    expect(document.body.textContent).not.toMatch(/env:|vault:|token/iu);
  });
});
