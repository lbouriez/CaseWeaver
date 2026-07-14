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
});
