import type {
  ConfigurationDescriptorReference,
  ServerPrivateConnectorConfiguration,
} from "@caseweaver/administration";
import type {
  ConnectorRuntimeCapabilities,
  ConnectorRuntimeContribution,
} from "@caseweaver/connector-runtime";
import { ConnectorConfigurationError } from "@caseweaver/connector-sdk";

import {
  type GitMarkdownConfiguration,
  gitMarkdownConfigurationSchema,
  gitMarkdownSettingsSchema,
} from "./config.js";
import { GitMarkdownKnowledgeSource } from "./git-markdown-source.js";
import type { GitRepository } from "./git-repository.js";

const gitMarkdownRuntimeDescriptor = Object.freeze({
  kind: "connector",
  type: "git-markdown",
  version: "1",
} as const);

/**
 * The repository implementation is supplied by trusted composition. This keeps the
 * connector free of process, filesystem, network, and credential-helper concerns.
 */
export interface GitMarkdownRuntimeRepositoryFactory {
  create(): GitRepository;
}

export interface CreateGitMarkdownRuntimeContributionOptions {
  readonly repositoryFactory: GitMarkdownRuntimeRepositoryFactory;
}

/**
 * Builds Git/Markdown's declared capability from one exact, server-private immutable
 * configuration version. Secret values are resolved lazily by the source only when a
 * remote operation needs them.
 */
export function createGitMarkdownRuntimeContribution(
  options: CreateGitMarkdownRuntimeContributionOptions,
): ConnectorRuntimeContribution {
  return Object.freeze({
    descriptor: gitMarkdownRuntimeDescriptor,
    async create({
      configuration,
      secrets,
    }: Parameters<
      ConnectorRuntimeContribution["create"]
    >[0]): Promise<ConnectorRuntimeCapabilities> {
      const parsed = parseRuntimeConfiguration(configuration);
      const repository = options.repositoryFactory.create();
      return Object.freeze({
        knowledgeSource: new GitMarkdownKnowledgeSource({
          configuration: parsed,
          repository,
          secrets,
        }),
      });
    },
  });
}

function parseRuntimeConfiguration(
  configuration: ServerPrivateConnectorConfiguration,
): GitMarkdownConfiguration {
  try {
    if (
      !sameDescriptor(configuration.descriptor, gitMarkdownRuntimeDescriptor)
    ) {
      throw runtimeUnavailable();
    }
    const settings = gitMarkdownSettingsSchema.parse(configuration.settings);
    if (
      settings.connectorInstanceId !== configuration.connectorRegistrationId
    ) {
      throw runtimeUnavailable();
    }

    const authentication = settings.authentication;
    if (authentication.kind === "none") {
      if (configuration.secretReferences.length !== 0) {
        throw runtimeUnavailable();
      }
      return gitMarkdownConfigurationSchema.parse({
        schemaVersion: 1,
        connectorType: "git-markdown",
        settings,
        secrets: {},
      });
    }

    if (
      settings.repository.kind !== "remote" ||
      configuration.secretReferences.length !== 1 ||
      configuration.secretReferences[0]?.locator !== authentication.secretName
    ) {
      throw runtimeUnavailable();
    }
    return gitMarkdownConfigurationSchema.parse({
      schemaVersion: 1,
      connectorType: "git-markdown",
      settings,
      secrets: { [authentication.secretName]: authentication.secretName },
    });
  } catch (error) {
    if (error instanceof ConnectorConfigurationError) throw error;
    throw runtimeUnavailable();
  }
}

function sameDescriptor(
  left: ConfigurationDescriptorReference,
  right: typeof gitMarkdownRuntimeDescriptor,
): boolean {
  return (
    left.kind === right.kind &&
    left.type === right.type &&
    left.version === right.version
  );
}

function runtimeUnavailable(): ConnectorConfigurationError {
  return new ConnectorConfigurationError(
    "The configured Git/Markdown runtime is unavailable.",
  );
}
