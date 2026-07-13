import { DomainValidationError } from "./errors.js";
import {
  type AnalysisIdentityId,
  type AnalysisJobId,
  type AnalysisResultId,
  analysisIdentityId,
  analysisJobId,
  analysisResultId,
  type CausationId,
  type CorrelationId,
  causationId,
  correlationId,
  type OutboxEnvelopeId,
  outboxEnvelopeId,
  type PublicationIntentId,
  publicationIntentId,
  type UtcInstant,
  utcInstant,
  type WorkspaceId,
  workspaceId,
} from "./ids.js";

export type EnvelopeKind = "command" | "domainEvent";
export type EnvelopeType =
  | "analysis.execute.v1"
  | "publication.execute.v1"
  | "analysis.completed.v1"
  | "knowledge.synchronize.v1"
  | "knowledge.full-rescan.v1";

export interface AnalysisExecutePayload {
  readonly analysisJobId: AnalysisJobId;
  readonly analysisIdentityId: AnalysisIdentityId;
}

export interface PublicationExecutePayload {
  readonly publicationIntentId: PublicationIntentId;
}

export interface AnalysisCompletedPayload {
  readonly analysisJobId: AnalysisJobId;
  readonly analysisResultId: AnalysisResultId;
}

export interface KnowledgeSynchronizePayload {
  readonly sourceId: string;
}

export interface KnowledgeFullRescanPayload {
  readonly sourceId: string;
}

export type EnvelopePayloadByType = {
  readonly "analysis.execute.v1": AnalysisExecutePayload;
  readonly "publication.execute.v1": PublicationExecutePayload;
  readonly "analysis.completed.v1": AnalysisCompletedPayload;
  readonly "knowledge.synchronize.v1": KnowledgeSynchronizePayload;
  readonly "knowledge.full-rescan.v1": KnowledgeFullRescanPayload;
};

export type EnvelopeFor<Type extends EnvelopeType = EnvelopeType> =
  Type extends EnvelopeType
    ? Readonly<{
        id: OutboxEnvelopeId;
        kind: Type extends "analysis.completed.v1" ? "domainEvent" : "command";
        type: Type;
        schemaVersion: 1;
        workspaceId: WorkspaceId;
        occurredAt: UtcInstant;
        correlationId: CorrelationId;
        causationId: CausationId;
        payload: Readonly<EnvelopePayloadByType[Type]>;
      }>
    : never;

export type Envelope = EnvelopeFor;

export type EnvelopeInput<Type extends EnvelopeType> = Omit<
  EnvelopeFor<Type>,
  "payload"
> & {
  readonly payload: EnvelopePayloadByType[Type];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new DomainValidationError("Envelope is invalid.", { field });
  }

  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  const string = requireString(value, field);
  if (string.length === 0) {
    throw new DomainValidationError("Envelope is invalid.", { field });
  }
  return string;
}

function parsePayload(
  type: EnvelopeType,
  payload: unknown,
): EnvelopePayloadByType[EnvelopeType] {
  if (!isRecord(payload)) {
    throw new DomainValidationError("Envelope payload is invalid.");
  }

  switch (type) {
    case "analysis.execute.v1":
      return Object.freeze({
        analysisJobId: analysisJobId(
          requireString(payload.analysisJobId, "analysisJobId"),
        ),
        analysisIdentityId: analysisIdentityId(
          requireString(payload.analysisIdentityId, "analysisIdentityId"),
        ),
      });
    case "publication.execute.v1":
      return Object.freeze({
        publicationIntentId: publicationIntentId(
          requireString(payload.publicationIntentId, "publicationIntentId"),
        ),
      });
    case "analysis.completed.v1":
      return Object.freeze({
        analysisJobId: analysisJobId(
          requireString(payload.analysisJobId, "analysisJobId"),
        ),
        analysisResultId: analysisResultId(
          requireString(payload.analysisResultId, "analysisResultId"),
        ),
      });
    case "knowledge.synchronize.v1":
      return Object.freeze({
        sourceId: requireNonEmptyString(payload.sourceId, "sourceId"),
      });
    case "knowledge.full-rescan.v1":
      return Object.freeze({
        sourceId: requireNonEmptyString(payload.sourceId, "sourceId"),
      });
  }
}

function parseEnvelope(value: unknown): Envelope {
  if (!isRecord(value)) {
    throw new DomainValidationError("Envelope is invalid.");
  }

  const type = requireString(value.type, "type") as EnvelopeType;
  const kind = requireString(value.kind, "kind");
  if (
    ![
      "analysis.execute.v1",
      "publication.execute.v1",
      "analysis.completed.v1",
      "knowledge.synchronize.v1",
      "knowledge.full-rescan.v1",
    ].includes(type)
  ) {
    throw new DomainValidationError("Envelope type is unsupported.");
  }
  const requiredKind =
    type === "analysis.completed.v1" ? "domainEvent" : "command";
  if (kind !== requiredKind || value.schemaVersion !== 1) {
    throw new DomainValidationError("Envelope metadata is invalid.");
  }

  const envelope = {
    id: outboxEnvelopeId(requireString(value.id, "id")),
    kind: requiredKind,
    type,
    schemaVersion: 1 as const,
    workspaceId: workspaceId(requireString(value.workspaceId, "workspaceId")),
    occurredAt: utcInstant(requireString(value.occurredAt, "occurredAt")),
    correlationId: correlationId(
      requireString(value.correlationId, "correlationId"),
    ),
    causationId: causationId(requireString(value.causationId, "causationId")),
    payload: parsePayload(type, value.payload),
  };

  return Object.freeze(envelope) as Envelope;
}

export function createEnvelope<Type extends EnvelopeType>(
  input: EnvelopeInput<Type>,
): EnvelopeFor<Type> {
  return parseEnvelope(input) as EnvelopeFor<Type>;
}

export function deserializeEnvelope(value: unknown): Envelope {
  return parseEnvelope(value);
}
