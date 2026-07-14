import type {
  TranslatedWebhookEvent,
  WebhookAdapter,
} from "@caseweaver/connector-sdk";

/**
 * Trusted configuration selected only by an opaque route identifier. The adapter and
 * workspace must never be selected from delivery headers or body content.
 */
export interface WebhookEndpoint {
  readonly id: string;
  readonly workspaceId: string;
  readonly connectorInstanceId: string;
  readonly adapter: WebhookAdapter;
  /**
   * A server-configured analysis trigger. It is deliberately copied from the
   * opaque-route configuration, never accepted from request content.
   */
  readonly analysisTriggerId?: string;
}

/**
 * The exact bytes and unparsed headers supplied by the HTTP transport.
 */
export interface RawWebhookDelivery {
  readonly method: string;
  readonly headers: Readonly<Record<string, readonly string[]>>;
  readonly body: Uint8Array;
  readonly signal: AbortSignal;
}

export interface WebhookClock {
  now(): string;
}

export interface VerifiedWebhookEvent {
  readonly endpointId: string;
  readonly workspaceId: string;
  readonly connectorInstanceId: string;
  readonly analysisTriggerId?: string;
  /**
   * A deterministic, endpoint-scoped delivery identity. It is based on a connector
   * event ID when one was verified, otherwise on the exact raw request bytes.
   */
  readonly deliveryKey: string;
  readonly rawBodyDigest: string;
  readonly receivedAt: string;
  readonly verification: Readonly<{
    readonly eventType: string;
    readonly eventId?: string;
    readonly occurredAt?: string;
  }>;
  /**
   * Connector-neutral, verified signals that an infrastructure store turns into its
   * inbox and command outbox transaction.
   */
  readonly signals: readonly TranslatedWebhookEvent[];
}

export type VerifiedWebhookStoreResult =
  | "accepted"
  | "duplicate"
  | "idempotencyConflict";

/**
 * A single call is one durable transaction: it records the verified inbox entry and
 * creates all outbox commands derived from its signals. A duplicate must not create
 * more outbox commands.
 */
export interface VerifiedWebhookEventStore {
  persist(event: VerifiedWebhookEvent): Promise<VerifiedWebhookStoreResult>;
}

export interface WebhookIngressDependencies {
  readonly store: VerifiedWebhookEventStore;
  readonly clock: WebhookClock;
}

export interface WebhookAcceptance {
  readonly status: VerifiedWebhookStoreResult;
  readonly event: VerifiedWebhookEvent;
}
