import type {
  TranslatedWebhookEvent,
  VerifiedWebhook,
} from "@caseweaver/connector-sdk";
import {
  FixedWebhookClock,
  MemoryVerifiedWebhookEventStore,
  RecordingWebhookAdapter,
  type WebhookEndpoint,
  WebhookIngress,
} from "@caseweaver/webhooks";
import { describe, expect, it, vi } from "vitest";

import { buildWebhookApp, type WebhookEndpointResolver } from "./app.js";
import { PersistedWebhookEndpointResolver } from "./persisted-endpoint-resolver.js";

const verified: VerifiedWebhook = {
  eventType: "case.updated",
  eventId: "event-1",
  payload: {},
};

const signals: readonly TranslatedWebhookEvent[] = [
  {
    kind: "caseChanged",
    reference: {
      connectorInstanceId: "connector-1",
      resourceType: "case",
      externalId: "44",
    },
  },
];

function createIngress(
  store = new MemoryVerifiedWebhookEventStore(),
): WebhookIngress {
  return new WebhookIngress({
    clock: new FixedWebhookClock("2026-07-14T16:00:00.000Z"),
    store,
  });
}

function createEndpoint(): WebhookEndpoint {
  return {
    id: "opaque_endpoint-1",
    workspaceId: "workspace-1",
    connectorInstanceId: "connector-1",
    adapter: new RecordingWebhookAdapter(verified, signals),
  };
}

function resolverFor(
  endpoint: WebhookEndpoint | undefined,
): WebhookEndpointResolver {
  return {
    resolve: vi.fn(async () => endpoint),
  };
}

describe("buildWebhookApp", () => {
  it("passes exact raw bytes to the server-selected endpoint and returns promptly", async () => {
    const endpoint = createEndpoint();
    const resolver = resolverFor(endpoint);
    const app = buildWebhookApp({
      ingress: createIngress(),
      endpointResolver: resolver,
      maximumBodyBytes: 1_024,
    });
    const body = '{ "ticket": 44 }';

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/opaque_endpoint-1",
      headers: { "content-type": "application/json", "x-signature": "valid" },
      payload: body,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted" });
    expect(resolver.resolve).toHaveBeenCalledExactlyOnceWith(
      "opaque_endpoint-1",
    );
    const adapter = endpoint.adapter as RecordingWebhookAdapter;
    expect(
      Buffer.from(adapter.verificationRequests[0]?.body ?? []).toString("utf8"),
    ).toBe(body);
    expect(adapter.verificationRequests[0]?.headers["x-signature"]).toEqual([
      "valid",
    ]);
    await app.close();
  });

  it("does not invoke an adapter when the opaque endpoint is unknown", async () => {
    const resolver = resolverFor(undefined);
    const app = buildWebhookApp({
      ingress: createIngress(),
      endpointResolver: resolver,
      maximumBodyBytes: 1_024,
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/unknown",
      payload: "{}",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ status: "not_found" });
    await app.close();
  });

  it("rejects failed verification without persisting a verified event", async () => {
    const store = new MemoryVerifiedWebhookEventStore();
    const endpoint: WebhookEndpoint = {
      ...createEndpoint(),
      adapter: {
        verify: async () => {
          throw new Error("bad signature");
        },
        translate: async () => signals,
      },
    };
    const app = buildWebhookApp({
      ingress: createIngress(store),
      endpointResolver: resolverFor(endpoint),
      maximumBodyBytes: 1_024,
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/opaque_endpoint-1",
      payload: "{}",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ status: "unauthorized" });
    expect(store.events).toEqual([]);
    await app.close();
  });

  it("enforces the configured raw-body limit before verification", async () => {
    const endpoint = createEndpoint();
    const app = buildWebhookApp({
      ingress: createIngress(),
      endpointResolver: resolverFor(endpoint),
      maximumBodyBytes: 4,
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/opaque_endpoint-1",
      payload: "12345",
    });

    expect(response.statusCode).toBe(413);
    const adapter = endpoint.adapter as RecordingWebhookAdapter;
    expect(adapter.verificationRequests).toEqual([]);
    await app.close();
  });

  it("enforces the endpoint-specific body limit and database admission before an adapter", async () => {
    const endpoint = createEndpoint();
    const resolver: WebhookEndpointResolver = {
      resolve: async () => ({
        endpoint,
        maximumBodyBytes: 4,
        admit: async () => ({ allowed: false }),
      }),
    };
    const app = buildWebhookApp({
      ingress: createIngress(),
      endpointResolver: resolver,
      maximumBodyBytes: 1_024,
    });

    const tooLarge = await app.inject({
      method: "POST",
      url: "/webhooks/opaque_endpoint-1",
      payload: "12345",
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toEqual({ status: "payload_too_large" });

    const rateLimited = await app.inject({
      method: "POST",
      url: "/webhooks/opaque_endpoint-1",
      payload: "1234",
    });
    expect(rateLimited.statusCode).toBe(429);
    expect(rateLimited.json()).toEqual({ status: "rate_limited" });
    const adapter = endpoint.adapter as RecordingWebhookAdapter;
    expect(adapter.verificationRequests).toEqual([]);
    await app.close();
  });

  it("builds a public endpoint only from active persisted routing state", async () => {
    const adapter = new RecordingWebhookAdapter(verified, signals);
    const findActive = vi.fn(async () => ({
      endpointId: "opaque_endpoint-1",
      workspaceId: "workspace-1",
      lifecycle: "active" as const,
      connectorRegistrationId: "connector-1",
      configurationVersionId: "version-1",
      verifiedEventTypes: ["case.updated"],
      maximumBodyBytes: 512,
      maximumRequestsPerMinute: 4,
      analysisTriggerId: "trigger-1",
    }));
    const acquire = vi.fn(async () => ({ allowed: true }));
    const resolveAdapter = vi.fn(async () => adapter);
    const resolver = new PersistedWebhookEndpointResolver(
      { findActive },
      { acquire },
      { resolve: resolveAdapter },
    );

    const resolved = await resolver.resolve("opaque_endpoint-1");
    expect(resolved?.endpoint).toMatchObject({
      id: "opaque_endpoint-1",
      workspaceId: "workspace-1",
      connectorInstanceId: "connector-1",
      analysisTriggerId: "trigger-1",
    });
    expect(resolveAdapter).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      connectorRegistrationId: "connector-1",
      configurationVersionId: "version-1",
      verifiedEventTypes: ["case.updated"],
    });
    await resolved?.admit?.();
    expect(acquire).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      endpointId: "opaque_endpoint-1",
    });
  });
});
