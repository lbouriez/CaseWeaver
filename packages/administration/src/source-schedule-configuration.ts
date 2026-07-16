import type {
  ConfigurationLifecycleAudit,
  ConfigurationLifecycleStore,
  ConfigurationTransitionResult,
  CreateConfigurationDraftCommand,
  AdministrationTransactionRunner,
} from "./configuration-lifecycle.js";
import {
  CreateConfigurationDraft,
  TransitionConfigurationVersion,
} from "./configuration-lifecycle.js";
import type { MutationIdentity } from "./configuration.js";

export type KnowledgeSourceProjectionLifecycle = "enabled" | "disabled";
export type KnowledgeScheduleKind = "synchronize" | "fullRescan";

export type KnowledgeScheduleCadence =
  | Readonly<{
      readonly kind: "cron";
      readonly expression: string;
      readonly timezone: string;
      readonly jitterMs?: number;
      readonly overlapPolicy: "skip" | "queue";
    }>
  | Readonly<{
      readonly kind: "interval";
      readonly intervalMs: number;
      readonly jitterMs?: number;
      readonly overlapPolicy: "skip" | "queue";
    }>;

/**
 * This projection contains only source-neutral fields already validated by the
 * feature-owned source schema. `settings` retains that complete, immutable
 * feature configuration; administration does not interpret connector filters.
 */
export interface KnowledgeSourceConfigurationProjection {
  readonly sourceId: string;
  readonly connectorRegistrationId: string;
  readonly knowledgeCollectionId: string;
  /** Code-owned profile identities are retained with their exact revisions. */
  readonly normalizationProfileId: string;
  readonly normalizationProfileVersion: string;
  readonly chunkingProfileId: string;
  readonly chunkingProfileVersion: string;
  /** Bounded ingestion batch selected by the operator and frozen in the version. */
  readonly embeddingBatchSize: number;
  /** An active hard policy is resolved to an immutable policy revision by storage. */
  readonly embeddingBudgetPolicyId: string;
  readonly synchronizationPolicy: Readonly<Record<string, unknown>>;
  readonly deletionBehavior: "tombstone" | "retain";
}

/** The durable projection is responsible for workspace/capability validation. */
export interface SourceScheduleConfigurationProjectionStore
  extends ConfigurationLifecycleStore {
  writeKnowledgeSource(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly lifecycle: KnowledgeSourceProjectionLifecycle;
      readonly source: KnowledgeSourceConfigurationProjection;
    }>,
  ): Promise<void>;
  writeKnowledgeSchedule(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly enabled: boolean;
      readonly schedule: KnowledgeScheduleConfigurationProjection;
    }>,
  ): Promise<void>;
}

export interface KnowledgeScheduleConfigurationProjection {
  readonly scheduleId: string;
  readonly sourceId: string;
  /** Immutable source version selected by this schedule, not its mutable aggregate. */
  readonly sourceConfigurationVersionId: string;
  readonly kind: KnowledgeScheduleKind;
  readonly cadence: KnowledgeScheduleCadence;
  readonly nextRunAt: string;
}

export interface CreateKnowledgeSourceConfigurationCommand {
  readonly workspaceId: string;
  readonly displayName: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly source: KnowledgeSourceConfigurationProjection;
  readonly mutation: MutationIdentity;
}

export interface TransitionKnowledgeSourceConfigurationCommand {
  readonly workspaceId: string;
  readonly displayName?: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly source: KnowledgeSourceConfigurationProjection;
  readonly expectedRevision: number;
  readonly lifecycle: "active" | "disabled";
  readonly beforeHash?: string;
  readonly mutation: MutationIdentity;
}

export interface CreateKnowledgeScheduleConfigurationCommand {
  readonly workspaceId: string;
  readonly displayName: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly schedule: KnowledgeScheduleConfigurationProjection;
  readonly mutation: MutationIdentity;
}

export interface TransitionKnowledgeScheduleConfigurationCommand {
  readonly workspaceId: string;
  readonly displayName?: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly schedule: KnowledgeScheduleConfigurationProjection;
  readonly expectedRevision: number;
  readonly lifecycle: "active" | "disabled";
  readonly beforeHash?: string;
  readonly mutation: MutationIdentity;
}

const sourceResourceType = "knowledge-sources";
const scheduleResourceType = "schedules";

