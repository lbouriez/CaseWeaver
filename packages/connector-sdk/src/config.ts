import { z } from "zod";

import {
  ConnectorCancelledError,
  ConnectorConfigurationError,
} from "./errors.js";
import {
  secretReferenceSchema,
  type ConnectorSecretReference,
} from "./primitives.js";

const configurationSchemaVersion = 1 as const;

export interface ConnectorConfiguration<TSettings> {
  readonly schemaVersion: typeof configurationSchemaVersion;
  readonly connectorType: string;
  readonly secrets: Readonly<Record<string, ConnectorSecretReference>>;
  readonly settings: TSettings;
}

export interface RedactedConnectorConfiguration<TSettings> {
  readonly schemaVersion: typeof configurationSchemaVersion;
  readonly connectorType: string;
  readonly secrets: Readonly<Record<string, "[redacted]">>;
  readonly settings: TSettings;
}

/**
 * Connector configuration envelopes contain references to secrets. The settings schema
 * is connector-owned and must never model plaintext credentials.
 */
export function createConnectorConfigurationSchema<TSettings extends z.ZodType>(
  settingsSchema: TSettings,
) {
  return z
    .object({
      schemaVersion: z.literal(configurationSchemaVersion),
      connectorType: z.string().min(1).max(100),
      secrets: z.record(z.string().min(1).max(100), secretReferenceSchema),
      settings: settingsSchema,
    })
    .strict();
}

export function redactConnectorConfiguration<TSettings>(
  configuration: ConnectorConfiguration<TSettings>,
): RedactedConnectorConfiguration<TSettings> {
  const redactedSecrets: Record<string, "[redacted]"> = {};
  for (const name of Object.keys(configuration.secrets)) {
    redactedSecrets[name] = "[redacted]";
  }

  return Object.freeze({
    schemaVersion: configuration.schemaVersion,
    connectorType: configuration.connectorType,
    secrets: Object.freeze(redactedSecrets),
    settings: configuration.settings,
  });
}

export interface ResolvedSecret {
  readonly value: string;
}

export interface ConnectorSecretResolver {
  resolve(
    reference: ConnectorSecretReference,
    signal: AbortSignal,
  ): Promise<ResolvedSecret>;
}

/**
 * A deterministic resolver for connector tests and local development. Calls retain
 * only secret references, never resolved values.
 */
export class InMemoryConnectorSecretResolver
  implements ConnectorSecretResolver
{
  public readonly calls: ConnectorSecretReference[] = [];

  public constructor(
    private readonly secrets: Readonly<Record<string, string>>,
  ) {}

  public async resolve(
    reference: ConnectorSecretReference,
    signal: AbortSignal,
  ): Promise<ResolvedSecret> {
    if (signal.aborted) {
      throw new ConnectorCancelledError();
    }

    this.calls.push(reference);
    const value = this.secrets[reference];
    if (value === undefined) {
      throw new ConnectorConfigurationError(
        "A configured connector secret could not be resolved.",
      );
    }

    return Object.freeze({ value });
  }
}
