import type { ConfigurationDescriptor } from "@caseweaver/administration";
import {
  gitMarkdownAdministrationDescriptor,
  validateGitMarkdownAdministrationSettings,
} from "@caseweaver/connector-git-markdown";
import {
  jitbitAdministrationDescriptor,
  validateJitbitAdministrationSettings,
} from "@caseweaver/connector-jitbit";
import {
  copilotSdkAgentAdministrationDescriptor,
  validateCopilotSdkAgentAdministrationSettings,
} from "@caseweaver/copilot-sdk-agent";
import {
  openAiCompatibleAdministrationDescriptor,
  validateOpenAiCompatibleAdministrationSettings,
} from "@caseweaver/openai-compatible";

export interface RuntimeDescriptorRegistration {
  readonly descriptor: ConfigurationDescriptor;
  /** Adapter-owned runtime validation. No UI or administration branch names a vendor. */
  validateSettings(value: unknown): Readonly<Record<string, unknown>>;
  /** Safe references are retained as immutable version metadata, never resolved. */
  secretReferenceIds(
    settings: Readonly<Record<string, unknown>>,
  ): readonly string[];
}

function reference(value: unknown): readonly string[] {
  return typeof value === "string" && value.trim().length > 0
    ? Object.freeze([value.trim()])
    : Object.freeze([]);
}

function gitReferences(
  settings: Readonly<Record<string, unknown>>,
): readonly string[] {
  const authentication = settings.authentication;
  if (
    authentication === null ||
    typeof authentication !== "object" ||
    Array.isArray(authentication)
  ) {
    return Object.freeze([]);
  }
  return reference((authentication as Record<string, unknown>).secretName);
}

/**
 * Composition registry. Adding another connector/provider means adding its
 * registration here; the shared UI and administration use cases do not branch
 * on a type name and receive only safe descriptor data from this collection.
 */
export const runtimeDescriptorRegistrations: readonly RuntimeDescriptorRegistration[] =
  Object.freeze([
    Object.freeze({
      descriptor: gitMarkdownAdministrationDescriptor,
      validateSettings: validateGitMarkdownAdministrationSettings,
      secretReferenceIds: gitReferences,
    }),
    Object.freeze({
      descriptor: jitbitAdministrationDescriptor,
      validateSettings: validateJitbitAdministrationSettings,
      secretReferenceIds: (settings: Readonly<Record<string, unknown>>) =>
        reference(settings.apiTokenSecretName),
    }),
    Object.freeze({
      descriptor: openAiCompatibleAdministrationDescriptor,
      validateSettings: validateOpenAiCompatibleAdministrationSettings,
      secretReferenceIds: (settings: Readonly<Record<string, unknown>>) =>
        reference(settings.secretReference),
    }),
    Object.freeze({
      descriptor: copilotSdkAgentAdministrationDescriptor,
      validateSettings: validateCopilotSdkAgentAdministrationSettings,
      secretReferenceIds: (settings: Readonly<Record<string, unknown>>) =>
        reference(settings.secretReference),
    }),
  ]);

export function runtimeDescriptorRegistration(
  kind: ConfigurationDescriptor["kind"],
  type: string,
): RuntimeDescriptorRegistration | undefined {
  return runtimeDescriptorRegistrations.find(
    (registration) =>
      registration.descriptor.kind === kind &&
      registration.descriptor.type === type,
  );
}
