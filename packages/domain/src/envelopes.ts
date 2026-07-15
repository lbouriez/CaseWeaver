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
export interface TraceContext {
  readonly traceparent: string;
  readonly tracestate?: string;
}

export type EnvelopeType =
  | "analysis.execute.v1"
  | "analysis.trigger.v1"
  | "publication.execute.v1"
  | "publication.reconcile.v1"
  | "analysis.completed.v1"
  | "knowledge.synchronize.v1"
  | "knowledge.full-rescan.v1"
  | "retention.reap.v1"
  | "retention.purge.v1"
  | "diagnostics.export.generate.v1";

export interface AnalysisExecutePayload {
  readonly analysisJobId: AnalysisJobId;
  readonly analysisIdentityId: AnalysisIdentityId;
}

export interface PublicationExecutePayload {
  readonly publicationIntentId: PublicationIntentId;
}

export interface PublicationReconcilePayload {
  readonly publicationIntentId: PublicationIntentId;
}

export interface AnalysisTriggerPayload {
  readonly triggerId: string;
  readonly source: "manual" | "schedule" | "webhook";
  readonly occurrenceKey?: string;
  readonly target?: Readonly<{
    connectorInstanceId: string;
    resourceType: string;
    externalId: string;
  }>;
}

export interface AnalysisCompletedPayload {
  readonly analysisJobId: AnalysisJobId;
  readonly analysisResultId: AnalysisResultId;
}

export interface KnowledgeSynchronizePayload {
  readonly sourceId: string;
  /** Immutable source configuration selected when the command was accepted. */
  readonly configurationVersion: string;
  readonly trigger: "manual" | "schedule";
}

export interface KnowledgeFullRescanPayload {
  readonly sourceId: string;
  /** Immutable source configuration selected when the command was accepted. */
  readonly configurationVersion: string;
  readonly trigger: "manual" | "schedule";
}

export interface RetentionReapPayload {
  readonly reason: "scheduled" | "operator";
}

export interface RetentionPurgePayload {
  readonly workItemId: string;
}

/** The durable command contains only the opaque export identifier. */
export interface DiagnosticsExportGeneratePayload {
  readonly exportId: string;
}

export type EnvelopePayloadByType = {
  readonly "analysis.execute.v1": AnalysisExecutePayload;
  readonly "analysis.trigger.v1": AnalysisTriggerPayload;
  readonly "publication.execute.v1": PublicationExecutePayload;
  readonly "publication.reconcile.v1": PublicationReconcilePayload;
  readonly "analysis.completed.v1": AnalysisCompletedPayload;
  readonly "knowledge.synchronize.v1": KnowledgeSynchronizePayload;
  readonly "knowledge.full-rescan.v1": KnowledgeFullRescanPayload;
  readonly "retention.reap.v1": RetentionReapPayload;
  readonly "retention.purge.v1": RetentionPurgePayload;
  readonly "diagnostics.export.generate.v1": DiagnosticsExportGeneratePayload;
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
        traceContext?: TraceContext;
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
    case "analysis.trigger.v1": {
      const source = requireString(payload.source, "source");
      if (
        source !== "manual" &&
        source !== "schedule" &&
        source !== "webhook"
      ) {
        throw new DomainValidationError("Envelope payload is invalid.", {
          field: "source",
        });
      }
      const target = payload.target;
      if (target !== undefined && !isRecord(target)) {
        throw new DomainValidationError("Envelope payload is invalid.", {
          field: "target",
        });
      }
      return Object.freeze({
        triggerId: requireNonEmptyString(payload.triggerId, "triggerId"),
        source,
        ...(payload.occurrenceKey === undefined
          ? {}
          : {
              occurrenceKey: requireNonEmptyString(
                payload.occurrenceKey,
                "occurrenceKey",
              ),
            }),
        ...(target === undefined
          ? {}
          : {
              target: Object.freeze({
                connectorInstanceId: requireNonEmptyString(
                  target.connectorInstanceId,
                  "target.connectorInstanceId",
                ),
                resourceType: requireNonEmptyString(
                  target.resourceType,
                  "target.resourceType",
                ),
                externalId: requireNonEmptyString(
                  target.externalId,
                  "target.externalId",
                ),
              }),
            }),
      });
    }
    case "publication.execute.v1":
      return Object.freeze({
        publicationIntentId: publicationIntentId(
          requireString(payload.publicationIntentId, "publicationIntentId"),
        ),
      });
    case "publication.reconcile.v1":
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
    case "knowledge.full-rescan.v1": {
      const trigger = requireString(payload.trigger, "trigger");
      if (trigger !== "manual" && trigger !== "schedule") {
        throw new DomainValidationError("Envelope payload is invalid.", {
          field: "trigger",
        });
      }
      return Object.freeze({
        sourceId: requireNonEmptyString(payload.sourceId, "sourceId"),
        configurationVersion: requireNonEmptyString(
          payload.configurationVersion,
          "configurationVersion",
        ),
        trigger,
      });
    }
    case "retention.reap.v1": {
      const reason = requireString(payload.reason, "reason");
      if (reason !== "scheduled" && reason !== "operator") {
        throw new DomainValidationError("Envelope payload is invalid.", {
          field: "reason",
        });
      }
      return Object.freeze({ reason });
    }
    case "retention.purge.v1":
      return Object.freeze({
        workItemId: requireNonEmptyString(payload.workItemId, "workItemId"),
      });
    case "diagnostics.export.generate.v1":
      return Object.freeze({
        exportId: requireNonEmptyString(payload.exportId, "exportId"),
      });
  }
}

function parseTraceContext(value: unknown): TraceContext | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new DomainValidationError("Envelope trace context is invalid.");
  }
  const traceparent = requireString(
    value.traceparent,
    "traceContext.traceparent",
  );
  if (!/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/iu.test(traceparent)) {
    throw new DomainValidationError("Envelope trace context is invalid.");
  }
  const tracestate =
    value.tracestate === undefined
      ? undefined
      : requireString(value.tracestate, "traceContext.tracestate");
  if (
    tracestate !== undefined &&
    (tracestate.length === 0 || tracestate.length > 512)
  ) {
    throw new DomainValidationError("Envelope trace context is invalid.");
  }
  return Object.freeze({
    traceparent: traceparent.toLowerCase(),
    ...(tracestate === undefined ? {} : { tracestate }),
  });
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
      "analysis.trigger.v1",
      "publication.execute.v1",
      "publication.reconcile.v1",
      "analysis.completed.v1",
      "knowledge.synchronize.v1",
      "knowledge.full-rescan.v1",
      "retention.reap.v1",
      "retention.purge.v1",
      "diagnostics.export.generate.v1",
    ].includes(type)
  ) {
    throw new DomainValidationError("Envelope type is unsupported.");
  }
  const requiredKind =
    type === "analysis.completed.v1" ? "domainEvent" : "command";
  if (kind !== requiredKind || value.schemaVersion !== 1) {
    throw new DomainValidationError("Envelope metadata is invalid.");
  }

  const traceContext = parseTraceContext(value.traceContext);
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
    ...(traceContext === undefined ? {} : { traceContext }),
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
