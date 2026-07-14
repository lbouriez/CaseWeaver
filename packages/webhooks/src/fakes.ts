import type {
  RawWebhookRequest,
  TranslatedWebhookEvent,
  VerifiedWebhook,
  WebhookAdapter,
} from "@caseweaver/connector-sdk";

import type {
  VerifiedWebhookEvent,
  VerifiedWebhookEventStore,
  VerifiedWebhookStoreResult,
  WebhookClock,
} from "./types.js";

export class FixedWebhookClock implements WebhookClock {
  public constructor(private readonly instant: string) {}

  public now(): string {
    return this.instant;
  }
}

export class RecordingWebhookAdapter implements WebhookAdapter {
  public readonly verificationRequests: RawWebhookRequest[] = [];
  public readonly translatedEvents: VerifiedWebhook[] = [];

  public constructor(
    private readonly verified: VerifiedWebhook,
    private readonly signals: readonly TranslatedWebhookEvent[],
  ) {}

  public async verify(request: RawWebhookRequest): Promise<VerifiedWebhook> {
    this.verificationRequests.push(request);
    return this.verified;
  }

  public async translate(
    verified: VerifiedWebhook,
    _signal: AbortSignal,
  ): Promise<readonly TranslatedWebhookEvent[]> {
    this.translatedEvents.push(verified);
    return this.signals;
  }
}

/**
 * A deterministic fake of the atomic inbox/outbox boundary. `outboxEvents` changes
 * only for an accepted delivery, mirroring the production transaction contract.
 */
export class MemoryVerifiedWebhookEventStore
  implements VerifiedWebhookEventStore
{
  public readonly events: VerifiedWebhookEvent[] = [];
  public readonly outboxEvents: VerifiedWebhookEvent[] = [];
  private readonly byDeliveryKey = new Map<string, VerifiedWebhookEvent>();

  public async persist(
    event: VerifiedWebhookEvent,
  ): Promise<VerifiedWebhookStoreResult> {
    const existing = this.byDeliveryKey.get(event.deliveryKey);
    if (existing !== undefined) {
      return existing.rawBodyDigest === event.rawBodyDigest
        ? "duplicate"
        : "idempotencyConflict";
    }

    this.byDeliveryKey.set(event.deliveryKey, event);
    this.events.push(event);
    this.outboxEvents.push(event);
    return "accepted";
  }
}
