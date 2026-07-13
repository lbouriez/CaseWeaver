import {
  InMemoryConnectorSecretResolver,
  type ConnectorSecretResolver,
} from "@caseweaver/connector-sdk";

import {
  type JitbitConfiguration,
  jitbitConfigurationSchema,
} from "./config.js";

export function createJitbitConfiguration(
  overrides: Record<string, unknown> = {},
): JitbitConfiguration {
  const { secrets, ...settings } = overrides;
  return jitbitConfigurationSchema.parse({
    schemaVersion: 1,
    connectorType: "jitbit",
    secrets: secrets ?? { apiToken: "vault:jitbit-token" },
    settings: {
      connectorInstanceId: "jitbit-helpdesk",
      baseUrl: "https://helpdesk.example.invalid",
      ...settings,
    },
  });
}

export function createJitbitSecretResolver(): ConnectorSecretResolver {
  return new InMemoryConnectorSecretResolver({
    "vault:jitbit-token": "test-token",
  });
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}