/**
 * Composes the generic immutable lifecycle with a feature read-model projection.
 * It never validates connector-owned settings or invokes connector/scheduler code.
 */
export class ManageKnowledgeSourceConfiguration {
  public constructor(
    private readonly transactions: AdministrationTransactionRunner,
    private readonly store: SourceScheduleConfigurationProjectionStore,
    private readonly audit: ConfigurationLifecycleAudit,
  ) {}

  public async create(
    command: CreateKnowledgeSourceConfigurationCommand,
  ): Promise<ConfigurationTransitionResult> {
    assertSource(command.source);
    return this.transactions.transaction(async () => {
      const created = await new CreateConfigurationDraft(
        passthroughTransaction,
        this.store,
        sourceAudit(this.audit, "admin.knowledgeSource.draft.created"),
      ).execute({
        ...draftCommand(command, sourceResourceType, command.source.sourceId),
      });
      if (created.idempotency === "created") {
        await this.store.writeKnowledgeSource({
          workspaceId: command.workspaceId,
          configurationVersionId: created.version.id,
          lifecycle: "disabled",
          source: command.source,
        });
      }
      return created;
    });
  }

  public async transition(
    command: TransitionKnowledgeSourceConfigurationCommand,
  ): Promise<ConfigurationTransitionResult> {
    assertSource(command.source);
    return this.transactions.transaction(async () => {
      const transitioned = await new TransitionConfigurationVersion(
        passthroughTransaction,
        this.store,
        sourceAudit(this.audit, "admin.knowledgeSource.configuration.changed"),
      ).execute({
        workspaceId: command.workspaceId,
        configurationId: command.source.sourceId,
        resourceType: sourceResourceType,
        expectedRevision: command.expectedRevision,
        settings: command.settings,
        secretReferenceIds: [],
        ...(command.displayName === undefined
          ? {}
          : { displayName: command.displayName }),
        lifecycle: command.lifecycle,
        ...(command.beforeHash === undefined
          ? {}
          : { beforeHash: command.beforeHash }),
        mutation: command.mutation,
      });
      if (transitioned.idempotency === "created") {
        await this.store.writeKnowledgeSource({
          workspaceId: command.workspaceId,
          configurationVersionId: transitioned.version.id,
          lifecycle: command.lifecycle === "active" ? "enabled" : "disabled",
          source: command.source,
        });
      }
      return transitioned;
    });
  }
}

export class ManageKnowledgeScheduleConfiguration {
  public constructor(
    private readonly transactions: AdministrationTransactionRunner,
    private readonly store: SourceScheduleConfigurationProjectionStore,
    private readonly audit: ConfigurationLifecycleAudit,
  ) {}

  public async create(
    command: CreateKnowledgeScheduleConfigurationCommand,
  ): Promise<ConfigurationTransitionResult> {
    assertSchedule(command.schedule);
    return this.transactions.transaction(async () => {
      const created = await new CreateConfigurationDraft(
        passthroughTransaction,
        this.store,
        sourceAudit(this.audit, "admin.knowledgeSchedule.draft.created"),
      ).execute(
        draftCommand(
          command,
          scheduleResourceType,
          command.schedule.scheduleId,
        ),
      );
      if (created.idempotency === "created") {
        await this.store.writeKnowledgeSchedule({
          workspaceId: command.workspaceId,
          configurationVersionId: created.version.id,
          enabled: false,
          schedule: command.schedule,
        });
      }
      return created;
    });
  }

  public async transition(
    command: TransitionKnowledgeScheduleConfigurationCommand,
  ): Promise<ConfigurationTransitionResult> {
    assertSchedule(command.schedule);
    return this.transactions.transaction(async () => {
      const transitioned = await new TransitionConfigurationVersion(
        passthroughTransaction,
        this.store,
        sourceAudit(
          this.audit,
          "admin.knowledgeSchedule.configuration.changed",
        ),
      ).execute({
        workspaceId: command.workspaceId,
        configurationId: command.schedule.scheduleId,
        resourceType: scheduleResourceType,
        expectedRevision: command.expectedRevision,
        settings: command.settings,
        secretReferenceIds: [],
        ...(command.displayName === undefined
          ? {}
          : { displayName: command.displayName }),
        lifecycle: command.lifecycle,
        ...(command.beforeHash === undefined
          ? {}
          : { beforeHash: command.beforeHash }),
        mutation: command.mutation,
      });
      if (transitioned.idempotency === "created") {
        await this.store.writeKnowledgeSchedule({
          workspaceId: command.workspaceId,
          configurationVersionId: transitioned.version.id,
          enabled: command.lifecycle === "active",
          schedule: command.schedule,
        });
      }
      return transitioned;
    });
  }
}

