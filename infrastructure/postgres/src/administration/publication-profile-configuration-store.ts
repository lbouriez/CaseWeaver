import { createHash } from "node:crypto";
import {
  AdministrationValidationError,
  type ConfigurationLifecycleStore,
  canonicalizeConfiguration,
  type PublicationProfileConfigurationProjection,
  type PublicationProfileConfigurationProjectionStore,
  parseConfigurationDescriptor,
} from "@caseweaver/administration";
import type { ApplicationTransaction } from "@caseweaver/application";
import { publicationProfileSchema } from "@caseweaver/publication";
import type { Prisma } from "@prisma/client";

import type { PostgresTransactionLookup } from "../index.js";
import { PostgresConfigurationLifecycleStore } from "./configuration-store.js";

/**
 * Transaction-bound bridge from immutable administration configuration versions
 * to PBI-012's immutable publication profile versions. It invokes the existing
 * publication schema rather than duplicating renderer, notice, or approval
 * policy. A PBI-012 version reuses the administration version id, giving every
 * publication intent an immutable configuration reference.
 */
export class PostgresPublicationProfileConfigurationStore
  implements PublicationProfileConfigurationProjectionStore
{
  private readonly configurations: PostgresConfigurationLifecycleStore;

  public constructor(
    private readonly transactions: PostgresTransactionLookup,
    private readonly transaction: ApplicationTransaction,
  ) {
    this.configurations = new PostgresConfigurationLifecycleStore(
      transactions,
      transaction,
    );
  }

  public createDraft: ConfigurationLifecycleStore["createDraft"] = (input) =>
    this.configurations.createDraft(input);

  public findMutation: ConfigurationLifecycleStore["findMutation"] = (input) =>
    this.configurations.findMutation(input);

  public loadVersion: ConfigurationLifecycleStore["loadVersion"] = (input) =>
    this.configurations.loadVersion(input);

  public transition: ConfigurationLifecycleStore["transition"] = (input) =>
    this.configurations.transition(input);

  public recordMutation: ConfigurationLifecycleStore["recordMutation"] = (
    input,
  ) => this.configurations.recordMutation(input);

  public async writePublicationProfile(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly lifecycle: "active" | "disabled";
      readonly profile: PublicationProfileConfigurationProjection;
    }>,
  ): Promise<void> {
    const database = this.transactions.get(this.transaction);
    const configuration = await database.administrationConfiguration.findUnique(
      {
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.profile.profileId,
          },
        },
        select: {
          resourceType: true,
          currentVersionId: true,
        },
      },
    );
    if (
      configuration === null ||
      configuration.resourceType !== "publication-profiles" ||
      configuration.currentVersionId !== input.configurationVersionId
    ) {
      throw new AdministrationValidationError();
    }
    const version = await database.administrationConfigurationVersion.findFirst(
      {
        where: {
          workspaceId: input.workspaceId,
          configurationId: input.profile.profileId,
          id: input.configurationVersionId,
        },
        select: { version: true, settings: true },
      },
    );
    if (version === null || !isJsonObject(version.settings)) {
      throw new AdministrationValidationError();
    }
    const parsed = publicationProfileSchema.safeParse(version.settings);
    if (
      !parsed.success ||
      parsed.data.id !== input.profile.profileId ||
      parsed.data.version !== String(version.version)
    ) {
      throw new AdministrationValidationError();
    }

    if (input.lifecycle === "disabled") {
      await database.publicationProfile.updateMany({
        where: {
          workspaceId: input.workspaceId,
          id: input.profile.profileId,
        },
        data: { lifecycle: "disabled" },
      });
      return;
    }

    const destinationConnectorConfigurationVersionId =
      await this.requireActiveDestination({
        workspaceId: input.workspaceId,
        connectorRegistrationId: parsed.data.destination.connectorInstanceId,
      });
    await database.publicationProfile.upsert({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: input.profile.profileId,
        },
      },
      create: {
        id: input.profile.profileId,
        workspaceId: input.workspaceId,
        lifecycle: "active",
      },
      update: { lifecycle: "active" },
    });
    await database.publicationProfileVersion.create({
      data: {
        id: input.configurationVersionId,
        workspaceId: input.workspaceId,
        publicationProfileId: input.profile.profileId,
        version: parsed.data.version,
        definitionHash: configurationHash(parsed.data),
        definition: json(parsed.data),
        destinationConnectorConfigurationVersionId,
      },
    });
  }

  private async requireActiveDestination(
    input: Readonly<{
      readonly workspaceId: string;
      readonly connectorRegistrationId: string;
    }>,
  ): Promise<string> {
    const database = this.transactions.get(this.transaction);
    // The matching lifecycle guard locks this same registration before a
    // connector can be disabled. This makes profile activation and disabling
    // the destination serializable under READ COMMITTED.
    const locked = await database.$queryRaw<readonly { readonly id: string }[]>`
      SELECT id
      FROM connector_registrations
      WHERE workspace_id = ${input.workspaceId}
        AND id = ${input.connectorRegistrationId}
      FOR UPDATE
    `;
    if (locked[0] === undefined) throw new AdministrationValidationError();

    const [connector, connectorConfiguration] = await Promise.all([
      database.connectorRegistration.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.connectorRegistrationId,
          },
        },
        select: {
          lifecycle: true,
          capabilities: { select: { capability: true } },
        },
      }),
      database.administrationConfiguration.findUnique({
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
      }),
    ]);
    if (
      connector === null ||
      connector.lifecycle !== "active" ||
      !connector.capabilities.some(
        (capability) => capability.capability === "analysisDestination",
      ) ||
      connectorConfiguration === null ||
      connectorConfiguration.resourceType !== "connector-instances" ||
      connectorConfiguration.lifecycle !== "active" ||
      connectorConfiguration.currentVersionId === null
    ) {
      throw new AdministrationValidationError();
    }
    const connectorVersion =
      await database.administrationConfigurationVersion.findFirst({
        where: {
          workspaceId: input.workspaceId,
          configurationId: input.connectorRegistrationId,
          id: connectorConfiguration.currentVersionId,
        },
        select: {
          descriptorKind: true,
          descriptorType: true,
          descriptorVersion: true,
        },
      });
    if (
      connectorVersion === null ||
      connectorVersion.descriptorKind !== "connector" ||
      connectorVersion.descriptorType === null ||
      connectorVersion.descriptorVersion === null
    ) {
      throw new AdministrationValidationError();
    }
    const storedDescriptor =
      await database.administrationDescriptorRevision.findUnique({
        where: {
          kind_type_version: {
            kind: connectorVersion.descriptorKind,
            type: connectorVersion.descriptorType,
            version: connectorVersion.descriptorVersion,
          },
        },
        select: { descriptor: true },
      });
    if (storedDescriptor === null) throw new AdministrationValidationError();
    let descriptor: ReturnType<typeof parseConfigurationDescriptor>;
    try {
      descriptor = parseConfigurationDescriptor(storedDescriptor.descriptor);
    } catch {
      throw new AdministrationValidationError();
    }
    if (
      descriptor.kind !== "connector" ||
      !descriptor.connectorCapabilities.includes("analysisDestination")
    ) {
      throw new AdministrationValidationError();
    }
    return connectorConfiguration.currentVersionId;
  }
}

function configurationHash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeConfiguration(value), "utf8")
    .digest("hex");
}

function json(value: unknown): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

function isJsonObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
