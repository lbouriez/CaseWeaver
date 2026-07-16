import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  connectorCapabilities: ["knowledgeSource"],
  aiCapabilities: [],
  supportedWireApis: [],
  supportedWebhookEventTypes: [],
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
  supportsConfigurationMigration: false,
  supportedTestOperations: ["connector.test"],
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

  it("selects opaque server registrations and never submits secret values", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    render(
      <DescriptorForm
        descriptor={descriptor}
        onSubmit={onSubmit}
        secretReferences={[
          {
            id: "credential-1",
            label: "Secret reference credential-1",
            status: "active",
          },
        ]}
        submitLabel="Save draft"
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "API credential" }),
    ).not.toBeNull();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    await user.type(screen.getByRole("textbox"), "https://bridge.example.test");
    await user.click(screen.getByRole("combobox", { name: "API credential" }));
    await user.click(
      screen.getByRole("option", { name: "Secret reference credential-1" }),
    );
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    expect(onSubmit).toHaveBeenCalledWith({
      endpoint: "https://bridge.example.test",
      apiToken: "credential-1",
    });
  });

  it("accepts generic structured settings without a connector-specific form branch", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    render(
      <DescriptorForm
        descriptor={{
          ...descriptor,
          secretSlots: [],
          settingsSchema: {
            type: "object",
            properties: {
              settings: {
                type: "object",
                title: "Structured settings",
                format: "json",
              },
            },
            required: ["settings"],
          },
          uiGroups: [],
        }}
        onSubmit={onSubmit}
        submitLabel="Save draft"
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: '{"safe":true}' },
    });
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    expect(onSubmit).toHaveBeenCalledWith({ settings: { safe: true } });
  });

  it("uses descriptor help examples without a connector-specific branch", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    render(
      <DescriptorForm
        descriptor={{
          ...descriptor,
          secretSlots: [],
          settingsSchema: {
            type: "object",
            properties: {
              endpoint: {
                type: "string",
                title: "Endpoint",
                description: "The server validates this endpoint.",
                examples: ["https://bridge.example.test"],
              },
            },
            required: ["endpoint"],
          },
          uiGroups: [],
        }}
        onSubmit={onSubmit}
        submitLabel="Save draft"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Help for Endpoint" }));
    expect(screen.getByText("Examples")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Use example 1" }));
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    expect(onSubmit).toHaveBeenCalledWith({
      endpoint: "https://bridge.example.test",
    });
  });

  it("renders descriptor-selected repository and reference inputs with advanced JSON fallbacks", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    render(
      <DescriptorForm
        descriptor={{
          ...descriptor,
          secretSlots: [],
          settingsSchema: {
            type: "object",
            properties: {
              repository: {
                type: "object",
                title: "Repository",
                inputKind: "structured_repository",
              },
              ref: {
                type: "object",
                title: "Reference",
                inputKind: "git_reference",
              },
            },
            required: ["repository", "ref"],
          },
          uiGroups: [],
        }}
        onSubmit={onSubmit}
        submitLabel="Save draft"
      />,
    );

    await user.click(
      screen.getByRole("combobox", { name: "Repository location" }),
    );
    await user.click(
      screen.getByRole("option", { name: "Remote HTTPS repository" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Repository HTTPS URL" }),
      "https://repository.example.test/project.git",
    );
    await user.click(screen.getByRole("combobox", { name: "Reference type" }));
    await user.click(screen.getByRole("option", { name: "Branch" }));
    await user.type(
      screen.getByRole("textbox", { name: "Reference name" }),
      "main",
    );
    expect(screen.getAllByText("Advanced JSON fallback")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    expect(onSubmit).toHaveBeenCalledWith({
      repository: {
        kind: "remote",
        url: "https://repository.example.test/project.git",
      },
      ref: { kind: "branch", name: "main" },
    });
  });

  it("applies descriptor-provided structured examples as structured settings", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    render(
      <DescriptorForm
        descriptor={{
          ...descriptor,
          secretSlots: [],
          settingsSchema: {
            type: "object",
            properties: {
              repository: {
                type: "object",
                title: "Repository",
                inputKind: "structured_repository",
                examples: [
                  '{"kind":"remote","url":"https://repository.example.test/project.git"}',
                ],
              },
            },
            required: ["repository"],
          },
          uiGroups: [],
        }}
        onSubmit={onSubmit}
        submitLabel="Save draft"
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Help for Repository" }),
    );
    await user.click(screen.getByRole("button", { name: "Use example 1" }));
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    expect(onSubmit).toHaveBeenCalledWith({
      repository: {
        kind: "remote",
        url: "https://repository.example.test/project.git",
      },
    });
  });

  it("uses the advanced JSON fallback for a descriptor-selected structured input", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    render(
      <DescriptorForm
        descriptor={{
          ...descriptor,
          secretSlots: [],
          settingsSchema: {
            type: "object",
            properties: {
              reference: {
                type: "object",
                title: "Reference",
                inputKind: "git_reference",
              },
            },
            required: ["reference"],
          },
          uiGroups: [],
        }}
        onSubmit={onSubmit}
        submitLabel="Save draft"
      />,
    );

    await user.click(screen.getByText("Advanced JSON fallback"));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Reference JSON fallback" }),
      {
        target: { value: '{"kind":"tag","name":"v2.4.0"}' },
      },
    );
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    expect(onSubmit).toHaveBeenCalledWith({
      reference: { kind: "tag", name: "v2.4.0" },
    });
  });

  it("requires a fresh server confirmation before running an unpersisted configuration test", async () => {
    const user = userEvent.setup();
    const onPreviewTest = vi.fn(async () => ({
      descriptorType: "future-bridge",
      descriptorVersion: "v1",
      testOperation: "connector.test",
      canConfirm: true,
      confirmationId: "confirmation-1",
      impact: "The server will perform one bounded connection check.",
      expiresAt: "2026-07-16T12:05:00.000Z",
    }));
    const onRunTest = vi.fn(async () => ({
      id: "test-1",
      descriptorType: "future-bridge",
      descriptorVersion: "v1",
      testOperation: "connector.test",
      outcome: "succeeded" as const,
      completedAt: "2026-07-16T12:01:00.000Z",
      idempotency: "created" as const,
    }));
    render(
      <DescriptorForm
        descriptor={descriptor}
        onPreviewTest={onPreviewTest}
        onRunTest={onRunTest}
        onSubmit={vi.fn()}
        submitLabel="Save draft"
        testOperations={[
          {
            operation: "connector.test",
            requiresConfirmation: true,
            requiresIdempotencyKey: true,
          },
        ]}
      />,
    );

    await user.type(screen.getByRole("textbox"), "https://bridge.example.test");
    await user.click(
      screen.getByRole("button", { name: "Preview configuration test" }),
    );
    await waitFor(() =>
      expect(onPreviewTest).toHaveBeenCalledWith("connector.test", {
        endpoint: "https://bridge.example.test",
      }),
    );
    await screen.findByRole("button", {
      name: "Confirm and run configuration test",
    });
    await user.type(screen.getByRole("textbox"), "/changed");
    expect(
      screen.queryByRole("button", {
        name: "Confirm and run configuration test",
      }),
    ).toBeNull();
    expect(onRunTest).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Preview configuration test" }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Confirm and run configuration test",
      }),
    );
    await waitFor(() =>
      expect(onRunTest).toHaveBeenCalledWith(
        "connector.test",
        { endpoint: "https://bridge.example.test/changed" },
        "confirmation-1",
      ),
    );
    expect(
      await screen.findByText("Configuration test succeeded."),
    ).not.toBeNull();
  });
});
