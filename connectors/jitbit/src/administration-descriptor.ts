import type { ConfigurationDescriptor } from "@caseweaver/administration";

import { jitbitSettingsSchema } from "./config.js";

function descriptor(
  version: "1" | "2" | "3",
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
          description:
            "The HTTPS address of the Jitbit installation CaseWeaver will contact. Use the installation base address, not a ticket page or a URL containing credentials.",
        },
        apiTokenReference: {
          type: "string",
          title: "API token secret reference",
          description:
            "Choose the registered secret location that holds the Jitbit API token. The token itself is never entered or displayed in this console.",
        },
        [timeoutField]: {
          type: "integer",
          title: "Timeout (ms)",
          description:
            "Maximum time CaseWeaver waits for one Jitbit request before treating it as unavailable. This limit is expressed in milliseconds.",
        },
        discoveryPageSize: {
          type: "integer",
          title: "Discovery page size",
          description:
            "Number of ticket summaries requested per discovery page. Larger pages reduce round trips but make each bounded request heavier.",
        },
        maximumTicketCharacters: {
          type: "integer",
          title: "Maximum ticket characters",
          description:
            "Safety limit for the text retained from a single ticket. Longer tickets are bounded before downstream processing to keep work and costs predictable.",
        },
        initialUpdatedFrom: {
          type: "string",
          title: "Initial update boundary",
          format: "date",
          description:
            "Optional date for the first import only. After a completed synchronization, CaseWeaver uses its durable cursor instead of this bootstrap boundary.",
        },
        updatedFromOverlapDays: {
          type: "integer",
          title: "Update overlap days",
          description:
            "Extra days re-read on each incremental synchronization. This protects ticket updates that share Jitbit's date-granular timestamp; duplicate work is reconciled by the server.",
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
  // Version 2 remains immutable in existing installations. Version 3 adds
  // operator-facing guidance without altering the runtime settings shape.
  descriptor("3", "requestTimeoutMs");

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
