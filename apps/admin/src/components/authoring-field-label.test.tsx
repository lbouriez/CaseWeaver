import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { AuthoringFieldLabel } from "./authoring-field-label.js";

describe("AuthoringFieldLabel", () => {
  it("keeps the field name visible while exposing safe explanatory metadata through the reusable tooltip", async () => {
    const user = userEvent.setup();
    render(
      <AuthoringFieldLabel
        description="The API owns the final policy validation."
        examples={["UTC"]}
        label="Schedule timezone"
      />,
    );

    expect(screen.getByText("Schedule timezone")).not.toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Help for Schedule timezone" }),
    );
    expect(
      screen.getByText("The API owns the final policy validation."),
    ).not.toBeNull();
    expect(screen.getByText("UTC")).not.toBeNull();
  });
});
