import { createHash, randomUUID } from "node:crypto";

import {
  canonicalizeConfiguration,
  parseConfigurationDescriptor,
  type ConfigurationDescriptorReference,
  sha256Base64Url,
  TransitionConfigurationVersion,
} from "@caseweaver/administration";
import type { AuditStore, UnitOfWork } from "@caseweaver/application";
import {
  auditEventId,
  principalId,
  sha256Digest,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import {
  PostgresConfigurationLifecycleStore,
  type PostgresTransactionLookup,
} from "@caseweaver/postgres";

import type {
  DescriptorConfigurationLifecycle,
  SessionBoundAdminRequestContext,
} from "./operation-dispatcher.js";

function objectSettings(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Administration configuration settings are invalid.");
  }
  return value as Readonly<Record<string, unknown>>;
}

function referenceFromVersion(
  input: Readonly<{
    readonly kind: string | null;
    readonly type: string | null;
    readonly version: string | null;
  }>,
): ConfigurationDescriptorReference | undefined {
  const values = [input.kind, input.type, input.version];
  if (values.every((value) => value === null)) return undefined;
  if (
    values.some((value) => value === null) ||
    (input.kind !== "connector" && input.kind !== "aiProvider")
  ) {
    throw new Error("Administration descriptor reference is invalid.");
  }
  return Object.freeze({
    kind: input.kind,
    type: input.type as string,
    version: input.version as string,
  });
}

function canonicalHash(value: string): ReturnType<typeof sha256Digest> {
  return sha256Digest(createHash("sha256").update(value, "utf8").digest("hex"));
}

/**
 * Composition adapter for a descriptor-backed configuration state change.
 * It reads the current immutable version inside the transaction and creates a
 * new version with the requested lifecycle. Existing jobs never observe a
 * rewritten configuration or secret-reference set.
 */
