import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ConfigurationDescriptor } from "../api/contracts.js";
import { DescriptorForm } from "./descriptor-form.js";

const descriptor: ConfigurationDescriptor = {
  kind: "connector",
  type: "future-bridge",
  version: "v1",
  displayName: "Future Bridge",
  description: "A synthetic descriptor.",
  settingsSchema: {
    type: "object",
    properties: {
      endpoint: { type: "string", title: "Endpoint" },
      modes: { type: "array", title: "Modes" },
      apiToken: { type: "string", title: "API token" },
    },
    required: ["endpoint"],
  },
  uiGroups: [
    {
      id: "advanced",
      title: "Control surface",
      fields: ["modes"],
      advanced: true,
    },
  ],
  secretSlots: [
    {
      name: "apiToken",
      label: "API credential",
      required: true,
      acceptedReferenceKinds: ["secret-reference"],
      supportsRotation: true,
    },
  ],
};

describe("DescriptorForm", () => {
  it("renders primitives and advanced groups without provider-specific branches", async () => {
    const user = userEvent.setup();
    render(
      <DescriptorForm
        descriptor={descriptor}
        onSubmit={vi.fn()}
        submitLabel="Save draft"
      />,
    );

    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.getByText("Control surface · advanced")).not.toBeNull();
    await user.click(screen.getByText("Control surface · advanced"));
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
  });

  it("redacts secret slots and never submits secret values", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    render(
      <DescriptorForm
        descriptor={descriptor}
        onSubmit={onSubmit}
        submitLabel="Save draft"
      />,
    );

    expect(screen.getByTestId("secret-slot-apiToken").textContent).toContain(
      "Secret values are never requested or shown",
    );
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    await user.type(screen.getByRole("textbox"), "https://bridge.example.test");
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    expect(onSubmit).toHaveBeenCalledWith({
      endpoint: "https://bridge.example.test",
    });
  });
});