const passthroughTransaction: AdministrationTransactionRunner = Object.freeze({
  transaction: async <T>(operation: () => Promise<T>) => operation(),
});

function draftCommand(
  command:
    | CreateKnowledgeSourceConfigurationCommand
    | CreateKnowledgeScheduleConfigurationCommand,
  resourceType: string,
  configurationId: string,
): CreateConfigurationDraftCommand {
  return Object.freeze({
    workspaceId: command.workspaceId,
    configurationId,
    resourceType,
    displayName: command.displayName,
    settings: command.settings,
    secretReferenceIds: [],
    mutation: command.mutation,
  });
}

function sourceAudit(
  audit: ConfigurationLifecycleAudit,
  action: string,
): ConfigurationLifecycleAudit {
  return Object.freeze({
    append: (input: Parameters<ConfigurationLifecycleAudit["append"]>[0]) =>
      audit.append({ ...input, action }),
  });
}

function assertSource(source: KnowledgeSourceConfigurationProjection): void {
  for (const value of [
    source.sourceId,
    source.connectorRegistrationId,
    source.knowledgeCollectionId,
    source.normalizationProfileId,
    source.normalizationProfileVersion,
    source.chunkingProfileId,
    source.chunkingProfileVersion,
    source.embeddingBudgetPolicyId,
  ]) {
    assertIdentifier(value, "Knowledge source projection identifier");
  }
  if (
    source.deletionBehavior !== "tombstone" &&
    source.deletionBehavior !== "retain"
  ) {
    throw new RangeError("Knowledge source deletion behavior is invalid.");
  }
  if (!isObject(source.synchronizationPolicy)) {
    throw new TypeError("Knowledge source synchronization policy is invalid.");
  }
  if (
    !Number.isSafeInteger(source.embeddingBatchSize) ||
    source.embeddingBatchSize < 1 ||
    source.embeddingBatchSize > 1_000
  ) {
    throw new RangeError("Knowledge source embedding batch size is invalid.");
  }
}

function assertSchedule(
  schedule: KnowledgeScheduleConfigurationProjection,
): void {
  for (const value of [
    schedule.scheduleId,
    schedule.sourceId,
    schedule.sourceConfigurationVersionId,
  ]) {
    assertIdentifier(value, "Knowledge schedule projection identifier");
  }
  if (schedule.kind !== "synchronize" && schedule.kind !== "fullRescan") {
    throw new RangeError("Knowledge schedule kind is invalid.");
  }
  const nextRunAt = new Date(schedule.nextRunAt);
  if (
    !Number.isFinite(nextRunAt.getTime()) ||
    nextRunAt.toISOString() !== schedule.nextRunAt
  ) {
    throw new RangeError("Knowledge schedule next run is invalid.");
  }
  if (schedule.cadence.kind === "cron") {
    if (
      schedule.cadence.expression.trim().length === 0 ||
      schedule.cadence.expression.length > 500 ||
      schedule.cadence.timezone.trim().length === 0 ||
      schedule.cadence.timezone.length > 100
    ) {
      throw new RangeError("Knowledge cron schedule cadence is invalid.");
    }
  } else if (
    !Number.isSafeInteger(schedule.cadence.intervalMs) ||
    schedule.cadence.intervalMs < 1 ||
    schedule.cadence.intervalMs > 86_400_000
  ) {
    throw new RangeError("Knowledge interval schedule cadence is invalid.");
  }
  if (
    schedule.cadence.jitterMs !== undefined &&
    (!Number.isSafeInteger(schedule.cadence.jitterMs) ||
      schedule.cadence.jitterMs < 0 ||
      schedule.cadence.jitterMs > 86_400_000)
  ) {
    throw new RangeError("Knowledge schedule jitter is invalid.");
  }
  if (
    schedule.cadence.overlapPolicy !== "skip" &&
    schedule.cadence.overlapPolicy !== "queue"
  ) {
    throw new RangeError("Knowledge schedule overlap policy is invalid.");
  }
}

function assertIdentifier(value: string, message: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)
  ) {
    throw new RangeError(`${message} is invalid.`);
  }
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
