import type {
  ConnectorCapabilityPorts,
  ConnectorConfiguration,
  ConnectorCapabilityRegistry,
} from "@caseweaver/connector-sdk";

import type { ExampleConnectorSettings } from "./config.js";

/**
 * A connector registers only the capabilities it actually implements. Consumers receive
 * undefined for all omitted capabilities rather than a fabricated adapter.
 */
export function registerExampleConnector(
  registry: ConnectorCapabilityRegistry,
  configuration: ConnectorConfiguration<ExampleConnectorSettings>,
  capabilities: Partial<ConnectorCapabilityPorts>,
): void {
  registry.register({
    instanceId: configuration.settings.connectorInstanceId,
    connectorType: configuration.connectorType,
    capabilities,
  });
}
