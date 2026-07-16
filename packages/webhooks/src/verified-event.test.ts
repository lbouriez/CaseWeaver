import { createHash } from "node:crypto";

import type {
  TranslatedWebhookEvent,
  VerifiedWebhook,
  WebhookAdapter,
} from "@caseweaver/connector-sdk";
import { describe, expect, it, vi } from "vitest";

import { WebhookTranslationError, WebhookVerificationError } from "./errors.js";
import {
  FixedWebhookClock,
  MemoryVerifiedWebhookEventStore,
  RecordingWebhookAdapter,
} from "./fakes.js";
import type { RawWebhookDelivery, WebhookEndpoint } from "./types.js";
import { WebhookIngress } from "./verified-event.js";

const verified: VerifiedWebhook = {
  eventType: "case.updated",
  eventId: "delivery-44",
  occurredAt: "2026-07-14T16:00:00.000Z",
  payload: { untrustedUntilVerified: true },
};

const signals: readonly TranslatedWebhookEvent[] = [
  {
    kind: "caseChanged",
    reference: {
      connectorInstanceId: "support-1",
      resourceType: "case",
      externalId: "44",
    },
  },
];

function delivery(
  body = new Uint8Array([123, 34, 97, 34, 58, 49, 125]),
): RawWebhookDelivery {
  return {
    method: "POST",
    headers: { "x-signature": ["signature"] },
    body,
    signal: new AbortController().signal,
  };
}

function endpoint(adapter: WebhookAdapter): WebhookEndpoint {
  return {
    id: "opaque-endpoint",
    workspaceId: "workspace-1",
    connectorInstanceId: "support-1",
    endpointConfigurationVersionId: "endpoint-version-1",
    connectorConfigurationVersionId: "connector-version-1",
    adapter,
  };
}

function createIngress(
  store = new MemoryVerifiedWebhookEventStore(),
): WebhookIngress {
  return new WebhookIngress({
    store,
    clock: new FixedWebhookClock("2026-07-14T16:01:00.000Z"),
  });
}

describe("WebhookIngress", () => {
  it("verifies exact raw bytes before translating a server-resolved endpoint", async () => {
    const adapter = new RecordingWebhookAdapter(verified, signals);
    const store = new MemoryVerifiedWebhookEventStore();
    const rawBody = new Uint8Array([123, 32, 34, 97, 34, 58, 49, 125]);

    const result = await createIngress(store).accept(
      { ...endpoint(adapter), automatedPrincipalId: "principal-1" },
      delivery(rawBody),
    );

    expect(adapter.verificationRequests).toHaveLength(1);
    expect(adapter.verificationRequests[0]).toMatchObject({
      endpointId: "opaque-endpoint",
      body: rawBody,
    });
    expect(adapter.verificationRequests[0]?.body).toBe(rawBody);
    expect(adapter.translatedEvents).toEqual([verified]);
    expect(result).toMatchObject({
      status: "accepted",
      event: {
        workspaceId: "workspace-1",
        connectorInstanceId: "support-1",
        endpointConfigurationVersionId: "endpoint-version-1",
        connectorConfigurationVersionId: "connector-version-1",
        automatedPrincipalId: "principal-1",
        verification: { eventType: "case.updated", eventId: "delivery-44" },
        signals,
      },
    });
    expect(result.event.rawBodyDigest).toBe(
      createHash("sha256").update(rawBody).digest("hex"),
    );
    expect(store.events).toHaveLength(1);
    expect(store.outboxEvents).toHaveLength(1);
  });

  it("does not translate or persist a failed verification", async () => {
    const adapter: WebhookAdapter = {
      verify: vi.fn(async () => {
        throw new Error("invalid signature");
      }),
      translate: vi.fn(),
    };
    const store = new MemoryVerifiedWebhookEventStore();

    await expect(
      createIngress(store).accept(endpoint(adapter), delivery()),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
    expect(adapter.translate).not.toHaveBeenCalled();
    expect(store.events).toEqual([]);
    expect(store.outboxEvents).toEqual([]);
  });

  it("deduplicates a verified delivery without a second outbox handoff", async () => {
    const adapter = new RecordingWebhookAdapter(verified, signals);
    const store = new MemoryVerifiedWebhookEventStore();
    const ingress = createIngress(store);

    await expect(
      ingress.accept(endpoint(adapter), delivery()),
    ).resolves.toMatchObject({
      status: "accepted",
    });
    await expect(
      ingress.accept(endpoint(adapter), delivery()),
    ).resolves.toMatchObject({
      status: "duplicate",
    });

    expect(store.events).toHaveLength(1);
    expect(store.outboxEvents).toHaveLength(1);
  });

  it("uses the raw-body digest when a verified event has no delivery ID", async () => {
    const adapter = new RecordingWebhookAdapter(
      { eventType: "case.updated", payload: {} },
      signals,
    );
    const store = new MemoryVerifiedWebhookEventStore();
    const ingress = createIngress(store);

    const first = await ingress.accept(endpoint(adapter), delivery());
    const second = await ingress.accept(
      endpoint(adapter),
      delivery(new Uint8Array([123, 34, 97, 34, 58, 50, 125])),
    );

    expect(first.event.deliveryKey).not.toBe(second.event.deliveryKey);
    expect(store.outboxEvents).toHaveLength(2);
  });

  it("rejects translated signals that try to cross the resolved connector boundary", async () => {
    const adapter = new RecordingWebhookAdapter(verified, [
      {
        kind: "caseChanged",
        reference: {
          connectorInstanceId: "untrusted-connector",
          resourceType: "case",
          externalId: "44",
        },
      },
    ]);
    const store = new MemoryVerifiedWebhookEventStore();

    await expect(
      createIngress(store).accept(endpoint(adapter), delivery()),
    ).rejects.toBeInstanceOf(WebhookTranslationError);
    expect(store.events).toEqual([]);
  });
});
