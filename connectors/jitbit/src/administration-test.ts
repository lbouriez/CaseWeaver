import type { ConnectorSecretResolver } from "@caseweaver/connector-sdk";

import { JitbitClient } from "./client.js";
import { jitbitConfigurationSchema, jitbitSettingsSchema } from "./config.js";

/**
 * Performs Jitbit's non-destructive connectivity check with the smallest
 * supported read.  The returned ticket data and any remote failure detail are
 * deliberately discarded at this adapter boundary.
 */
export async function testJitbitAdministrationSettings(
  input: Readonly<{
    readonly settings: Readonly<Record<string, unknown>>;
    readonly secrets: ConnectorSecretResolver;
    readonly signal: AbortSignal;
    /** Test seam; trusted composition uses the runtime default fetch. */
    readonly fetch?: typeof fetch;
  }>,
): Promise<void> {
  const settings = jitbitSettingsSchema.parse(input.settings);
  const configuration = jitbitConfigurationSchema.parse({
    schemaVersion: 1,
    connectorType: "jitbit",
    settings,
    secrets: { [settings.apiTokenSecretName]: settings.apiTokenSecretName },
  });
  const client = new JitbitClient({
    configuration,
    secrets: input.secrets,
    fetch: input.fetch,
  });
  await client.getTicketSummaries({
    count: 1,
    offset: 0,
    signal: input.signal,
  });
}
