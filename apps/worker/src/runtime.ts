import type { Envelope, EnvelopeFor } from "@caseweaver/domain";
import { withOpenTelemetrySpan } from "@caseweaver/observability";

export type KnowledgeSynchronizeCommand =
  EnvelopeFor<"knowledge.synchronize.v2">;
export type KnowledgeFullRescanCommand =
  EnvelopeFor<"knowledge.full-rescan.v2">;

export interface WorkerCommandHandler<Command extends Envelope> {
  handle(command: Command, signal: AbortSignal): Promise<void>;
}

export interface KnowledgeCommandHandlers {
  readonly synchronize: WorkerCommandHandler<KnowledgeSynchronizeCommand>;
  readonly fullRescan: WorkerCommandHandler<KnowledgeFullRescanCommand>;
}

export type AnalysisExecuteCommand = EnvelopeFor<"analysis.execute.v1">;
export type AnalysisTriggerCommand = EnvelopeFor<"analysis.trigger.v2">;
export type PublicationExecuteCommand = EnvelopeFor<"publication.execute.v1">;
export type PublicationReconcileCommand =
  EnvelopeFor<"publication.reconcile.v1">;
export type AnalysisCompletedEvent = EnvelopeFor<"analysis.completed.v1">;
export type RetentionReapCommand = EnvelopeFor<"retention.reap.v1">;
export type RetentionPurgeCommand = EnvelopeFor<"retention.purge.v1">;
export type DiagnosticsExportGenerateCommand =
  EnvelopeFor<"diagnostics.export.generate.v1">;

export interface AnalysisCommandHandlers {
  readonly execute: WorkerCommandHandler<AnalysisExecuteCommand>;
}

export interface PublicationCommandHandlers {
  readonly execute: WorkerCommandHandler<PublicationExecuteCommand>;
  readonly reconcile: WorkerCommandHandler<PublicationReconcileCommand>;
}

export interface PublicationWorkflowCommandHandlers {
  readonly trigger: WorkerCommandHandler<AnalysisTriggerCommand>;
  readonly delivery: PublicationCommandHandlers;
  readonly analysisCompleted: WorkerCommandHandler<AnalysisCompletedEvent>;
}

export interface OperationsCommandHandlers {
  readonly retention: {
    readonly reap: WorkerCommandHandler<RetentionReapCommand>;
    readonly purge: WorkerCommandHandler<RetentionPurgeCommand>;
  };
}

export interface DiagnosticsCommandHandlers {
  readonly generate: WorkerCommandHandler<DiagnosticsExportGenerateCommand>;
}

export interface WorkerCommandHandlers extends KnowledgeCommandHandlers {
  readonly analysis: AnalysisCommandHandlers;
  readonly publication?: PublicationWorkflowCommandHandlers;
  readonly operations?: OperationsCommandHandlers;
  readonly diagnostics?: DiagnosticsCommandHandlers;
}

export interface WorkerCommandDispatcher {
  dispatch(envelope: Envelope, signal: AbortSignal): Promise<void>;
}

export interface WorkerRuntime {
  consume(envelope: Envelope, signal: AbortSignal): Promise<void>;
}

export class UnsupportedWorkerEnvelopeError extends Error {
  public readonly code = "worker.unsupportedEnvelope";
  public readonly retryable = false;

  public constructor(type: Envelope["type"]) {
    super(`Worker does not support envelope type "${type}".`);
    this.name = "UnsupportedWorkerEnvelopeError";
  }
}

/**
 * Historical v1 knowledge envelopes deliberately have no connector-version
 * proof.  Treating their source version as a connector version would execute
 * against mutable configuration, so they must reach the durable queue's
 * visible failure path without invoking connector I/O.
 */
export class LegacyKnowledgeConfigurationUnavailableError extends Error {
  public readonly code = "worker.legacyKnowledgeConfigurationUnavailable";
  public readonly retryable = false;

  public constructor(
    type: "knowledge.synchronize.v1" | "knowledge.full-rescan.v1",
  ) {
    super(
      `Legacy knowledge envelope "${type}" has no immutable connector configuration pin.`,
    );
    this.name = "LegacyKnowledgeConfigurationUnavailableError";
  }
}

/**
 * Trigger v1 did not retain the immutable trigger and connector configuration
 * required to capture a case safely.  It remains deserializable only so the
 * durable queue can record a visible, non-retryable failure without connector
 * I/O or a mutable configuration fallback.
 */
