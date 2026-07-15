import type {
  ConnectorCapabilityRegistry,
  ConnectorConfiguration,
} from "@caseweaver/connector-sdk";

import type { JitbitSettings } from "./config.js";
import type { JitbitCaseSource } from "./jitbit-case-source.js";
import type { JitbitAnalysisDestination } from "./jitbit-destination.js";
import type { JitbitKnowledgeSource } from "./jitbit-knowledge-source.js";

export * from "./administration-descriptor.js";
export * from "./client.js";
export * from "./config.js";
export * from "./fakes.js";
export * from "./jitbit-case-source.js";
export * from "./jitbit-destination.js";
export * from "./jitbit-knowledge-source.js";
export * from "./mapping.js";
export * from "./schemas.js";

/** Registers the Jitbit capabilities supported by this adapter. */
export function registerJitbitConnector(
  registry: ConnectorCapabilityRegistry,
  configuration: ConnectorConfiguration<JitbitSettings>,
  capabilities: {
    readonly knowledgeSource: JitbitKnowledgeSource;
    readonly caseSource: JitbitCaseSource;
    readonly analysisDestination: JitbitAnalysisDestination;
  },
): void {
  registry.register({
    instanceId: configuration.settings.connectorInstanceId,
    connectorType: "jitbit",
    capabilities,
  });
}
