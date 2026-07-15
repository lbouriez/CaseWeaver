import type { ConfigurationDescriptor } from "@caseweaver/administration";

import { gitMarkdownSettingsSchema } from "./config.js";

/** Safe discovery metadata; `gitMarkdownSettingsSchema` remains authoritative. */
export const gitMarkdownAdministrationDescriptor: ConfigurationDescriptor =
  Object.freeze({
    kind: "connector",
    type: "git-markdown",
    version: "1",
    displayName: "Git / Markdown",
    description:
      "Indexes Markdown and Docusaurus content from a pinned local or remote Git repository.",
    connectorCapabilities: ["knowledgeSource"],
    aiCapabilities: [],
    supportedWireApis: [],
    supportedWebhookEventTypes: [],
    settingsSchema: {
      type: "object",
      properties: {
        repository: {
          type: "object",
          title: "Repository",
          description:
            "JSON: local {kind, path} or remote {kind, url}. Local paths are validated against trusted roots.",
          format: "json",
        },
        allowedLocalRoots: {
          type: "array",
          title: "Allowed local roots",
          description: "One absolute trusted filesystem root per line.",
        },
        ref: {
          type: "object",
          title: "Git reference",
          description: "JSON: {kind: branch|tag, name: safe-reference}.",
          format: "json",
        },
        browserUrl: { type: "string", title: "Browser URL", format: "uri" },
        gitTokenReference: {
          type: "string",
          title: "Git token secret reference",
          description:
            "Optional external secret reference; never a token value.",
        },
        paths: {
          type: "object",
          title: "Path filters",
          description:
            "JSON with include and optional exclude relative POSIX glob arrays.",
          format: "json",
        },
        maximumMarkdownCharacters: {
          type: "integer",
          title: "Maximum Markdown characters",
        },
        docusaurus: {
          type: "object",
          title: "Docusaurus settings",
          description:
            "JSON with enabled, siteUrl, baseUrl, routeBasePath, and docsPath.",
          format: "json",
        },
      },
      required: ["repository", "ref"],
      additionalProperties: false,
    },
    uiGroups: [
      {
        id: "repository",
        title: "Repository",
        fields: [
          "repository",
          "allowedLocalRoots",
          "ref",
          "browserUrl",
          "gitTokenReference",
        ],
        advanced: false,
      },
      {
        id: "content",
        title: "Content",
        fields: ["paths", "maximumMarkdownCharacters", "docusaurus"],
        advanced: true,
      },
    ],
    secretSlots: [
      {
        name: "gitTokenReference",
        label: "Git token",
        required: false,
        acceptedReferenceKinds: ["external"],
        supportsRotation: true,
      },
    ],
    supportsConfigurationMigration: false,
    supportedTestOperations: ["connector.test"],
  } as const satisfies ConfigurationDescriptor);

/** Converts the safe console shape into this adapter's runtime-owned settings. */
export function validateGitMarkdownAdministrationSettings(
  value: unknown,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Git/Markdown configuration.");
  }
  const source = value as Record<string, unknown>;
  const { gitTokenReference, ...settings } = source;
  const authentication =
    typeof gitTokenReference === "string" && gitTokenReference.trim().length > 0
      ? { kind: "token" as const, secretName: gitTokenReference.trim() }
      : { kind: "none" as const };
  return gitMarkdownSettingsSchema.parse({
    ...settings,
    authentication,
  }) as Record<string, unknown>;
}