export class LegacyAnalysisTriggerConfigurationUnavailableError extends Error {
  public readonly code = "worker.legacyAnalysisTriggerConfigurationUnavailable";
  public readonly retryable = false;

  public constructor() {
    super(
      "Legacy analysis trigger envelope has no immutable trigger or connector configuration pin.",
    );
    this.name = "LegacyAnalysisTriggerConfigurationUnavailableError";
  }
}

function unsupportedEnvelope(envelope: Envelope): never {
  throw new UnsupportedWorkerEnvelopeError(envelope.type);
}

export function createKnowledgeCommandDispatcher(
  handlers: KnowledgeCommandHandlers,
): WorkerCommandDispatcher {
  return Object.freeze({
    async dispatch(envelope: Envelope, signal: AbortSignal): Promise<void> {
      switch (envelope.type) {
        case "knowledge.synchronize.v2":
          await handlers.synchronize.handle(envelope, signal);
          return;
        case "knowledge.full-rescan.v2":
          await handlers.fullRescan.handle(envelope, signal);
          return;
        case "knowledge.synchronize.v1":
        case "knowledge.full-rescan.v1":
          throw new LegacyKnowledgeConfigurationUnavailableError(envelope.type);
        default:
          return unsupportedEnvelope(envelope);
      }
    },
  });
}

export function createWorkerCommandDispatcher(
  handlers: WorkerCommandHandlers,
): WorkerCommandDispatcher {
  return Object.freeze({
    async dispatch(envelope: Envelope, signal: AbortSignal): Promise<void> {
      switch (envelope.type) {
        case "analysis.execute.v1":
          await handlers.analysis.execute.handle(envelope, signal);
          return;
        case "analysis.trigger.v2":
          if (handlers.publication === undefined) {
            throw new UnsupportedWorkerEnvelopeError(envelope.type);
          }
          await handlers.publication.trigger.handle(envelope, signal);
          return;
        case "analysis.trigger.v1":
          throw new LegacyAnalysisTriggerConfigurationUnavailableError();
        case "publication.execute.v1":
          if (handlers.publication === undefined) {
            throw new UnsupportedWorkerEnvelopeError(envelope.type);
          }
          await handlers.publication.delivery.execute.handle(envelope, signal);
          return;
        case "publication.reconcile.v1":
          if (handlers.publication === undefined) {
            throw new UnsupportedWorkerEnvelopeError(envelope.type);
          }
          await handlers.publication.delivery.reconcile.handle(
            envelope,
            signal,
          );
          return;
        case "analysis.completed.v1":
          if (handlers.publication === undefined) {
            throw new UnsupportedWorkerEnvelopeError(envelope.type);
          }
          await handlers.publication.analysisCompleted.handle(envelope, signal);
          return;
        case "retention.reap.v1":
          if (handlers.operations === undefined) {
            throw new UnsupportedWorkerEnvelopeError(envelope.type);
          }
          await handlers.operations.retention.reap.handle(envelope, signal);
          return;
        case "retention.purge.v1":
          if (handlers.operations === undefined) {
            throw new UnsupportedWorkerEnvelopeError(envelope.type);
          }
          await handlers.operations.retention.purge.handle(envelope, signal);
          return;
        case "diagnostics.export.generate.v1":
          if (handlers.diagnostics === undefined) {
            throw new UnsupportedWorkerEnvelopeError(envelope.type);
          }
          await handlers.diagnostics.generate.handle(envelope, signal);
          return;
        case "knowledge.synchronize.v2":
          await handlers.synchronize.handle(envelope, signal);
          return;
        case "knowledge.full-rescan.v2":
          await handlers.fullRescan.handle(envelope, signal);
          return;
        case "knowledge.synchronize.v1":
        case "knowledge.full-rescan.v1":
          throw new LegacyKnowledgeConfigurationUnavailableError(envelope.type);
        default:
          return unsupportedEnvelope(envelope);
      }
    },
  });
}

export function createWorkerRuntime(
  dispatcher: WorkerCommandDispatcher,
): WorkerRuntime {
  return Object.freeze({
    consume: (envelope: Envelope, signal: AbortSignal) =>
      withOpenTelemetrySpan(
        "caseweaver.worker.consume",
        {
          traceContext: envelope.traceContext,
          attributes: {
            "caseweaver.envelope_type": envelope.type,
            "caseweaver.workspace_id": envelope.workspaceId,
          },
        },
        () => dispatcher.dispatch(envelope, signal),
      ),
  });
}
