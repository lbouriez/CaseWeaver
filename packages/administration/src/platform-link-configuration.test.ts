import { describe, expect, it, vi } from "vitest";

import type { ConfigurationLifecycleStore } from "./configuration-lifecycle.js";
import {
  ManagePlatformLinkConfiguration,
  normalizedPlatformLinks,
  platformLinkConfigurationId,
  webhookEndpointPublicUrl,
} from "./platform-link-configuration.js";

function store(): ConfigurationLifecycleStore {
  return {
    createDraft: vi.fn(async (input) => ({
      configuration: {
        id: input.configurationId,
        workspaceId: input.workspaceId,
        resourceType: input.resourceType,
        revision: 1,
        lifecycle: "draft" as const,
      },
      version: {
        id: "platform-version-1",
        workspaceId: input.workspaceId,
        configurationId: input.configurationId,
        version: 1,
        canonicalSettings: input.canonicalSettings,
        secretReferenceIds: [],
      },
    })),
    findMutation: vi.fn(async () => undefined),
    loadVersion: vi.fn(async () => undefined),
    transition: vi.fn(async () => {
      throw new Error("Not used by this test.");
    }),
    recordMutation: vi.fn(async () => undefined),
  };
}

const settings = {
  apiPublicBaseUrl: "https://api.example.test/v1/",
  webhookPublicBaseUrl: "https://webhooks.example.test/ingress/",
};

const policy = { allowHttpLocalhost: false };

describe("platform link administration configuration", () => {
  it("normalizes configured public bases and builds an opaque webhook URL", () => {
    expect(normalizedPlatformLinks(settings, policy)).toEqual({
      apiPublicBaseUrl: "https://api.example.test/v1",
      webhookPublicBaseUrl: "https://webhooks.example.test/ingress",
    });
    expect(
      webhookEndpointPublicUrl(
        settings.webhookPublicBaseUrl,
        "opaque_endpoint-1",
        policy,
      ),
    ).toBe("https://webhooks.example.test/ingress/webhooks/opaque_endpoint-1");
  });

  it("accepts local HTTP only when deployment policy explicitly permits it", () => {
    expect(() =>
      normalizedPlatformLinks(
        {
          apiPublicBaseUrl: "http://localhost:3000",
          webhookPublicBaseUrl: "http://127.0.0.1:4000",
        },
        policy,
      ),
    ).toThrow(/HTTPS/u);
    expect(
      normalizedPlatformLinks(
        {
          apiPublicBaseUrl: "http://localhost:3000",
          webhookPublicBaseUrl: "http://127.0.0.1:4000",
        },
        { allowHttpLocalhost: true },
      ),
    ).toEqual({
      apiPublicBaseUrl: "http://localhost:3000",
      webhookPublicBaseUrl: "http://127.0.0.1:4000",
    });
  });

  it("derives a workspace aggregate id and persists only server-validated settings", async () => {
    const persistence = store();
    await new ManagePlatformLinkConfiguration(
      { transaction: async <T>(operation: () => Promise<T>) => operation() },
      persistence,
      { append: vi.fn(async () => undefined) },
      policy,
    ).create({
      workspaceId: "workspace-a",
      settings,
      mutation: {
        operation: "platformLinks.create",
        keyDigest: "key-a",
        requestDigest: "request-a",
      },
    });
    expect(platformLinkConfigurationId("workspace-a")).toBe(
      "platform-links:workspace-a",
    );
    expect(persistence.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        configurationId: "platform-links:workspace-a",
        resourceType: "platform-links",
        canonicalSettings: expect.stringContaining("apiPublicBaseUrl"),
      }),
    );
  });
});
