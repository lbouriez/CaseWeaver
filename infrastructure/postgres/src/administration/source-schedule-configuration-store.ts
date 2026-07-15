import type { ApplicationTransaction } from "@caseweaver/application";
import {
  canonicalizeConfiguration,
  type ConfigurationLifecycleStore,
  type KnowledgeScheduleConfigurationProjection,
  type KnowledgeSourceConfigurationProjection,
  type SourceScheduleConfigurationProjectionStore,
} from "@caseweaver/administration";
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
    await this.requireActiveKnowledgeConnector({
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
      select: { id: true },
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
        normalizationProfileVersion: input.source.normalizationProfileVersion,
        chunkingProfileVersion: input.source.chunkingProfileVersion,
        synchronizationPolicy: jsonObject(input.source.synchronizationPolicy),
        deletionBehavior: input.source.deletionBehavior,
      },
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

  private async requireActiveKnowledgeConnector(
    input: Readonly<{
      readonly workspaceId: string;
      readonly connectorRegistrationId: string;
    }>,
  ): Promise<void> {
    const connector = await this.transactions
      .get(this.transaction)
      .connectorRegistration.findUnique({
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
      });
    if (
      connector === null ||
      connector.lifecycle !== "active" ||
      !connector.capabilities.some(
        (capability) => capability.capability === "knowledgeSource",
      )
    ) {
      throw new Error(
        "Knowledge source connector is not active with the required capability.",
      );
    }
  }
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
