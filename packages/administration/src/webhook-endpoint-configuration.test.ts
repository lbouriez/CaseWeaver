import { describe, expect, it, vi } from "vitest";

import type { ConfigurationLifecycleStore } from "./configuration-lifecycle.js";
import type { WebhookEndpointConfigurationProjectionStore } from "./webhook-endpoint-configuration.js";
import { ManageWebhookEndpointConfiguration } from "./webhook-endpoint-configuration.js";

const endpoint = {
  endpointId: "opaque_endpoint-1",
  connectorRegistrationId: "connector-a",
  verifiedEventTypes: ["caseChanged"],
  maximumBodyBytes: 131_072,
  maximumRequestsPerMinute: 120,
  analysisTriggerId: "trigger-a",
};

function store(): WebhookEndpointConfigurationProjectionStore {
  const lifecycle: ConfigurationLifecycleStore = {
    createDraft: vi.fn(async (input) => ({
      configuration: {
        id: input.configurationId,
        workspaceId: input.workspaceId,
        resourceType: input.resourceType,
        revision: 1,
        lifecycle: "draft" as const,
        currentVersionId: "webhook-version-1",
      },
      version: {
        id: "webhook-version-1",
        workspaceId: input.workspaceId,
        configurationId: input.configurationId,
        version: 1,
        canonicalSettings: input.canonicalSettings,
        secretReferenceIds: input.secretReferenceIds,
      },
    })),
    findMutation: vi.fn(async () => undefined),
    loadVersion: vi.fn(async () => undefined),
    transition: vi.fn(async (input) => ({
      configuration: {
        id: input.configurationId,
        workspaceId: input.workspaceId,
        resourceType: input.resourceType,
        revision: input.expectedRevision + 1,
        lifecycle: input.lifecycle ?? "active",
        currentVersionId: "webhook-version-2",
      },
      version: {
        id: "webhook-version-2",
        workspaceId: input.workspaceId,
        configurationId: input.configurationId,
        version: input.expectedRevision + 1,
        canonicalSettings: input.canonicalSettings,
        secretReferenceIds: input.secretReferenceIds,
      },
    })),
    recordMutation: vi.fn(async () => undefined),
  };
  return {
    ...lifecycle,
    writeWebhookEndpoint: vi.fn(async () => undefined),
  };
}

const transactions = {
  transaction: async <T>(operation: () => Promise<T>): Promise<T> =>
    operation(),
};

describe("webhook endpoint administration configuration", () => {
  it("persists only a draft configuration until the endpoint is activated", async () => {
    const persistence = store();
    await new ManageWebhookEndpointConfiguration(transactions, persistence, {
      append: async () => undefined,
    }).create({
      workspaceId: "workspace-a",
      displayName: "Case updates",
      projection: endpoint,
      settings: { eventFilter: "case-updated" },
      secretReferenceLocators: [
        "vault://opaque-secret",
        "vault://opaque-secret",
      ],
      mutation: {
        operation: "webhookEndpoint.create",
        keyDigest: "key-a",
        requestDigest: "request-a",
      },
    });

    expect(persistence.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: "webhook-endpoints",
        secretReferenceIds: ["vault://opaque-secret"],
      }),
    );
    expect(persistence.writeWebhookEndpoint).not.toHaveBeenCalled();
  });

  it("projects the opaque endpoint on a new lifecycle transition but not a replay", async () => {
    const persistence = store();
    const manager = new ManageWebhookEndpointConfiguration(
      transactions,
      persistence,
      {
        append: vi.fn(async () => undefined),
      },
    );
    await manager.transition({
      workspaceId: "workspace-a",
      projection: endpoint,
      settings: { eventFilter: "case-updated" },
      secretReferenceLocators: ["vault://opaque-secret"],
      expectedRevision: 1,
      lifecycle: "active",
      automatedPrincipalId: "principal-a",
      mutation: {
        operation: "webhookEndpoint.activate",
        keyDigest: "key-b",
        requestDigest: "request-b",
      },
    });
    expect(persistence.writeWebhookEndpoint).toHaveBeenCalledWith({
      workspaceId: "workspace-a",
      configurationVersionId: "webhook-version-2",
      lifecycle: "active",
      endpoint,
      automatedPrincipalId: "principal-a",
    });

    vi.mocked(persistence.findMutation).mockResolvedValue({
      requestDigest: "request-c",
      resourceId: "webhook-version-2",
    });
    vi.mocked(persistence.loadVersion).mockResolvedValue({
      id: "webhook-version-2",
      workspaceId: "workspace-a",
      configurationId: endpoint.endpointId,
      version: 2,
      canonicalSettings: "{}",
      secretReferenceIds: [],
    });
    await manager.transition({
      workspaceId: "workspace-a",
      projection: endpoint,
      settings: { eventFilter: "case-updated" },
      secretReferenceLocators: ["vault://opaque-secret"],
      expectedRevision: 1,
      lifecycle: "active",
      automatedPrincipalId: "principal-a",
      mutation: {
        operation: "webhookEndpoint.activate",
        keyDigest: "key-c",
        requestDigest: "request-c",
      },
    });
    expect(persistence.writeWebhookEndpoint).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid endpoint before mutating durable state", async () => {
    const persistence = store();
    await expect(
      new ManageWebhookEndpointConfiguration(transactions, persistence, {
        append: async () => undefined,
      }).create({
        workspaceId: "workspace-a",
        displayName: "Case updates",
        projection: { ...endpoint, endpointId: "not an endpoint" },
        settings: {},
        secretReferenceLocators: [],
        mutation: {
          operation: "webhookEndpoint.create",
          keyDigest: "key-d",
          requestDigest: "request-d",
        },
      }),
    ).rejects.toThrow(/identifier/u);
    expect(persistence.createDraft).not.toHaveBeenCalled();
  });

  it("fails closed when activating an analysis-trigger endpoint without its server-owned actor", async () => {
    const persistence = store();
    await expect(
      new ManageWebhookEndpointConfiguration(transactions, persistence, {
        append: async () => undefined,
      }).transition({
        workspaceId: "workspace-a",
        projection: endpoint,
        settings: { eventFilter: "case-updated" },
        secretReferenceLocators: ["vault://opaque-secret"],
        expectedRevision: 1,
        lifecycle: "active",
        mutation: {
          operation: "webhookEndpoint.activate",
          keyDigest: "key-missing-actor",
          requestDigest: "request-missing-actor",
        },
      }),
    ).rejects.toThrow(/automated principal/u);
    expect(persistence.transition).not.toHaveBeenCalled();
  });
});
