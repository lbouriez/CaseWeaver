import {
  type ConfigurationLifecycleStore,
  canonicalizeConfiguration,
  type KnowledgeScheduleConfigurationProjection,
  type KnowledgeSourceConfigurationProjection,
  type SourceScheduleConfigurationProjectionStore,
} from "@caseweaver/administration";
import { createHash } from "node:crypto";
import type { ApplicationTransaction } from "@caseweaver/application";
import type { Prisma } from "@prisma/client";

import type { PostgresTransactionLookup } from "../index.js";
import { PostgresConfigurationLifecycleStore } from "./configuration-store.js";

/**
 * Transaction-bound projection store for source and schedule administration.
 * Immutable configuration rows remain the authority; this adapter only creates
 * the read models consumed by the existing knowledge and scheduling packages.
 */
export class PostgresSourceScheduleConfigurationStore
  implements SourceScheduleConfigurationProjectionStore
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

  public async writeKnowledgeSource(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly lifecycle: "enabled" | "disabled";
      readonly source: KnowledgeSourceConfigurationProjection;
    }>,
  ): Promise<void> {
    const database = this.transactions.get(this.transaction);
    await this.requireConfigurationVersion({
      workspaceId: input.workspaceId,
      resourceType: "knowledge-sources",
      configurationId: input.source.sourceId,
      versionId: input.configurationVersionId,
    });
    const connectorConfigurationVersionId =
      await this.resolveActiveKnowledgeConnectorVersion({
        workspaceId: input.workspaceId,
        connectorRegistrationId: input.source.connectorRegistrationId,
      });
    const collection = await database.knowledgeCollection.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: input.source.knowledgeCollectionId,
        },
      },
      select: {
        id: true,
        embeddingBindingVersionId: true,
        embeddingProfileVersion: true,
        dimensions: true,
      },
    });
    if (collection === null) {
      throw new Error("Knowledge collection is unavailable in this workspace.");
    }

    await database.knowledgeSource.upsert({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: input.source.sourceId,
        },
      },
      create: {
        id: input.source.sourceId,
        workspaceId: input.workspaceId,
        connectorRegistrationId: input.source.connectorRegistrationId,
        knowledgeCollectionId: input.source.knowledgeCollectionId,
        lifecycle: input.lifecycle,
        configurationVersion: input.configurationVersionId,
        connectorConfigurationVersionId,
        normalizationProfileVersion: input.source.normalizationProfileVersion,
        chunkingProfileVersion: input.source.chunkingProfileVersion,
        synchronizationPolicy: jsonObject(input.source.synchronizationPolicy),
        deletionBehavior: input.source.deletionBehavior,
      },
      update: {
        connectorRegistrationId: input.source.connectorRegistrationId,
        knowledgeCollectionId: input.source.knowledgeCollectionId,
        lifecycle: input.lifecycle,
        configurationVersion: input.configurationVersionId,
        connectorConfigurationVersionId,
        normalizationProfileVersion: input.source.normalizationProfileVersion,
        chunkingProfileVersion: input.source.chunkingProfileVersion,
        synchronizationPolicy: jsonObject(input.source.synchronizationPolicy),
        deletionBehavior: input.source.deletionBehavior,
      },
    });
    await this.writeRuntimeVersion({
      workspaceId: input.workspaceId,
      sourceId: input.source.sourceId,
      sourceConfigurationVersionId: input.configurationVersionId,
      connectorRegistrationId: input.source.connectorRegistrationId,
      connectorConfigurationVersionId,
      source: input.source,
      collection,
    });
  }

  public async writeKnowledgeSchedule(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly enabled: boolean;
      readonly schedule: KnowledgeScheduleConfigurationProjection;
    }>,
  ): Promise<void> {
    const database = this.transactions.get(this.transaction);
    await this.requireConfigurationVersion({
      workspaceId: input.workspaceId,
      resourceType: "schedules",
      configurationId: input.schedule.scheduleId,
      versionId: input.configurationVersionId,
    });
    const source = await database.knowledgeSource.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: input.schedule.sourceId,
        },
      },
      select: { id: true, lifecycle: true },
    });
    if (source === null) {
      throw new Error("Knowledge source is unavailable in this workspace.");
    }
    await this.requireConfigurationVersion({
      workspaceId: input.workspaceId,
      resourceType: "knowledge-sources",
      configurationId: input.schedule.sourceId,
      versionId: input.schedule.sourceConfigurationVersionId,
    });
    if (input.enabled && source.lifecycle !== "enabled") {
      throw new Error(
        "An enabled schedule requires an enabled knowledge source.",
      );
    }
    const runtimeVersion =
      await database.knowledgeSourceRuntimeVersion.findUnique({
        where: {
          workspaceId_knowledgeSourceId_sourceConfigurationVersionId: {
            workspaceId: input.workspaceId,
            knowledgeSourceId: input.schedule.sourceId,
            sourceConfigurationVersionId:
              input.schedule.sourceConfigurationVersionId,
          },
        },
        select: {
          connectorConfigurationVersionId: true,
        },
      });
    if (runtimeVersion === null) {
      throw new Error("Knowledge source runtime configuration is unavailable.");
    }

    const cadence = scheduleCadence(input.schedule);
    await database.knowledgeSchedule.upsert({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: input.schedule.scheduleId,
        },
      },
      create: {
        id: input.schedule.scheduleId,
        workspaceId: input.workspaceId,
        knowledgeSourceId: input.schedule.sourceId,
        configurationVersion: input.schedule.sourceConfigurationVersionId,
        connectorConfigurationVersionId:
          runtimeVersion.connectorConfigurationVersionId,
        administrationConfigurationVersionId: input.configurationVersionId,
        scheduleKind: input.schedule.kind,
        triggerKind: cadence.triggerKind,
        ...(cadence.cronExpression === undefined
          ? {}
          : { cronExpression: cadence.cronExpression }),
        ...(cadence.timezone === undefined
          ? {}
          : { timezone: cadence.timezone }),
        ...(cadence.intervalMs === undefined
          ? {}
          : { intervalMs: cadence.intervalMs }),
        ...(cadence.jitterMs === undefined
          ? {}
          : { jitterMs: cadence.jitterMs }),
        overlapPolicy: cadence.overlapPolicy,
        enabled: input.enabled,
        nextRunAt: new Date(input.schedule.nextRunAt),
      },
      update: {
        knowledgeSourceId: input.schedule.sourceId,
        configurationVersion: input.schedule.sourceConfigurationVersionId,
        connectorConfigurationVersionId:
          runtimeVersion.connectorConfigurationVersionId,
        administrationConfigurationVersionId: input.configurationVersionId,
        scheduleKind: input.schedule.kind,
        triggerKind: cadence.triggerKind,
        cronExpression: cadence.cronExpression ?? null,
        timezone: cadence.timezone ?? null,
        intervalMs: cadence.intervalMs ?? null,
        jitterMs: cadence.jitterMs ?? null,
        overlapPolicy: cadence.overlapPolicy,
        enabled: input.enabled,
        nextRunAt: new Date(input.schedule.nextRunAt),
      },
    });
  }

  private async requireConfigurationVersion(
    input: Readonly<{
      readonly workspaceId: string;
      readonly resourceType: "knowledge-sources" | "schedules";
      readonly configurationId: string;
      readonly versionId: string;
    }>,
  ): Promise<void> {
    const database = this.transactions.get(this.transaction);
    const [configuration, version] = await Promise.all([
      database.administrationConfiguration.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.configurationId,
          },
        },
        select: { resourceType: true },
      }),
      database.administrationConfigurationVersion.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.versionId,
          },
        },
        select: { configurationId: true },
      }),
    ]);
    if (
      configuration === null ||
      configuration.resourceType !== input.resourceType ||
      version === null ||
      version.configurationId !== input.configurationId
    ) {
      throw new Error(
        "Configuration version is unavailable in this workspace.",
      );
    }
  }

  private async resolveActiveKnowledgeConnectorVersion(
    input: Readonly<{
      readonly workspaceId: string;
      readonly connectorRegistrationId: string;
    }>,
  ): Promise<string> {
    const rows = await this.transactions.get(this.transaction).$queryRaw<
      readonly Readonly<{
        readonly connector_configuration_version_id: string;
      }>[]
    >`
      SELECT connector_configuration.current_version_id
        AS connector_configuration_version_id
      FROM connector_registrations AS connector
      INNER JOIN connector_capabilities AS capability
        ON capability.workspace_id = connector.workspace_id
       AND capability.connector_registration_id = connector.id
       AND capability.capability = 'knowledgeSource'
      INNER JOIN administration_configurations AS connector_configuration
        ON connector_configuration.workspace_id = connector.workspace_id
       AND connector_configuration.id = connector.id
       AND connector_configuration.resource_type = 'connector-instances'
       AND connector_configuration.lifecycle = 'active'
      INNER JOIN administration_configuration_versions AS connector_version
        ON connector_version.workspace_id = connector_configuration.workspace_id
       AND connector_version.id = connector_configuration.current_version_id
       AND connector_version.configuration_id = connector_configuration.id
       AND connector_version.descriptor_kind = 'connector'
      WHERE connector.workspace_id = ${input.workspaceId}
        AND connector.id = ${input.connectorRegistrationId}
        AND connector.lifecycle = 'active'
      FOR UPDATE OF connector
    `;
    const connector = rows[0];
    if (
      connector === undefined ||
      connector.connector_configuration_version_id.length === 0
    ) {
      throw new Error(
        "Knowledge source connector is not active with the required capability.",
      );
    }
    return connector.connector_configuration_version_id;
  }

  private async writeRuntimeVersion(
    input: Readonly<{
      readonly workspaceId: string;
      readonly sourceId: string;
      readonly sourceConfigurationVersionId: string;
      readonly connectorRegistrationId: string;
      readonly connectorConfigurationVersionId: string;
      readonly source: KnowledgeSourceConfigurationProjection;
      readonly collection: Readonly<{
        readonly id: string;
        readonly embeddingBindingVersionId: string;
        readonly embeddingProfileVersion: string;
        readonly dimensions: number;
      }>;
    }>,
  ): Promise<void> {
    const database = this.transactions.get(this.transaction);
    const existing = await database.knowledgeSourceRuntimeVersion.findUnique({
      where: {
        workspaceId_knowledgeSourceId_sourceConfigurationVersionId: {
          workspaceId: input.workspaceId,
          knowledgeSourceId: input.sourceId,
          sourceConfigurationVersionId: input.sourceConfigurationVersionId,
        },
      },
      select: {
        connectorRegistrationId: true,
        connectorConfigurationVersionId: true,
        knowledgeCollectionId: true,
        collectionRuntimeVersionId: true,
        normalizationProfileId: true,
        normalizationProfileVersion: true,
        chunkingProfileId: true,
        chunkingProfileVersion: true,
        synchronizationPolicy: true,
        embeddingBatchSize: true,
      },
    });
    if (existing !== null) {
      if (
        existing.connectorRegistrationId !== input.connectorRegistrationId ||
        existing.connectorConfigurationVersionId !==
          input.connectorConfigurationVersionId ||
        existing.knowledgeCollectionId !== input.source.knowledgeCollectionId ||
        existing.normalizationProfileId !==
          input.source.normalizationProfileId ||
        existing.normalizationProfileVersion !==
          input.source.normalizationProfileVersion ||
        existing.chunkingProfileId !== input.source.chunkingProfileId ||
        existing.chunkingProfileVersion !==
          input.source.chunkingProfileVersion ||
        existing.embeddingBatchSize !== input.source.embeddingBatchSize ||
        existing.synchronizationPolicy === null ||
        canonicalizeConfiguration(existing.synchronizationPolicy) !==
          canonicalizeConfiguration(input.source.synchronizationPolicy)
      ) {
        throw new Error("Knowledge source runtime version is immutable.");
      }
      return;
    }
    const [binding, budget] = await Promise.all([
      database.aiModelBindingVersion.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.collection.embeddingBindingVersionId,
          },
        },
        select: { maximumInputTokens: true, capabilities: true },
      }),
      database.aiBudgetPolicy.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.source.embeddingBudgetPolicyId,
          },
        },
        select: {
          id: true,
          revision: true,
          active: true,
          hard: true,
          currency: true,
        },
      }),
    ]);
    if (
      binding === null ||
      binding.maximumInputTokens === null ||
      binding.maximumInputTokens < 1 ||
      !hasEmbeddingCapability(binding.capabilities) ||
      budget === null ||
      !budget.active ||
      !budget.hard ||
      !/^[A-Z]{3}$/u.test(budget.currency)
    ) {
      throw new Error(
        "Knowledge source immutable execution settings are unavailable.",
      );
    }
    const collectionRuntimeVersionId = collectionRuntimeId(
      input.workspaceId,
      input.sourceConfigurationVersionId,
    );
    await database.knowledgeCollectionRuntimeVersion.create({
      data: {
        id: collectionRuntimeVersionId,
        workspaceId: input.workspaceId,
        knowledgeCollectionId: input.collection.id,
        embeddingBindingVersionId: input.collection.embeddingBindingVersionId,
        embeddingProfileVersion: input.collection.embeddingProfileVersion,
        dimensions: input.collection.dimensions,
        maximumInputTokens: binding.maximumInputTokens,
        budgetCurrency: budget.currency,
        budgetHard: true,
        budgetPolicyReference: `${budget.id}:r${budget.revision}`,
      },
    });
    await database.knowledgeSourceRuntimeVersion.create({
      data: {
        workspaceId: input.workspaceId,
        knowledgeSourceId: input.sourceId,
        sourceConfigurationVersionId: input.sourceConfigurationVersionId,
        connectorRegistrationId: input.connectorRegistrationId,
        connectorConfigurationVersionId: input.connectorConfigurationVersionId,
        knowledgeCollectionId: input.source.knowledgeCollectionId,
        collectionRuntimeVersionId,
        normalizationProfileId: input.source.normalizationProfileId,
        normalizationProfileVersion: input.source.normalizationProfileVersion,
        chunkingProfileId: input.source.chunkingProfileId,
        chunkingProfileVersion: input.source.chunkingProfileVersion,
        synchronizationPolicy: jsonObject(input.source.synchronizationPolicy),
        embeddingBatchSize: input.source.embeddingBatchSize,
      },
    });
  }
}

