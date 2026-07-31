import type { ConfigurationDescriptor } from "@caseweaver/administration";
import { z } from "zod";

const administrationSettingsSchema = z
  .object({
    endpoint: z.url().refine((value) => new URL(value).protocol === "https:"),
    secretReference: z.string().trim().min(1).max(500),
    wireApi: z.enum(["embeddings", "chatCompletions", "responses"]),
    defaultTimeoutMs: z.number().int().min(1).max(300000).default(30000),
  })
  .strict();

/** Safe discovery metadata for the provider-neutral OpenAI-compatible adapter. */
export const openAiCompatibleAdministrationDescriptor: ConfigurationDescriptor =
  Object.freeze({
    kind: "aiProvider",
    type: "openai-compatible",
    // Earlier rows remain immutable history. Version 3 makes the protocol mode
    // explicit so a single endpoint can be configured as separate immutable
    // embedding and analysis instances without hidden first-item selection.
    version: "3",
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
        endpoint: {
          type: "string",
          title: "HTTPS endpoint",
          format: "uri",
          description:
            "The HTTPS base endpoint for the provider's OpenAI-compatible API. Use the provider base address, never a browser page, request URL, or credential-bearing URL.",
        },
        secretReference: {
          type: "string",
          title: "API credential reference",
          description:
            "Choose the registered secret location for this provider credential. The API key is never entered, returned, or displayed by the console.",
        },
        wireApi: {
          type: "string",
          title: "API capability",
          enum: ["embeddings", "chatCompletions", "responses"],
          description:
            "Select the OpenAI-compatible API family this immutable provider instance will use. Create a separate instance for embeddings and for chat or analysis; the server never guesses or switches protocol mode at runtime.",
        },
        defaultTimeoutMs: {
          type: "integer",
          title: "Default timeout (ms)",
          description:
            "Maximum time the execution gateway waits for a provider call before it is treated as unavailable. This is a default in milliseconds; request-specific server limits still apply.",
        },
      },
      required: ["endpoint", "secretReference", "wireApi"],
      additionalProperties: false,
    },
    uiGroups: [
      {
        id: "connection",
        title: "Connection",
        fields: ["endpoint", "secretReference", "wireApi", "defaultTimeoutMs"],
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
