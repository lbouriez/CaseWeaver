import type { ConfigurationDescriptor } from "@caseweaver/administration";
import { z } from "zod";

const administrationSettingsSchema = z
  .object({
    endpoint: z.url().refine((value) => new URL(value).protocol === "https:"),
    secretReference: z.string().trim().min(1).max(500),
    maximumTurns: z.number().int().min(1).max(100).default(8),
    timeoutMs: z.number().int().min(1000).max(300000).default(120000),
  })
  .strict();

/** Safe discovery metadata for the optional BYOK repository-agent adapter. */
export const copilotSdkAgentAdministrationDescriptor: ConfigurationDescriptor =
  Object.freeze({
    kind: "aiProvider",
    type: "copilot-sdk-agent",
    version: "1",
    displayName: "Copilot SDK repository agent",
    description:
      "Optional BYOK repository-agent runtime with bounded, read-only tools and metered execution.",
    connectorCapabilities: [],
    aiCapabilities: ["repositoryAgent"],
    supportedWireApis: ["chatCompletions", "responses"],
    supportedWebhookEventTypes: [],
    settingsSchema: {
      type: "object",
      properties: {
        endpoint: {
          type: "string",
          title: "OpenAI-compatible HTTPS endpoint",
          format: "uri",
        },
        secretReference: {
          type: "string",
          title: "BYOK credential reference",
          description: "Reference only; never an API key.",
        },
        maximumTurns: { type: "integer", title: "Maximum turns" },
        timeoutMs: { type: "integer", title: "Timeout (ms)" },
      },
      required: ["endpoint", "secretReference"],
      additionalProperties: false,
    },
    uiGroups: [
      {
        id: "runtime",
        title: "Repository-agent runtime",
        fields: ["endpoint", "secretReference", "maximumTurns", "timeoutMs"],
        advanced: false,
      },
    ],
    secretSlots: [
      {
        name: "secretReference",
        label: "BYOK credential",
        required: true,
        acceptedReferenceKinds: ["external"],
        supportsRotation: true,
      },
    ],
    supportsConfigurationMigration: false,
    supportedTestOperations: ["provider.test"],
  } as const satisfies ConfigurationDescriptor);

export function validateCopilotSdkAgentAdministrationSettings(
  value: unknown,
): Record<string, unknown> {
  return administrationSettingsSchema.parse(value);
}
