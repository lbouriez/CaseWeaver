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
  gitMarkdownDescriptorReference,
  gitMarkdownRuntimeDescriptorReferences,
} from "./administration-descriptor.js";
import type { GitMarkdownAttachmentLocatorCodec } from "./attachment-locator.js";
import {
  type GitMarkdownConfiguration,
  gitMarkdownConfigurationSchema,
  gitMarkdownSettingsSchema,
} from "./config.js";
import { GitMarkdownAttachmentSource } from "./git-markdown-attachment-source.js";
import { GitMarkdownKnowledgeSource } from "./git-markdown-source.js";
import type { GitRepository } from "./git-repository.js";

type GitMarkdownRuntimeDescriptorReference = Readonly<{
  readonly kind: "connector";
  readonly type: "git-markdown";
  readonly version: string;
}>;

/**
 * The repository implementation is supplied by trusted composition. This keeps the
 * connector free of process, filesystem, network, and credential-helper concerns.
 */
export interface GitMarkdownRuntimeRepositoryFactory {
  create(): GitRepository;
}

export interface CreateGitMarkdownRuntimeContributionOptions {
  readonly repositoryFactory: GitMarkdownRuntimeRepositoryFactory;
  /**
   * Trusted composition owns sealed-token key lifecycle. Without it, documents with
   * attachment links fail closed and no attachment source capability is advertised.
   */
  readonly attachmentLocatorCodec?: GitMarkdownAttachmentLocatorCodec;
}

/**
 * Builds Git/Markdown's declared capability from one exact, server-private immutable
 * configuration version. Secret values are resolved lazily by the source only when a
 * remote operation needs them.
 */
export function createGitMarkdownRuntimeContribution(
  options: CreateGitMarkdownRuntimeContributionOptions,
): ConnectorRuntimeContribution {
  return createRuntimeContribution(options, gitMarkdownDescriptorReference);
}

/**
 * Production composition registers one contribution for each compatible
 * immutable descriptor revision. This lets already-queued work use its exact
 * historical pin without allowing the Admin console to author an old form.
 */
export function createGitMarkdownRuntimeContributions(
  options: CreateGitMarkdownRuntimeContributionOptions,
): readonly ConnectorRuntimeContribution[] {
  return Object.freeze(
    gitMarkdownRuntimeDescriptorReferences.map((descriptor) =>
      createRuntimeContribution(options, descriptor),
    ),
  );
}

function createRuntimeContribution(
  options: CreateGitMarkdownRuntimeContributionOptions,
  descriptor: GitMarkdownRuntimeDescriptorReference,
): ConnectorRuntimeContribution {
  return Object.freeze({
    descriptor,
    async create({
      configuration,
      secrets,
    }: Parameters<
      ConnectorRuntimeContribution["create"]
    >[0]): Promise<ConnectorRuntimeCapabilities> {
      const parsed = parseRuntimeConfiguration(configuration, descriptor);
      const repository = options.repositoryFactory.create();
      const attachmentLocatorCodec = options.attachmentLocatorCodec;
      const knowledgeSource = new GitMarkdownKnowledgeSource({
        configuration: parsed,
        repository,
        secrets,
        attachmentLocatorCodec,
      });
      return Object.freeze({
        knowledgeSource,
        ...(attachmentLocatorCodec === undefined
          ? {}
          : {
              attachmentSource: new GitMarkdownAttachmentSource({
                configuration: parsed,
                repository,
                secrets,
                locatorCodec: attachmentLocatorCodec,
              }),
            }),
      });
    },
  });
}

function parseRuntimeConfiguration(
  configuration: ServerPrivateConnectorConfiguration,
  descriptor: GitMarkdownRuntimeDescriptorReference,
): GitMarkdownConfiguration {
  try {
    if (!sameDescriptor(configuration.descriptor, descriptor)) {
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
  right: GitMarkdownRuntimeDescriptorReference,
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
