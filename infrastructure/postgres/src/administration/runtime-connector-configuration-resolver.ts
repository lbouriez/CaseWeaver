import {
  parseConfigurationDescriptor,
  RuntimeConnectorConfigurationError,
  type RuntimeConnectorConfigurationResolver,
  type ServerPrivateConnectorConfiguration,
} from "@caseweaver/administration";
import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Resolves a connector configuration exclusively for trusted server-side
 * adapter composition. This is deliberately not an administration read model:
 * its settings and opaque credential locators must never cross an API, audit,
 * logging, diagnostics, or tracing boundary.
 */
export class PostgresRuntimeConnectorConfigurationResolver
  implements RuntimeConnectorConfigurationResolver
{
  public constructor(private readonly client: PrismaClient) {}

  public async resolve(
    input: Parameters<RuntimeConnectorConfigurationResolver["resolve"]>[0],
  ): Promise<ServerPrivateConnectorConfiguration | undefined> {
    try {
      return await this.client.$transaction(async (database) => {
        const connector = await database.connectorRegistration.findUnique({
          where: {
            workspaceId_id: {
              workspaceId: input.workspaceId,
              id: input.connectorRegistrationId,
            },
          },
          select: {
            lifecycle: true,
            capabilities: {
              where: { capability: input.requiredCapability },
              select: { capability: true },
            },
          },
        });
        if (
          connector === null ||
          connector.lifecycle !== "active" ||
          connector.capabilities.length !== 1
        ) {
          return undefined;
        }

        const configuration =
          await database.administrationConfiguration.findUnique({
            where: {
              workspaceId_id: {
                workspaceId: input.workspaceId,
                id: input.connectorRegistrationId,
              },
            },
            select: {
              resourceType: true,
              lifecycle: true,
              currentVersionId: true,
            },
          });
        if (
          configuration === null ||
          configuration.resourceType !== "connector-instances" ||
          configuration.lifecycle !== "active" ||
          configuration.currentVersionId === null
        ) {
          return undefined;
        }

        const selectedVersionId =
          input.configurationVersionId ?? configuration.currentVersionId;
        const version =
          await database.administrationConfigurationVersion.findUnique({
            where: {
              workspaceId_id: {
                workspaceId: input.workspaceId,
                id: selectedVersionId,
              },
            },
            select: {
              id: true,
              workspaceId: true,
              configurationId: true,
              settings: true,
              secretReferences: true,
              descriptorKind: true,
              descriptorType: true,
              descriptorVersion: true,
            },
          });
        if (version === null) {
          if (input.configurationVersionId === undefined) {
            throw new RuntimeConnectorConfigurationError();
          }
          return undefined;
        }
        if (version.configurationId !== input.connectorRegistrationId) {
          if (input.configurationVersionId === undefined) {
            throw new RuntimeConnectorConfigurationError();
          }
          return undefined;
        }

        const descriptorReference = parseDescriptorReference(version);
        const descriptorRevision =
          await database.administrationDescriptorRevision.findUnique({
            where: {
              kind_type_version: descriptorReference,
            },
            select: { descriptor: true },
          });
        if (descriptorRevision === null) {
          throw new RuntimeConnectorConfigurationError();
        }
        const descriptor = parseConfigurationDescriptor(
          descriptorRevision.descriptor,
        );
        if (
          descriptor.kind !== descriptorReference.kind ||
          descriptor.type !== descriptorReference.type ||
          descriptor.version !== descriptorReference.version
        ) {
          throw new RuntimeConnectorConfigurationError();
        }
        if (
          !descriptor.connectorCapabilities.includes(input.requiredCapability)
        ) {
          return undefined;
        }

        const settings = parseSettings(version.settings);
        const secretReferences = parseSecretReferences(
          version.secretReferences,
        );
        if (secretReferences.length > 0) {
          const activeCredentials =
            await database.credentialRegistration.findMany({
              where: {
                workspaceId: input.workspaceId,
                lifecycle: "active",
                secretReference: {
                  in: secretReferences.map(({ locator }) => locator),
                },
              },
              select: { secretReference: true },
            });
          if (
            activeCredentials.length !== secretReferences.length ||
            !sameValues(
              activeCredentials.map(({ secretReference }) => secretReference),
              secretReferences.map(({ locator }) => locator),
            )
          ) {
            return undefined;
          }
        }

        return Object.freeze({
          workspaceId: version.workspaceId,
          connectorRegistrationId: version.configurationId,
          configurationVersionId: version.id,
          descriptor: Object.freeze(descriptorReference),
          settings,
          secretReferences,
        });
      });
    } catch (error: unknown) {
      if (error instanceof RuntimeConnectorConfigurationError) throw error;
      throw new RuntimeConnectorConfigurationError();
    }
  }
}

function parseDescriptorReference(
  row: Readonly<{
    readonly descriptorKind: string | null;
    readonly descriptorType: string | null;
    readonly descriptorVersion: string | null;
  }>,
): Readonly<{
  readonly kind: "connector";
  readonly type: string;
  readonly version: string;
}> {
  if (
    row.descriptorKind !== "connector" ||
    !isIdentifier(row.descriptorType) ||
    !isIdentifier(row.descriptorVersion)
  ) {
    throw new RuntimeConnectorConfigurationError();
  }
  return Object.freeze({
    kind: "connector",
    type: row.descriptorType,
    version: row.descriptorVersion,
  });
}

function parseSettings(
  value: Prisma.JsonValue,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeConnectorConfigurationError();
  }
  return cloneJsonObject(value as Prisma.JsonObject);
}

function parseSecretReferences(
  value: Prisma.JsonValue,
): ReadonlyArray<Readonly<{ readonly locator: string }>> {
  if (
    !Array.isArray(value) ||
    value.length > 30 ||
    !value.every(isOpaqueLocator) ||
    new Set(value).size !== value.length
  ) {
    throw new RuntimeConnectorConfigurationError();
  }
  return Object.freeze(value.map((locator) => Object.freeze({ locator })));
}

function cloneJsonObject(
  value: Prisma.JsonObject,
): Readonly<Record<string, unknown>> {
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (entry === undefined) throw new RuntimeConnectorConfigurationError();
    clone[key] = cloneJson(entry);
  }
  return Object.freeze(clone);
}

function cloneJson(value: Prisma.JsonValue): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RuntimeConnectorConfigurationError();
    return value;
  }
  if (Array.isArray(value)) return Object.freeze(value.map(cloneJson));
  if (typeof value === "object")
    return cloneJsonObject(value as Prisma.JsonObject);
  throw new RuntimeConnectorConfigurationError();
}

function sameValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return (
    values.size === right.length && right.every((value) => values.has(value))
  );
}

function isOpaqueLocator(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 500;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)
  );
}