function collectionRuntimeId(
  workspaceId: string,
  sourceConfigurationVersionId: string,
): string {
  return `knowledge-runtime-${createHash("sha256")
    .update(`${workspaceId}:${sourceConfigurationVersionId}`, "utf8")
    .digest("hex")
    .slice(0, 48)}`;
}

function hasEmbeddingCapability(value: unknown): boolean {
  return Array.isArray(value) && value.includes("embedding");
}

function jsonObject(
  value: Readonly<Record<string, unknown>>,
): Prisma.InputJsonObject {
  return JSON.parse(canonicalizeConfiguration(value)) as Prisma.InputJsonObject;
}

function scheduleCadence(
  schedule: KnowledgeScheduleConfigurationProjection,
): Readonly<{
  readonly triggerKind: "cron" | "interval";
  readonly cronExpression?: string;
  readonly timezone?: string;
  readonly intervalMs?: bigint;
  readonly jitterMs?: bigint;
  readonly overlapPolicy: "skip" | "queue";
}> {
  if (schedule.cadence.kind === "cron") {
    return Object.freeze({
      triggerKind: "cron",
      cronExpression: schedule.cadence.expression,
      timezone: schedule.cadence.timezone,
      ...(schedule.cadence.jitterMs === undefined
        ? {}
        : { jitterMs: BigInt(schedule.cadence.jitterMs) }),
      overlapPolicy: schedule.cadence.overlapPolicy,
    });
  }
  return Object.freeze({
    triggerKind: "interval",
    intervalMs: BigInt(schedule.cadence.intervalMs),
    ...(schedule.cadence.jitterMs === undefined
      ? {}
      : { jitterMs: BigInt(schedule.cadence.jitterMs) }),
    overlapPolicy: schedule.cadence.overlapPolicy,
  });
}
