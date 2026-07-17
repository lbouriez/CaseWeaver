import type {
  AttachmentSource,
  ConnectorCapabilityRegistry,
  ConnectorConfiguration,
} from "@caseweaver/connector-sdk";

import type { GitMarkdownSettings } from "./config.js";
import type { GitMarkdownKnowledgeSource } from "./git-markdown-source.js";

export * from "./administration-descriptor.js";
export * from "./administration-test.js";
export * from "./attachment-locator.js";
export * from "./config.js";
export * from "./fakes.js";
export * from "./git-markdown-attachment-source.js";
export * from "./git-markdown-source.js";
export * from "./git-repository.js";
export * from "./markdown.js";
export * from "./markdown-attachments.js";
export * from "./runtime-contribution.js";

/**
 * Registers Git/Markdown's source capabilities. The attachment source is optional
 * only while trusted composition is rolling out a sealed locator codec and binary Git
 * runtime; it must never be fabricated from a browser or public URL.
 */
export function registerGitMarkdownConnector(
  registry: ConnectorCapabilityRegistry,
  configuration: ConnectorConfiguration<GitMarkdownSettings>,
  source: GitMarkdownKnowledgeSource,
  attachmentSource?: AttachmentSource,
): void {
  registry.register({
    instanceId: configuration.settings.connectorInstanceId,
    connectorType: "git-markdown",
    capabilities: {
      knowledgeSource: source,
      ...(attachmentSource === undefined ? {} : { attachmentSource }),
    },
  });
}
