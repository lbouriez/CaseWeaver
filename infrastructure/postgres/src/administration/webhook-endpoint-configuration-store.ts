import {
  AdministrationValidationError,
  type ConfigurationLifecycleStore,
  parseConfigurationDescriptor,
  type WebhookEndpointConfigurationProjection,
  type WebhookEndpointConfigurationProjectionStore,
} from "@caseweaver/administration";
import type { ApplicationTransaction } from "@caseweaver/application";
import type { Prisma } from "@prisma/client";

import type { PostgresTransactionLookup } from "../index.js";
import { PostgresConfigurationLifecycleStore } from "./configuration-store.js";

/**
 * Transaction-bound endpoint projection. Generic administration versions remain
 * the authority for settings and opaque secret locators; this projection stores
 * only the safe opaque routing identity, limits, selected connector, and the
 * exact immutable configuration version that made the endpoint usable.
 */
export class PostgresWebhookEndpointConfigurationStore
  implements WebhookEndpointConfigurationProjectionStore
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

  public async writeWebhookEndpoint(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly lifecycle: "active" | "disabled";
      readonly endpoint: WebhookEndpointConfigurationProjection;
    }>,
  ): Promise<void> {
    const database = this.transactions.get(this.transaction);
    const configuration = await database.administrationConfiguration.findUnique(
      {
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.endpoint.endpointId,
          },
        },
        select: {
          resourceType: true,
          lifecycle: true,
          currentVersionId: true,
        },
      },
    );
    if (
      configuration === null ||
      configuration.resourceType !== "webhook-endpoints" ||
      configuration.currentVersionId !== input.configurationVersionId ||
      configuration.lifecycle !== input.lifecycle
    ) {
      throw new AdministrationValidationError();
    }
    const configurationVersion =
      await database.administrationConfigurationVersion.findFirst({
        where: {
          workspaceId: input.workspaceId,
          configurationId: input.endpoint.endpointId,
          id: input.configurationVersionId,
        },
        select: { id: true },
      });
    if (configurationVersion === null) {
      throw new AdministrationValidationError();
    }

    if (input.lifecycle === "active") {
      await this.requireActiveWebhookConnector({
        workspaceId: input.workspaceId,
        connectorRegistrationId: input.endpoint.connectorRegistrationId,
        verifiedEventTypes: input.endpoint.verifiedEventTypes,
      });
      await database.webhookEndpoint.upsert({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.endpoint.endpointId,
          },
        },
        create: endpointData(input),
        update: endpointData(input),
      });
      return;
    }

    // A disabled draft has no routable endpoint row. Once active, a disablement
    // advances the projection to its successor immutable configuration version.
    await database.webhookEndpoint.updateMany({
      where: {
        workspaceId: input.workspaceId,
        id: input.endpoint.endpointId,
      },
      data: endpointData(input),
    });
  }

  private async requireActiveWebhookConnector(
    input: Readonly<{
      readonly workspaceId: string;
      readonly connectorRegistrationId: string;
      readonly verifiedEventTypes: readonly string[];
    }>,
  ): Promise<void> {
    const database = this.transactions.get(this.transaction);
    // Serialize this activation against a concurrent connector lifecycle change.
    // The matching inverse database guard is also required at migration level.
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
        (capability) => capability.capability === "webhookAdapter",
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
      !descriptor.connectorCapabilities.includes("webhookAdapter") ||
      !input.verifiedEventTypes.every((eventType) =>
        descriptor.supportedWebhookEventTypes.includes(eventType),
      )
    ) {
      throw new AdministrationValidationError();
    }
  }
}

function endpointData(
  input: Readonly<{
    readonly workspaceId: string;
    readonly configurationVersionId: string;
    readonly lifecycle: "active" | "disabled";
    readonly endpoint: WebhookEndpointConfigurationProjection;
  }>,
): Readonly<{
  readonly id: string;
  readonly workspaceId: string;
  readonly lifecycle: "active" | "disabled";
  readonly connectorInstanceId: string;
  readonly configurationVersionId: string;
  readonly verifiedEventTypes: Prisma.InputJsonArray;
  readonly maximumBodyBytes: number;
  readonly maximumRequestsPerMinute: number;
  readonly analysisTriggerId?: string;
}> {
  return Object.freeze({
    id: input.endpoint.endpointId,
    workspaceId: input.workspaceId,
    lifecycle: input.lifecycle,
    connectorInstanceId: input.endpoint.connectorRegistrationId,
    configurationVersionId: input.configurationVersionId,
    verifiedEventTypes: [...input.endpoint.verifiedEventTypes],
    maximumBodyBytes: input.endpoint.maximumBodyBytes,
    maximumRequestsPerMinute: input.endpoint.maximumRequestsPerMinute,
    ...(input.endpoint.analysisTriggerId === undefined
      ? {}
      : { analysisTriggerId: input.endpoint.analysisTriggerId }),
  });
}
