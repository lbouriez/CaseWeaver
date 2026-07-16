import { DomainValidationError } from "./errors.js";
import {
  type AnalysisIdentityId,
  type AnalysisJobId,
  type AnalysisResultId,
  type AnalysisTriggerId,
  type AnalysisTriggerRequestId,
  type AnalysisTriggerVersionId,
  analysisIdentityId,
  analysisJobId,
  analysisResultId,
  analysisTriggerId,
  analysisTriggerRequestId,
  analysisTriggerVersionId,
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
  | "analysis.trigger.v2"
  | "publication.execute.v1"
  | "publication.reconcile.v1"
  | "analysis.completed.v1"
  | "knowledge.synchronize.v1"
  | "knowledge.full-rescan.v1"
  | "knowledge.synchronize.v2"
  | "knowledge.full-rescan.v2"
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

/**
 * Historical trigger envelope. It is deserialized only so consumers can
 * classify it as unavailable: it lacks immutable trigger/configuration pins.
 */
export interface LegacyAnalysisTriggerPayload {
  readonly triggerId: string;
  readonly source: "manual" | "schedule" | "webhook";
  readonly occurrenceKey?: string;
  readonly target?: Readonly<{
    connectorInstanceId: string;
    resourceType: string;
    externalId: string;
  }>;
  /** Added during deserialization; never persisted or emitted. */
  readonly legacy?: true;
}

/**
 * All new trigger commands point to a durable request and its exact immutable
 * trigger and connector configuration. They contain neither settings nor
 * secret locators.
 */
export interface AnalysisTriggerPayload {
  readonly triggerRequestId: AnalysisTriggerRequestId;
  readonly triggerId: AnalysisTriggerId;
  readonly triggerVersionId: AnalysisTriggerVersionId;
  readonly connectorRegistrationId: string;
  readonly connectorConfigurationVersionId: string;
  readonly source: "manual" | "schedule" | "webhook";
  readonly occurrenceKey?: string;
  readonly target: Readonly<{
    connectorInstanceId: string;
    resourceType: string;
    externalId: string;
  }>;
}

export interface AnalysisCompletedPayload {
  readonly analysisJobId: AnalysisJobId;
  readonly analysisResultId: AnalysisResultId;
}

/**
 * A legacy knowledge command is deserializable only so workers can classify it
 * as unavailable. Its single historical pin is never a connector pin.
 */
export interface LegacyKnowledgeSynchronizePayload {
  readonly sourceId: string;
  /** Historical source-only configuration pin; never a connector version. */
  readonly configurationVersion: string;
  readonly trigger: "manual" | "schedule";
  /** Added while deserializing; it is never persisted or emitted. */
  readonly legacy: true;
}

/** See {@link LegacyKnowledgeSynchronizePayload}. */
export interface LegacyKnowledgeFullRescanPayload {
  readonly sourceId: string;
  /** Historical source-only configuration pin; never a connector version. */
  readonly configurationVersion: string;
  readonly trigger: "manual" | "schedule";
  /** Added while deserializing; it is never persisted or emitted. */
  readonly legacy: true;
}

/**
 * Immutable runtime pins for newly emitted knowledge synchronization commands.
 * The connector pin identifies server-private configuration composition only;
 * neither connector settings nor credential locators are carried in envelopes.
 */
export interface KnowledgeSynchronizePayload {
  readonly sourceId: string;
  readonly sourceConfigurationVersionId: string;
  readonly connectorConfigurationVersionId: string;
  readonly trigger: "manual" | "schedule";
}

/** See {@link KnowledgeSynchronizePayload}. */
export interface KnowledgeFullRescanPayload {
  readonly sourceId: string;
  readonly sourceConfigurationVersionId: string;
  readonly connectorConfigurationVersionId: string;
  readonly trigger: "manual" | "schedule";
}

export interface RetentionReapPayload {
  readonly reason: "scheduled" | "operator";
  /** Optional so existing v1 commands remain valid after this bounded hint. */
  readonly limit?: number;
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
  readonly "analysis.trigger.v1": LegacyAnalysisTriggerPayload;
  readonly "analysis.trigger.v2": AnalysisTriggerPayload;
  readonly "publication.execute.v1": PublicationExecutePayload;
  readonly "publication.reconcile.v1": PublicationReconcilePayload;
  readonly "analysis.completed.v1": AnalysisCompletedPayload;
  readonly "knowledge.synchronize.v1": LegacyKnowledgeSynchronizePayload;
  readonly "knowledge.full-rescan.v1": LegacyKnowledgeFullRescanPayload;
  readonly "knowledge.synchronize.v2": KnowledgeSynchronizePayload;
  readonly "knowledge.full-rescan.v2": KnowledgeFullRescanPayload;
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

type LegacyKnowledgeEnvelopeType =
  | "knowledge.synchronize.v1"
  | "knowledge.full-rescan.v1";

/** Types that trusted producers may create for new durable work. */
export type EmittableEnvelopeType = Exclude<
  EnvelopeType,
  LegacyKnowledgeEnvelopeType
>;

export type EnvelopeInput<Type extends EmittableEnvelopeType> = Omit<
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
        legacy: true,
      });
    }
    case "analysis.trigger.v2": {
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
      if (!isRecord(payload.target)) {
        throw new DomainValidationError("Envelope payload is invalid.", {
          field: "target",
        });
      }
      return Object.freeze({
        triggerRequestId: analysisTriggerRequestId(
          requireNonEmptyString(payload.triggerRequestId, "triggerRequestId"),
        ),
        triggerId: analysisTriggerId(
          requireNonEmptyString(payload.triggerId, "triggerId"),
        ),
        triggerVersionId: analysisTriggerVersionId(
          requireNonEmptyString(payload.triggerVersionId, "triggerVersionId"),
        ),
        connectorRegistrationId: requireNonEmptyString(
          payload.connectorRegistrationId,
          "connectorRegistrationId",
        ),
        connectorConfigurationVersionId: requireNonEmptyString(
          payload.connectorConfigurationVersionId,
          "connectorConfigurationVersionId",
        ),
        source,
        ...(payload.occurrenceKey === undefined
          ? {}
          : {
              occurrenceKey: requireNonEmptyString(
                payload.occurrenceKey,
                "occurrenceKey",
              ),
            }),
        target: Object.freeze({
          connectorInstanceId: requireNonEmptyString(
            payload.target.connectorInstanceId,
            "target.connectorInstanceId",
          ),
          resourceType: requireNonEmptyString(
            payload.target.resourceType,
            "target.resourceType",
          ),
          externalId: requireNonEmptyString(
            payload.target.externalId,
            "target.externalId",
          ),
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
        legacy: true,
      });
    }
    case "knowledge.synchronize.v2":
    case "knowledge.full-rescan.v2": {
      const trigger = requireString(payload.trigger, "trigger");
      if (trigger !== "manual" && trigger !== "schedule") {
        throw new DomainValidationError("Envelope payload is invalid.", {
          field: "trigger",
        });
      }
      return Object.freeze({
        sourceId: requireNonEmptyString(payload.sourceId, "sourceId"),
        sourceConfigurationVersionId: requireNonEmptyString(
          payload.sourceConfigurationVersionId,
          "sourceConfigurationVersionId",
        ),
        connectorConfigurationVersionId: requireNonEmptyString(
          payload.connectorConfigurationVersionId,
          "connectorConfigurationVersionId",
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
      const limit = payload.limit;
      if (
        limit !== undefined &&
        (typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 1_000)
      ) {
        throw new DomainValidationError("Envelope payload is invalid.", {
          field: "limit",
        });
      }
      return Object.freeze({
        reason,
        ...(limit === undefined ? {} : { limit }),
      });
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

function parseEnvelope(value: unknown, allowLegacy: boolean): Envelope {
  if (!isRecord(value)) {
    throw new DomainValidationError("Envelope is invalid.");
  }

  const type = requireString(value.type, "type") as EnvelopeType;
  const kind = requireString(value.kind, "kind");
  if (
    ![
      "analysis.execute.v1",
      "analysis.trigger.v1",
      "analysis.trigger.v2",
      "publication.execute.v1",
      "publication.reconcile.v1",
      "analysis.completed.v1",
      "knowledge.synchronize.v1",
      "knowledge.full-rescan.v1",
      "knowledge.synchronize.v2",
      "knowledge.full-rescan.v2",
      "retention.reap.v1",
      "retention.purge.v1",
      "diagnostics.export.generate.v1",
    ].includes(type)
  ) {
    throw new DomainValidationError("Envelope type is unsupported.");
  }
  if (
    !allowLegacy &&
    (type === "knowledge.synchronize.v1" ||
      type === "knowledge.full-rescan.v1" ||
      type === "analysis.trigger.v1")
  ) {
    throw new DomainValidationError(
      type === "analysis.trigger.v1"
        ? "Legacy analysis trigger command envelopes cannot be emitted."
        : "Legacy knowledge command envelopes cannot be emitted.",
    );
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

export function createEnvelope<Type extends EmittableEnvelopeType>(
  input: EnvelopeInput<Type>,
): EnvelopeFor<Type> {
  return parseEnvelope(input, false) as EnvelopeFor<Type>;
}

export function deserializeEnvelope(value: unknown): Envelope {
  return parseEnvelope(value, true);
}
