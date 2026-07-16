import type {
  ConnectorCapabilityRegistry,
  ConnectorConfiguration,
} from "@caseweaver/connector-sdk";

import type { GitMarkdownSettings } from "./config.js";
import type { GitMarkdownKnowledgeSource } from "./git-markdown-source.js";

export * from "./administration-descriptor.js";
export * from "./administration-test.js";
export * from "./config.js";
export * from "./fakes.js";
export * from "./git-markdown-source.js";
export * from "./git-repository.js";
export * from "./markdown.js";
export * from "./runtime-contribution.js";

/**
 * Registers only the knowledge-source capability provided by this connector.
 */
export function registerGitMarkdownConnector(
  registry: ConnectorCapabilityRegistry,
  configuration: ConnectorConfiguration<GitMarkdownSettings>,
  source: GitMarkdownKnowledgeSource,
): void {
  registry.register({
    instanceId: configuration.settings.connectorInstanceId,
    connectorType: "git-markdown",
    capabilities: { knowledgeSource: source },
  });
}
