import {
  type RuntimeConnectorCapabilityResolver,
  RuntimeConnectorCapabilityUnavailableError,
} from "@caseweaver/connector-runtime";
import {
  KnowledgeSourceRuntimeUnavailableError,
  type KnowledgeSynchronizationCoordinator,
  type PinnedKnowledgeSourceConfigurationResolver,
} from "@caseweaver/knowledge";

import type {
  KnowledgeCommandHandlers,
  KnowledgeFullRescanCommand,
  KnowledgeSynchronizeCommand,
  WorkerCommandHandler,
} from "../runtime.js";
import { createUnavailableWorkerCommandHandler } from "../runtime-registry.js";

export interface KnowledgeRuntimeDependencies {
  readonly connectors: RuntimeConnectorCapabilityResolver;
  readonly sourceConfigurations: PinnedKnowledgeSourceConfigurationResolver;
  readonly coordinator: KnowledgeSynchronizationCoordinator;
}

/**
 * Translates an immutable v2 envelope into a coordinator request. Source and
 * connector configuration are resolved independently from their exact durable
 * pins; neither is ever rebound to a connector's current configuration.
 */
export function createKnowledgeHandlers(
  dependencies?: KnowledgeRuntimeDependencies,
): KnowledgeCommandHandlers {
  if (dependencies === undefined) {
    return Object.freeze({
      synchronize: createUnavailableWorkerCommandHandler("knowledge"),
      fullRescan: createUnavailableWorkerCommandHandler("knowledge"),
    });
  }
  return Object.freeze({
    synchronize: handler(dependencies, "incremental"),
    fullRescan: handler(dependencies, "fullRescan"),
  });
}

function handler(
  dependencies: KnowledgeRuntimeDependencies,
  mode: "incremental" | "fullRescan",
): WorkerCommandHandler<
  KnowledgeSynchronizeCommand | KnowledgeFullRescanCommand
> {
  return Object.freeze({
    async handle(
      command: KnowledgeSynchronizeCommand | KnowledgeFullRescanCommand,
      signal: AbortSignal,
    ): Promise<void> {
      const configuration = await dependencies.sourceConfigurations.resolve({
        workspaceId: command.workspaceId,
        sourceId: command.payload.sourceId,
        sourceConfigurationVersionId:
          command.payload.sourceConfigurationVersionId,
        connectorConfigurationVersionId:
          command.payload.connectorConfigurationVersionId,
      });
      if (configuration === undefined) {
        throw new KnowledgeSourceRuntimeUnavailableError();
      }
      const source = await dependencies.connectors
        .resolveKnowledgeSource({
          workspaceId: command.workspaceId,
          connectorRegistrationId: configuration.connectorRegistrationId,
          connectorConfigurationVersionId:
            command.payload.connectorConfigurationVersionId,
        })
        .catch((error: unknown) => {
          if (error instanceof RuntimeConnectorCapabilityUnavailableError) {
            throw new KnowledgeSourceRuntimeUnavailableError();
          }
          throw error;
        });
      const result = await dependencies.coordinator.execute({
        workspaceId: command.workspaceId,
        sourceId: command.payload.sourceId,
        sourceConfigurationVersionId:
          command.payload.sourceConfigurationVersionId,
        connectorConfigurationVersionId:
          command.payload.connectorConfigurationVersionId,
        mode,
        source,
        signal,
      });
      if (result.kind === "unavailable") {
        throw new KnowledgeSourceRuntimeUnavailableError();
      }
    },
  });
}