export class PostgresDescriptorConfigurationLifecycle
  implements DescriptorConfigurationLifecycle
{
  public constructor(
    private readonly dependencies: Readonly<{
      readonly unitOfWork: UnitOfWork & PostgresTransactionLookup;
      readonly auditStore: AuditStore;
      readonly eventId?: () => string;
      readonly now?: () => Date;
    }>,
  ) {}

  public async execute(
    input: Readonly<{
      readonly action: "configuration.activate" | "configuration.disable";
      readonly configurationId: string;
      readonly resourceType: "connector-instances" | "ai-provider-instances";
      readonly context: SessionBoundAdminRequestContext;
      readonly idempotencyKeyDigest: ReturnType<typeof sha256Digest>;
    }>,
  ): Promise<
    Readonly<{ readonly changed: boolean; readonly lifecycle: string }>
  > {
    const lifecycle =
      input.action === "configuration.activate" ? "active" : "disabled";
    return this.dependencies.unitOfWork.transaction(async (transaction) => {
      const database = this.dependencies.unitOfWork.get(transaction);
      const configuration =
        await database.administrationConfiguration.findUnique({
          where: {
            workspaceId_id: {
              workspaceId: input.context.workspaceId,
              id: input.configurationId,
            },
          },
          select: {
            id: true,
            resourceType: true,
            lifecycle: true,
            revision: true,
            currentVersionId: true,
          },
        });
      if (
        configuration === null ||
        configuration.resourceType !== input.resourceType ||
        configuration.currentVersionId === null
      ) {
        throw new Error("resource.notFound");
      }
      if (configuration.lifecycle === lifecycle) {
        return Object.freeze({ changed: false, lifecycle });
      }
      const version =
        await database.administrationConfigurationVersion.findUnique({
          where: { id: configuration.currentVersionId },
          select: {
            settings: true,
            secretReferences: true,
            displayName: true,
            descriptorKind: true,
            descriptorType: true,
            descriptorVersion: true,
          },
        });
      if (
        version === null ||
        !Array.isArray(version.secretReferences) ||
        !version.secretReferences.every((value) => typeof value === "string")
      ) {
        throw new Error("resource.notFound");
      }
      const referencedSecrets = [...new Set(version.secretReferences)];
      if (lifecycle === "active" && referencedSecrets.length > 0) {
        const activeReferences = await database.credentialRegistration.findMany(
          {
            where: {
              workspaceId: input.context.workspaceId,
              secretReference: { in: referencedSecrets },
              lifecycle: "active",
            },
            select: { secretReference: true },
          },
        );
        if (activeReferences.length !== referencedSecrets.length) {
          // Do not reveal which opaque locator is unavailable or revoked.
          throw new Error("secretReference.invalid");
        }
      }
      const settings = objectSettings(version.settings);
      const canonicalSettings = canonicalizeConfiguration(settings);
      const descriptor = referenceFromVersion({
        kind: version.descriptorKind,
        type: version.descriptorType,
        version: version.descriptorVersion,
      });
      const transition = new TransitionConfigurationVersion(
        { transaction: async (operation) => operation() },
        new PostgresConfigurationLifecycleStore(
          this.dependencies.unitOfWork,
          transaction,
        ),
        {
          append: async (audit) =>
            this.dependencies.auditStore.append(transaction, {
              id: auditEventId((this.dependencies.eventId ?? randomUUID)()),
              workspaceId: workspaceId(input.context.workspaceId),
              actorPrincipalId: principalId(input.context.principalId),
              action:
                input.action === "configuration.activate"
                  ? "admin.configuration.activated"
                  : "admin.configuration.disabled",
              targetId: input.configurationId,
              targetType: input.resourceType,
              permission: audit.permission,
              outcome: audit.outcome,
              ...(audit.beforeHash === undefined
                ? {}
                : { beforeHash: sha256Digest(audit.beforeHash) }),
              afterHash: sha256Digest(audit.afterHash),
              origin: "admin_ui",
              occurredAt: utcInstant(this.dependencies.now?.() ?? new Date()),
              requestId: input.context.requestId,
              correlationId: input.context.correlationId,
              idempotencyKeyDigest: input.idempotencyKeyDigest,
              ...(input.context.uiActionId === undefined
                ? {}
                : { uiActionId: input.context.uiActionId }),
            }),
        },
      );
      const transitioned = await transition.execute({
        workspaceId: input.context.workspaceId,
        configurationId: input.configurationId,
        resourceType: input.resourceType,
        expectedRevision: configuration.revision,
        settings,
        secretReferenceIds: version.secretReferences,
        ...(version.displayName === null
          ? {}
          : { displayName: version.displayName }),
        ...(descriptor === undefined ? {} : { descriptor }),
        lifecycle,
        beforeHash: canonicalHash(canonicalSettings),
        mutation: {
          operation: `admin.configuration.${lifecycle}`,
          keyDigest: input.idempotencyKeyDigest,
          requestDigest: sha256Base64Url(
            canonicalizeConfiguration({
              configurationId: input.configurationId,
              expectedRevision: configuration.revision,
              lifecycle,
              resourceType: input.resourceType,
            }),
          ),
        },
      });
      await this.projectRuntimeRegistration({
        database,
        workspaceId: input.context.workspaceId,
        configurationId: input.configurationId,
        resourceType: input.resourceType,
        lifecycle,
        descriptor,
        settings: objectSettings(
          JSON.parse(transitioned.version.canonicalSettings) as unknown,
        ),
        canonicalSettings: transitioned.version.canonicalSettings,
        versionId: transitioned.version.id,
        version: transitioned.version.version,
      });
      return Object.freeze({ changed: true, lifecycle });
    });
  }

  /**
   * Administration configurations are immutable control-plane records.  These
   * projections make an *active* descriptor-backed record usable by the
   * existing feature packages without giving those packages a dependency on
   * administration.  They are updated in the same transaction as the version
   * and audit event, so a source selector cannot see a half-activated
   * connector/provider.
   */
  private async projectRuntimeRegistration(
    input: Readonly<{
      readonly database: ReturnType<
        (UnitOfWork & PostgresTransactionLookup)["get"]
      >;
      readonly workspaceId: string;
      readonly configurationId: string;
      readonly resourceType: "connector-instances" | "ai-provider-instances";
      readonly lifecycle: "active" | "disabled";
      readonly descriptor: ConfigurationDescriptorReference | undefined;
      readonly settings: Readonly<Record<string, unknown>>;
      readonly canonicalSettings: string;
      readonly versionId: string;
      readonly version: number;
    }>,
  ): Promise<void> {
    if (input.descriptor === undefined) {
      throw new Error("Descriptor-backed configuration is invalid.");
    }
    const storedDescriptor =
      await input.database.administrationDescriptorRevision.findUnique({
        where: {
          kind_type_version: {
            kind: input.descriptor.kind,
            type: input.descriptor.type,
            version: input.descriptor.version,
          },
        },
        select: { descriptor: true },
      });
    if (storedDescriptor === null) {
      throw new Error("Descriptor-backed configuration is unavailable.");
    }
    const descriptor = parseConfigurationDescriptor(
      storedDescriptor.descriptor,
    );
    if (input.resourceType === "connector-instances") {
      if (descriptor.kind !== "connector") {
        throw new Error("Connector descriptor is invalid.");
      }
      if (
        typeof input.settings.connectorInstanceId !== "string" ||
        input.settings.connectorInstanceId !== input.configurationId
      ) {
        throw new Error("Connector instance identity is invalid.");
      }
      if (input.lifecycle === "disabled") {
        const updated = await input.database.connectorRegistration.updateMany({
          where: {
            workspaceId: input.workspaceId,
            id: input.configurationId,
          },
          data: { lifecycle: "disabled" },
        });
        if (updated.count === 0) {
          throw new Error("Connector runtime registration is unavailable.");
        }
        return;
      }
      await input.database.connectorRegistration.upsert({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.configurationId,
          },
        },
        create: {
          id: input.configurationId,
          workspaceId: input.workspaceId,
          lifecycle: "active",
          capabilities: {
            create: descriptor.connectorCapabilities.map((capability) => ({
              capability,
            })),
          },
        },
        update: {
          lifecycle: "active",
          capabilities: {
            deleteMany: {},
            create: descriptor.connectorCapabilities.map((capability) => ({
              capability,
            })),
          },
        },
      });
      return;
    }
    if (descriptor.kind !== "aiProvider") {
      throw new Error("AI provider descriptor is invalid.");
    }
    if (input.lifecycle === "disabled") {
      const updated = await input.database.aiProviderInstance.updateMany({
        where: { workspaceId: input.workspaceId, id: input.configurationId },
        data: { lifecycle: "disabled" },
      });
      if (updated.count === 0) {
        throw new Error("AI provider runtime registration is unavailable.");
      }
      return;
    }
    const endpoint = input.settings.endpoint;
    const secretReference = input.settings.secretReference;
    const wireApi = descriptor.supportedWireApis[0];
    if (
      typeof endpoint !== "string" ||
      typeof secretReference !== "string" ||
      wireApi === undefined
    ) {
      throw new Error("AI provider runtime settings are invalid.");
    }
    await input.database.aiProviderInstance.upsert({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: input.configurationId,
        },
      },
      create: {
        id: input.configurationId,
        workspaceId: input.workspaceId,
        providerType: descriptor.type,
        lifecycle: "active",
      },
      update: { providerType: descriptor.type, lifecycle: "active" },
    });
    await input.database.aiProviderInstanceVersion.upsert({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: input.versionId,
        },
      },
      create: {
        id: input.versionId,
        workspaceId: input.workspaceId,
        providerInstanceId: input.configurationId,
        version: input.version,
        endpoint,
        wireApi,
        parameters: JSON.parse(input.canonicalSettings),
        secretReference,
      },
      update: {},
    });
  }
}
