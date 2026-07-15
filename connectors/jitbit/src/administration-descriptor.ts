import type { ConfigurationDescriptor } from "@caseweaver/administration";

import { jitbitSettingsSchema } from "./config.js";

/** Safe discovery metadata; `jitbitSettingsSchema` remains authoritative. */
export const jitbitAdministrationDescriptor: ConfigurationDescriptor =
  Object.freeze({
    kind: "connector",
    type: "jitbit",
    version: "1",
    displayName: "Jitbit",
    description:
      "Imports Jitbit tickets as cases and knowledge, and publishes approved analysis output.",
    connectorCapabilities: [
      "knowledgeSource",
      "caseSource",
      "analysisDestination",
    ],
    aiCapabilities: [],
    supportedWireApis: [],
    supportedWebhookEventTypes: [],
    settingsSchema: {
      type: "object",
      properties: {
        baseUrl: {
          type: "string",
          title: "Jitbit HTTPS base URL",
          format: "uri",
        },
        apiTokenReference: {
          type: "string",
          title: "API token secret reference",
          description:
            "A reference in the configured secret backend; never the token value.",
        },
        timeoutMs: { type: "integer", title: "Timeout (ms)" },
        discoveryPageSize: { type: "integer", title: "Discovery page size" },
        maximumTicketCharacters: {
          type: "integer",
          title: "Maximum ticket characters",
        },
        initialUpdatedFrom: {
          type: "string",
          title: "Initial update boundary",
          format: "date",
        },
        updatedFromOverlapDays: {
          type: "integer",
          title: "Update overlap days",
        },
      },
      required: ["baseUrl", "apiTokenReference"],
      additionalProperties: false,
    },
    uiGroups: [
      {
        id: "connection",
        title: "Connection",
        fields: ["baseUrl", "apiTokenReference", "timeoutMs"],
        advanced: false,
      },
      {
        id: "synchronization",
        title: "Synchronization",
        fields: [
          "discoveryPageSize",
          "maximumTicketCharacters",
          "initialUpdatedFrom",
          "updatedFromOverlapDays",
        ],
        advanced: true,
      },
    ],
    secretSlots: [
      {
        name: "apiTokenReference",
        label: "Jitbit API token",
        required: true,
        acceptedReferenceKinds: ["external"],
        supportsRotation: true,
      },
    ],
    supportsConfigurationMigration: false,
    supportedTestOperations: ["connector.test"],
  } as const satisfies ConfigurationDescriptor);

/** Converts the safe console shape into this adapter's runtime-owned settings. */
export function validateJitbitAdministrationSettings(
  value: unknown,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Jitbit configuration.");
  }
  const source = value as Record<string, unknown>;
  const { apiTokenReference, ...settings } = source;
  return jitbitSettingsSchema.parse({
    ...settings,
    apiTokenSecretName: apiTokenReference,
  }) as Record<string, unknown>;
}
