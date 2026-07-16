import type { ConfigurationDescriptor } from "@caseweaver/administration";

import { jitbitSettingsSchema } from "./config.js";

function descriptor(
  version: "1" | "2",
  timeoutField: "timeoutMs" | "requestTimeoutMs",
): ConfigurationDescriptor {
  return Object.freeze({
    kind: "connector",
    type: "jitbit",
    version,
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
        [timeoutField]: { type: "integer", title: "Timeout (ms)" },
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
        fields: ["baseUrl", "apiTokenReference", timeoutField],
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
}

/**
 * Immutable descriptor retained for existing installations. Its `timeoutMs`
 * field did not match the authoritative connector schema, so it is never
 * registered for new drafts.
 */
export const legacyJitbitAdministrationDescriptor: ConfigurationDescriptor =
  descriptor("1", "timeoutMs");

/**
 * Safe discovery metadata for new drafts. `jitbitSettingsSchema` remains the
 * authoritative runtime validator.
 */
export const jitbitAdministrationDescriptor: ConfigurationDescriptor =
  descriptor("2", "requestTimeoutMs");

/** Descriptor revisions this adapter can execute for immutable durable work. */
export const jitbitAdministrationDescriptorRevisions: readonly ConfigurationDescriptor[] =
  Object.freeze([
    legacyJitbitAdministrationDescriptor,
    jitbitAdministrationDescriptor,
  ]);

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
