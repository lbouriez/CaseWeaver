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
    // Existing version 1 rows remain immutable configuration history. Version
    // 2 improves only the safe operator guidance presented by the console.
    version: "2",
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
          description:
            "The HTTPS base endpoint for the BYOK-compatible service. Use a configured API base address, not a repository URL, browser page, or credential-bearing URL.",
        },
        secretReference: {
          type: "string",
          title: "BYOK credential reference",
          description:
            "Choose the registered secret location containing the BYOK credential. The credential is never entered or displayed in the browser.",
        },
        maximumTurns: {
          type: "integer",
          title: "Maximum turns",
          description:
            "Upper bound on the agent's bounded reasoning/tool turns for one request. Lower values constrain work and cost; the server enforces the final limit.",
        },
        timeoutMs: {
          type: "integer",
          title: "Timeout (ms)",
          description:
            "Maximum duration for one repository-agent request in milliseconds. The runtime cancels work after this limit and retains no browser-provided secret data.",
        },
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
