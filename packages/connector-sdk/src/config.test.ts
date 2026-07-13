import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createConnectorConfigurationSchema,
  redactConnectorConfiguration,
} from "./config.js";
import { createKnowledgeSourceConfigurationSchema } from "./source-configuration.js";

describe("connector configuration", () => {
  it("accepts secret references and redacts them from diagnostics", () => {
    const schema = createConnectorConfigurationSchema(
      z.object({ baseUrl: z.url() }).strict(),
    );
    const configuration = schema.parse({
      schemaVersion: 1,
      connectorType: "example",
      secrets: { apiToken: "vault:connector-token" },
      settings: { baseUrl: "https://connector.example.invalid" },
    });

    expect(redactConnectorConfiguration(configuration)).toEqual({
      schemaVersion: 1,
      connectorType: "example",
      secrets: { apiToken: "[redacted]" },
      settings: { baseUrl: "https://connector.example.invalid" },
    });
  });

  it("requires an explicit, versioned source synchronization policy", () => {
    const schema = createKnowledgeSourceConfigurationSchema(
      z.object({ state: z.enum(["resolved"]) }).strict(),
    );

    expect(
      schema.parse({
        schemaVersion: 1,
        connectorInstanceId: "helpdesk-1",
        capability: "knowledgeSource",
        enabled: true,
        knowledgeCollectionId: "resolved-cases",
        normalizationProfileVersion: "case-v1",
        chunkingProfileVersion: "historical-case-v1",
        synchronization: {
          triggers: [
            {
              mode: "cron",
              expression: "0 * * * *",
              timezone: "UTC",
              overlapPolicy: "skip",
              maximumDurationMs: 300_000,
            },
          ],
          incrementalCursor: { version: "cursor.v1", value: "47" },
        },
        deletion: { behavior: "tombstone", retentionDays: 30 },
        filters: { state: "resolved" },
      }).synchronization.incrementalCursor,
    ).toEqual({ version: "cursor.v1", value: "47" });
  });
});
