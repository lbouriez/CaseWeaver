import {
  type RuntimeConnectorCapabilityResolver,
  RuntimeConnectorCapabilityUnavailableError,
} from "@caseweaver/connector-runtime";
import type { EnvelopeFor } from "@caseweaver/domain";

type ResolvedAnalysisDestination = Awaited<
  ReturnType<RuntimeConnectorCapabilityResolver["resolveAnalysisDestination"]>
>;

export type AnalysisTriggerCommand = EnvelopeFor<"analysis.trigger.v2">;
export type PublicationExecuteCommand = EnvelopeFor<"publication.execute.v1">;
export type PublicationReconcileCommand =
  EnvelopeFor<"publication.reconcile.v1">;

/**
 * Adapter-owned publication destination lookup. The application publication
 * port is deliberately structural here: the worker is the outer layer that
 * knows how to translate its exact immutable pin into a runtime capability.
 */
export interface PublicationDestinationResolver {
  resolve(input: {
    readonly workspaceId: string;
    readonly connectorRegistrationId: string;
    readonly connectorConfigurationVersionId: string;
    readonly signal: AbortSignal;
  }): Promise<ResolvedAnalysisDestination | undefined>;
}

/**
 * Resolves only the destination configuration version retained by a
 * publication intent. It neither reads a connector aggregate's current
 * version nor exposes settings, secret locators, or adapter errors.
 */
export class RuntimePublicationDestinationResolver
  implements PublicationDestinationResolver
{
  public constructor(
    private readonly connectors: RuntimeConnectorCapabilityResolver,
  ) {}

  public async resolve(
    input: Parameters<PublicationDestinationResolver["resolve"]>[0],
  ): Promise<ResolvedAnalysisDestination | undefined> {
    throwIfAborted(input.signal);
    try {
      const destination = await this.connectors.resolveAnalysisDestination({
        workspaceId: input.workspaceId,
        connectorRegistrationId: input.connectorRegistrationId,
        connectorConfigurationVersionId: input.connectorConfigurationVersionId,
      });
      throwIfAborted(input.signal);
      return destination;
    } catch (error) {
      if (error instanceof RuntimeConnectorCapabilityUnavailableError) {
        return undefined;
      }
      throw error;
    }
  }
}

/** The PBI-012 capture use case accepts only version-pinned trigger work. */
export interface AnalysisTriggerService {
  trigger(
    command: AnalysisTriggerCommand,
    signal: AbortSignal,
  ): Promise<unknown>;
}

/**
 * Structural boundary for `PublicationExecutor`. Keeping it structural avoids
 * a reverse dependency from this outer worker module into publication policy;
 * composition supplies the executor after constructing its stores and renderer.
 */
export interface PublicationExecutorService {
  execute(
    command: PublicationExecuteCommand | PublicationReconcileCommand,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface PublicationService {
  execute(
    command: PublicationExecuteCommand,
    signal: AbortSignal,
  ): Promise<unknown>;
  reconcile(
    command: PublicationReconcileCommand,
    signal: AbortSignal,
  ): Promise<unknown>;
}

/**
 * Adapts one injected `PublicationExecutor` to the worker command shape. A
 * reconcile envelope always targets the durable intent in its payload; bulk
 * outcome-unknown scans remain an explicit scheduler/operations concern.
 */
export function createPublicationService(
  executor: PublicationExecutorService,
): PublicationService {
  return Object.freeze({
    execute: (command: PublicationExecuteCommand, signal: AbortSignal) =>
      executor.execute(command, signal),
    reconcile: (command: PublicationReconcileCommand, signal: AbortSignal) =>
      executor.execute(command, signal),
  });
}

export interface AnalysisCompletedService {
  complete(event: EnvelopeFor<"analysis.completed.v1">): Promise<unknown>;
}

/**
 * Publication workflow handlers contain no connector choice. Composition
 * injects a version-pinned trigger capturer, a real publication executor, and
 * the durable analysis-completion consumer.
 */
export function createPublicationWorkflowHandlers(input: {
  readonly trigger: AnalysisTriggerService;
  readonly publication: PublicationService;
  readonly analysisCompleted: AnalysisCompletedService;
}) {
  return Object.freeze({
    trigger: {
      handle: async (
        command: AnalysisTriggerCommand,
        signal: AbortSignal,
      ): Promise<void> => {
        await input.trigger.trigger(command, signal);
      },
    },
    publication: {
      execute: {
        handle: async (
          command: PublicationExecuteCommand,
          signal: AbortSignal,
        ): Promise<void> => {
          await input.publication.execute(command, signal);
        },
      },
      reconcile: {
        handle: async (
          command: PublicationReconcileCommand,
          signal: AbortSignal,
        ): Promise<void> => {
          await input.publication.reconcile(command, signal);
        },
      },
    },
    analysisCompleted: {
      handle: async (
        event: EnvelopeFor<"analysis.completed.v1">,
        _signal: AbortSignal,
      ): Promise<void> => {
        await input.analysisCompleted.complete(event);
      },
    },
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("The operation was aborted.");
  }
}
