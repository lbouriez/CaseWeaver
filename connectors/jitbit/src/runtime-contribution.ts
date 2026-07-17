import type {
  ConfigurationDescriptorReference,
  ServerPrivateConnectorConfiguration,
} from "@caseweaver/administration";
import type {
  ConnectorRuntimeCapabilities,
  ConnectorRuntimeContribution,
} from "@caseweaver/connector-runtime";
import { ConnectorConfigurationError } from "@caseweaver/connector-sdk";

import { JitbitClient } from "./client.js";
import {
  type JitbitConfiguration,
  jitbitConfigurationSchema,
  jitbitSettingsSchema,
} from "./config.js";
import { JitbitAttachmentSource } from "./jitbit-attachment-source.js";
import { JitbitCaseSource } from "./jitbit-case-source.js";
import { JitbitAnalysisDestination } from "./jitbit-destination.js";
import { JitbitKnowledgeSource } from "./jitbit-knowledge-source.js";

type JitbitRuntimeDescriptor = Readonly<{
  readonly kind: "connector";
  readonly type: "jitbit";
  readonly version: "1" | "2" | "3" | "4";
}>;

const legacyDescriptorReference = Object.freeze({
  kind: "connector",
  type: "jitbit",
  version: "1",
} satisfies JitbitRuntimeDescriptor);

const versionTwoDescriptorReference = Object.freeze({
  kind: "connector",
  type: "jitbit",
  version: "2",
} satisfies JitbitRuntimeDescriptor);

const versionThreeDescriptorReference = Object.freeze({
  kind: "connector",
  type: "jitbit",
  version: "3",
} satisfies JitbitRuntimeDescriptor);

const currentDescriptorReference = Object.freeze({
  kind: "connector",
  type: "jitbit",
  version: "4",
} satisfies JitbitRuntimeDescriptor);

export interface CreateJitbitRuntimeContributionOptions {
  /** Injectable only for deterministic adapter tests. Production uses global fetch. */
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

/**
 * Builds Jitbit's declared ports from an exact, private immutable configuration
 * version. It does not resolve a secret while constructing the contribution:
 * the existing client resolves it only for an outbound request and propagates
 * the command's cancellation signal.
 */
export function createJitbitRuntimeContribution(
  options: CreateJitbitRuntimeContributionOptions,
): ConnectorRuntimeContribution {
  return contribution(options, currentDescriptorReference);
}

/**
 * Retains exact descriptor revision-one execution for already durable work.
 */
export function createLegacyJitbitRuntimeContribution(
  options: CreateJitbitRuntimeContributionOptions,
): ConnectorRuntimeContribution {
  return contribution(options, legacyDescriptorReference);
}

/** Retains descriptor version two execution for durable historical work. */
export function createVersionTwoJitbitRuntimeContribution(
  options: CreateJitbitRuntimeContributionOptions,
): ConnectorRuntimeContribution {
  return contribution(options, versionTwoDescriptorReference);
}

/** Retains descriptor version three execution for durable historical work. */
export function createVersionThreeJitbitRuntimeContribution(
  options: CreateJitbitRuntimeContributionOptions,
): ConnectorRuntimeContribution {
  return contribution(options, versionThreeDescriptorReference);
}

/** Register every retained immutable descriptor revision with trusted composition. */
export function createJitbitRuntimeContributions(
  options: CreateJitbitRuntimeContributionOptions,
): readonly ConnectorRuntimeContribution[] {
  return Object.freeze([
    createLegacyJitbitRuntimeContribution(options),
    createVersionTwoJitbitRuntimeContribution(options),
    createVersionThreeJitbitRuntimeContribution(options),
    createJitbitRuntimeContribution(options),
  ]);
}

function contribution(
  options: CreateJitbitRuntimeContributionOptions,
  descriptor: JitbitRuntimeDescriptor,
): ConnectorRuntimeContribution {
  return Object.freeze({
    descriptor,
    async create({
      configuration,
      secrets,
    }: Parameters<
      ConnectorRuntimeContribution["create"]
    >[0]): Promise<ConnectorRuntimeCapabilities> {
      const parsed = parseRuntimeConfiguration(configuration, descriptor);
      const client = new JitbitClient({
        configuration: parsed,
        secrets,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      return Object.freeze({
        knowledgeSource: new JitbitKnowledgeSource({
          configuration: parsed,
          client,
          ...(options.now === undefined ? {} : { now: options.now }),
        }),
        caseSource: new JitbitCaseSource({
          configuration: parsed,
          client,
          ...(options.now === undefined ? {} : { now: options.now }),
        }),
        attachmentSource: new JitbitAttachmentSource({
          configuration: parsed,
          client,
        }),
        analysisDestination: new JitbitAnalysisDestination({
          configuration: parsed,
          client,
        }),
      });
    },
  });
}

function parseRuntimeConfiguration(
  configuration: ServerPrivateConnectorConfiguration,
  descriptor: JitbitRuntimeDescriptor,
): JitbitConfiguration {
  try {
    if (!sameDescriptor(configuration.descriptor, descriptor)) {
      throw runtimeUnavailable();
    }
    const settings = normalizeSettings(
      descriptor.version,
      configuration.settings,
    );
    const parsedSettings = jitbitSettingsSchema.parse(settings);
    const secretReference = parsedSettings.apiTokenSecretName;
    if (!hasOnlyExpectedSecretReference(configuration, secretReference)) {
      throw runtimeUnavailable();
    }
    return jitbitConfigurationSchema.parse({
      schemaVersion: 1,
      connectorType: "jitbit",
      settings: parsedSettings,
      secrets: { [secretReference]: secretReference },
    });
  } catch (error) {
    if (error instanceof ConnectorConfigurationError) throw error;
    throw runtimeUnavailable();
  }
}

function sameDescriptor(
  left: ConfigurationDescriptorReference,
  right: JitbitRuntimeDescriptor,
): boolean {
  return (
    left.kind === right.kind &&
    left.type === right.type &&
    left.version === right.version
  );
}

function normalizeSettings(
  descriptorVersion: string,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (descriptorVersion !== "1") return value;
  const legacyTimeout = value.timeoutMs;
  if (legacyTimeout === undefined) return value;
  const { timeoutMs: _timeoutMs, ...settings } = value;
  if (settings.requestTimeoutMs !== undefined) throw runtimeUnavailable();
  return Object.freeze({ ...settings, requestTimeoutMs: legacyTimeout });
}

function hasOnlyExpectedSecretReference(
  configuration: ServerPrivateConnectorConfiguration,
  expected: string,
): boolean {
  return (
    configuration.secretReferences.length === 1 &&
    configuration.secretReferences[0]?.locator === expected
  );
}

function runtimeUnavailable(): ConnectorConfigurationError {
  return new ConnectorConfigurationError(
    "The configured Jitbit runtime is unavailable.",
  );
}
