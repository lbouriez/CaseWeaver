import type { ConfigurationDescriptor } from "@caseweaver/administration";
import { z } from "zod";

const administrationSettingsSchema = z
  .object({
    endpoint: z.url().refine((value) => new URL(value).protocol === "https:"),
    secretReference: z.string().trim().min(1).max(500),
    defaultTimeoutMs: z.number().int().min(1).max(300000).default(30000),
  })
  .strict();

/** Safe discovery metadata for the provider-neutral OpenAI-compatible adapter. */
export const openAiCompatibleAdministrationDescriptor: ConfigurationDescriptor =
  Object.freeze({
    kind: "aiProvider",
    type: "openai-compatible",
    version: "1",
    displayName: "OpenAI-compatible",
    description:
      "Uses a configured OpenAI-compatible HTTPS endpoint through the metered AI execution gateway.",
    connectorCapabilities: [],
    aiCapabilities: ["embedding", "vision", "analysis", "chat"],
    supportedWireApis: ["embeddings", "chatCompletions", "responses"],
    supportedWebhookEventTypes: [],
    settingsSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string", title: "HTTPS endpoint", format: "uri" },
        secretReference: {
          type: "string",
          title: "API credential reference",
          description: "Reference only; never an API key.",
        },
        defaultTimeoutMs: { type: "integer", title: "Default timeout (ms)" },
      },
      required: ["endpoint", "secretReference"],
      additionalProperties: false,
    },
    uiGroups: [
      {
        id: "connection",
        title: "Connection",
        fields: ["endpoint", "secretReference", "defaultTimeoutMs"],
        advanced: false,
      },
    ],
    secretSlots: [
      {
        name: "secretReference",
        label: "Provider API credential",
        required: true,
        acceptedReferenceKinds: ["external"],
        supportsRotation: true,
      },
    ],
    supportsConfigurationMigration: false,
    supportedTestOperations: ["provider.test"],
  } as const satisfies ConfigurationDescriptor);

export function validateOpenAiCompatibleAdministrationSettings(
  value: unknown,
): Record<string, unknown> {
  return administrationSettingsSchema.parse(value);
}
