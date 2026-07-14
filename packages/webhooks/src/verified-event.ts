import { createHash } from "node:crypto";

import type {
  RawWebhookRequest,
  TranslatedWebhookEvent,
  VerifiedWebhook,
} from "@caseweaver/connector-sdk";

import { WebhookTranslationError, WebhookVerificationError } from "./errors.js";
import type {
  RawWebhookDelivery,
  VerifiedWebhookEvent,
  WebhookAcceptance,
  WebhookEndpoint,
  WebhookIngressDependencies,
} from "./types.js";

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Webhook processing was aborted.");
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deliveryKey(
  endpointId: string,
  eventType: string,
  eventId: string | undefined,
  rawBodyDigest: string,
): string {
  const identity =
    eventId === undefined
      ? `raw-body:${rawBodyDigest}`
      : `verified-event:${eventId}`;
  return sha256(
    ["caseweaver.webhook-delivery.v1", endpointId, eventType, identity].join(
      "\u0000",
    ),
  );
}

function createVerifiedEvent(
  endpoint: WebhookEndpoint,
  delivery: RawWebhookDelivery,
  verified: VerifiedWebhook,
  signals: readonly TranslatedWebhookEvent[],
  receivedAt: string,
): VerifiedWebhookEvent {
  const rawBodyDigest = sha256(delivery.body);
  return Object.freeze({
    endpointId: endpoint.id,
    workspaceId: endpoint.workspaceId,
    connectorInstanceId: endpoint.connectorInstanceId,
    ...(endpoint.analysisTriggerId === undefined
      ? {}
      : { analysisTriggerId: endpoint.analysisTriggerId }),
    deliveryKey: deliveryKey(
      endpoint.id,
      verified.eventType,
      verified.eventId,
      rawBodyDigest,
    ),
    rawBodyDigest,
    receivedAt,
    verification: Object.freeze({
      eventType: verified.eventType,
      ...(verified.eventId === undefined ? {} : { eventId: verified.eventId }),
      ...(verified.occurredAt === undefined
        ? {}
        : { occurredAt: verified.occurredAt }),
    }),
    signals: Object.freeze([...signals]),
  });
}

function signalsBelongToEndpoint(
  endpoint: WebhookEndpoint,
  signals: readonly TranslatedWebhookEvent[],
): boolean {
  return signals.every(
    (signal) =>
      signal.reference.connectorInstanceId === endpoint.connectorInstanceId,
  );
}

/**
 * The sole point where a raw delivery becomes a trusted, connector-neutral event.
 * Verification deliberately precedes translation and durable persistence.
 */
export class WebhookIngress {
  public constructor(
    private readonly dependencies: WebhookIngressDependencies,
  ) {}

  public async accept(
    endpoint: WebhookEndpoint,
    delivery: RawWebhookDelivery,
  ): Promise<WebhookAcceptance> {
    throwIfAborted(delivery.signal);
    const rawRequest: RawWebhookRequest = {
      endpointId: endpoint.id,
      method: delivery.method,
      headers: delivery.headers,
      body: delivery.body,
      signal: delivery.signal,
    };

    let verified: VerifiedWebhook;
    try {
      verified = await endpoint.adapter.verify(rawRequest);
    } catch {
      throw new WebhookVerificationError();
    }

    throwIfAborted(delivery.signal);
    let signals: readonly TranslatedWebhookEvent[];
    try {
      signals = await endpoint.adapter.translate(verified, delivery.signal);
    } catch {
      throw new WebhookTranslationError();
    }
    if (!signalsBelongToEndpoint(endpoint, signals)) {
      throw new WebhookTranslationError();
    }

    throwIfAborted(delivery.signal);
    const event = createVerifiedEvent(
      endpoint,
      delivery,
      verified,
      signals,
      this.dependencies.clock.now(),
    );
    const status = await this.dependencies.store.persist(event);
    return Object.freeze({ status, event });
  }
}
