import type { Sha256Digest } from "@caseweaver/domain";

import type {
  ConnectorCursor,
  ExternalRevision,
  ExternalFingerprint,
  ExternalReference,
  OperationContext,
  VersionedOpaqueValue,
} from "./primitives.js";
import type {
  DiscoveredCase,
  DiscoveredKnowledgeItem,
  DiscoveryPage,
  KnowledgeDocument,
  NormalizedCase,
} from "./schemas.js";

export interface KnowledgeDiscoveryRequest extends OperationContext {
  readonly cursor?: ConnectorCursor;
  readonly pageSize?: number;
}

export interface CaseDiscoveryRequest extends OperationContext {
  readonly cursor?: ConnectorCursor;
  readonly pageSize?: number;
}

export interface LoadKnowledgeRequest extends OperationContext {
  readonly reference: ExternalReference;
  /**
   * The immutable revision observed during discovery, when the source exposes one.
   * It is opaque to the core and lets a source verify the loaded result.
   */
  readonly externalRevision?: ExternalRevision;
  /**
   * An opaque source-provided pin for this load. A source must load this exact
   * version rather than resolving a mutable branch, tag, or latest resource.
   */
  readonly loadToken?: VersionedOpaqueValue;
}

export interface LoadCaseRequest extends OperationContext {
  readonly reference: ExternalReference;
}

export interface KnowledgeSource {
  discover(
    request: KnowledgeDiscoveryRequest,
  ): AsyncIterable<DiscoveryPage<DiscoveredKnowledgeItem>>;
  load(request: LoadKnowledgeRequest): Promise<KnowledgeDocument>;
}

export interface CaseSource {
  discoverCases(
    request: CaseDiscoveryRequest,
  ): AsyncIterable<DiscoveryPage<DiscoveredCase>>;
  loadCase(request: LoadCaseRequest): Promise<NormalizedCase>;
}

export interface OpenAttachmentRequest extends OperationContext {
  readonly reference: ExternalReference;
}

export interface OpenedAttachment {
  readonly content: AsyncIterable<Uint8Array>;
  readonly mediaType?: string;
  readonly contentLength?: number;
  readonly contentHash?: string;
}

export interface AttachmentSource {
  openAttachment(request: OpenAttachmentRequest): Promise<OpenedAttachment>;
}

export interface PublicationMarker {
  readonly value: string;
}

export interface RenderedPublication {
  readonly format: "plainText" | "html" | "markdown";
  readonly body: string;
  readonly visibility: "public" | "internal";
}

export interface FindPublicationRequest extends OperationContext {
  readonly marker: PublicationMarker;
}

export interface ExistingPublication {
  readonly marker: PublicationMarker;
  readonly reference: ExternalReference;
  readonly publishedAt?: string;
}

export interface PublishRequest extends OperationContext {
  readonly target: ExternalReference;
  readonly marker: PublicationMarker;
  readonly idempotencyKey: string;
  readonly requestHash: Sha256Digest;
  readonly publication: RenderedPublication;
}

export type PublishResult =
  | Readonly<{
      status: "published";
      receipt: PublicationReceipt;
    }>
  | Readonly<{
      status: "outcome_unknown";
      requestId?: string;
    }>;

export interface PublicationReceipt {
  readonly reference: ExternalReference;
  readonly marker: PublicationMarker;
  readonly requestId?: string;
}

export interface AnalysisDestination {
  findPublication(
    request: FindPublicationRequest,
  ): Promise<ExistingPublication | null>;
  publish(request: PublishRequest): Promise<PublishResult>;
}

export interface RawWebhookRequest extends OperationContext {
  readonly endpointId: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, readonly string[]>>;
  readonly body: Uint8Array;
}

export interface VerifiedWebhook<TPayload = unknown> {
  readonly eventType: string;
  readonly eventId?: string;
  readonly occurredAt?: string;
  readonly payload: TPayload;
}

export type TranslatedWebhookEvent =
  | Readonly<{
      kind: "caseChanged";
      reference: ExternalReference;
      fingerprint?: ExternalFingerprint;
    }>
  | Readonly<{
      kind: "caseDeleted";
      reference: ExternalReference;
    }>
  | Readonly<{
      kind: "knowledgeChanged";
      reference: ExternalReference;
      fingerprint?: ExternalFingerprint;
    }>
  | Readonly<{
      kind: "knowledgeDeleted";
      reference: ExternalReference;
    }>;

export interface WebhookAdapter<TVerified = unknown> {
  verify(request: RawWebhookRequest): Promise<VerifiedWebhook<TVerified>>;
  translate(
    verified: VerifiedWebhook<TVerified>,
    signal: AbortSignal,
  ): Promise<readonly TranslatedWebhookEvent[]>;
}
