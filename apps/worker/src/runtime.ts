import type { Envelope, EnvelopeFor } from "@caseweaver/domain";

export type KnowledgeSynchronizeCommand =
  EnvelopeFor<"knowledge.synchronize.v1">;
export type KnowledgeFullRescanCommand =
  EnvelopeFor<"knowledge.full-rescan.v1">;

export interface WorkerCommandHandler<Command extends Envelope> {
  handle(command: Command, signal: AbortSignal): Promise<void>;
}

export interface KnowledgeCommandHandlers {
  readonly synchronize: WorkerCommandHandler<KnowledgeSynchronizeCommand>;
  readonly fullRescan: WorkerCommandHandler<KnowledgeFullRescanCommand>;
}

export type AnalysisExecuteCommand = EnvelopeFor<"analysis.execute.v1">;

export interface AnalysisCommandHandlers {
  readonly execute: WorkerCommandHandler<AnalysisExecuteCommand>;
}

export interface WorkerCommandHandlers extends KnowledgeCommandHandlers {
  readonly analysis: AnalysisCommandHandlers;
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

export function createKnowledgeCommandDispatcher(
  handlers: KnowledgeCommandHandlers,
): WorkerCommandDispatcher {
  return Object.freeze({
    async dispatch(envelope: Envelope, signal: AbortSignal): Promise<void> {
      switch (envelope.type) {
        case "knowledge.synchronize.v1":
          await handlers.synchronize.handle(envelope, signal);
          return;
        case "knowledge.full-rescan.v1":
          await handlers.fullRescan.handle(envelope, signal);
          return;
        default:
          throw new UnsupportedWorkerEnvelopeError(envelope.type);
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
        case "knowledge.synchronize.v1":
          await handlers.synchronize.handle(envelope, signal);
          return;
        case "knowledge.full-rescan.v1":
          await handlers.fullRescan.handle(envelope, signal);
          return;
        default:
          throw new UnsupportedWorkerEnvelopeError(envelope.type);
      }
    },
  });
}

export function createWorkerRuntime(
  dispatcher: WorkerCommandDispatcher,
): WorkerRuntime {
  return Object.freeze({
    consume: (envelope: Envelope, signal: AbortSignal) =>
      dispatcher.dispatch(envelope, signal),
  });
}
