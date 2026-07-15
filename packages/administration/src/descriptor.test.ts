import { describe, expect, it } from "vitest";
import {
  canonicalizeDescriptor,
  InMemoryDescriptorRegistry,
  parseConfigurationDescriptor,
} from "./descriptor.js";

const connector = {
  kind: "connector",
  type: "synthetic-source",
  version: "1",
  displayName: "Synthetic source",
  description: "Contract fixture",
  connectorCapabilities: ["knowledgeSource"],
  aiCapabilities: [],
  supportedWireApis: [],
  supportedWebhookEventTypes: [],
  settingsSchema: {
    type: "object",
    properties: { endpoint: { type: "string", format: "uri" } },
  },
  uiGroups: [],
  secretSlots: [
    {
      name: "token",
      label: "Token",
      required: true,
      acceptedReferenceKinds: ["vault"],
      supportsRotation: true,
    },
  ],
  supportsConfigurationMigration: false,
  supportedTestOperations: ["connectivity"],
};

describe("configuration descriptors", () => {
  it("accepts safe provider-neutral metadata and preserves secret slots as metadata", () => {
    const descriptor = parseConfigurationDescriptor(connector);
    expect(descriptor.secretSlots).toEqual([
      expect.objectContaining({ name: "token" }),
    ]);
    expect(JSON.stringify(descriptor)).not.toContain("super-secret");
  });

  it("rejects a connector that declares provider capabilities", () => {
    expect(() =>
      parseConfigurationDescriptor({
        ...connector,
        aiCapabilities: ["analysis"],
      }),
    ).toThrow();
  });

  it("does not permit a descriptor version to be overwritten with different content", () => {
    const registry = new InMemoryDescriptorRegistry();
    registry.register(connector);
    expect(() =>
      registry.register({ ...connector, displayName: "Changed" }),
    ).toThrow(/cannot be registered/u);
  });

  it("canonicalizes descriptor content independently of object key order", () => {
    expect(canonicalizeDescriptor(connector)).toBe(
      canonicalizeDescriptor({
        ...connector,
        settingsSchema: {
          properties: { endpoint: { format: "uri", type: "string" } },
          type: "object",
        },
      }),
    );
  });
});
