import { createHash } from "node:crypto";

import { sha256Digest } from "@caseweaver/domain";
import type { Permission } from "@caseweaver/security";

import {
  canonicalizeConfiguration,
  type ImmutableConfigurationVersion,
  type MutationIdentity,
  type StoredMutationResult,
  type VersionedConfiguration,
} from "./configuration.js";
import type { ConfigurationDescriptorReference } from "./descriptor.js";
import {
  AdministrationConflictError,
  IdempotencyConflictError,
} from "./errors.js";

export interface ConfigurationTransitionCommand {
  readonly workspaceId: string;
  readonly configurationId: string;
  readonly resourceType: string;
  readonly expectedRevision: number;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly secretReferenceIds: readonly string[];
  readonly descriptor?: ConfigurationDescriptorReference;
  readonly displayName?: string;
  readonly lifecycle?: "active" | "disabled";
  readonly beforeHash?: string;
  readonly mutation: MutationIdentity;
}

export interface ConfigurationTransitionResult {
  readonly configuration: VersionedConfiguration;
  readonly version: ImmutableConfigurationVersion;
  readonly idempotency: "created" | "replayed";
}

export interface CreateConfigurationDraftCommand {
  readonly workspaceId: string;
  readonly configurationId: string;
  readonly resourceType: string;
  readonly displayName: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly secretReferenceIds: readonly string[];
  readonly descriptor?: ConfigurationDescriptorReference;
  /** Required for a durable create replay boundary. */
  readonly mutation: MutationIdentity;
}

/** A durable implementation must execute this callback in one database transaction. */
export interface AdministrationTransactionRunner {
  transaction<T>(callback: () => Promise<T>): Promise<T>;
}

export interface ConfigurationLifecycleStore {
  createDraft(
    input: Readonly<{
      readonly workspaceId: string;
      readonly resourceType: string;
      readonly configurationId: string;
      readonly displayName: string;
      readonly canonicalSettings: string;
      readonly secretReferenceIds: readonly string[];
      readonly descriptor?: ConfigurationDescriptorReference;
    }>,
  ): Promise<
    Readonly<{
      readonly configuration: VersionedConfiguration;
      readonly version: ImmutableConfigurationVersion;
    }>
  >;
  findMutation(
    input: Readonly<{
      readonly workspaceId: string;
      readonly identity: MutationIdentity;
    }>,
  ): Promise<StoredMutationResult | undefined>;
  loadVersion(
    input: Readonly<{
      readonly workspaceId: string;
      readonly resourceType: string;
      readonly configurationId: string;
      readonly versionId: string;
    }>,
  ): Promise<ImmutableConfigurationVersion | undefined>;
  transition(
    input: Readonly<{
      readonly workspaceId: string;
      readonly resourceType: string;
      readonly configurationId: string;
      readonly expectedRevision: number;
      readonly canonicalSettings: string;
      readonly secretReferenceIds: readonly string[];
      readonly descriptor?: ConfigurationDescriptorReference;
      readonly displayName?: string;
      readonly lifecycle?: "active" | "disabled";
    }>,
  ): Promise<
    | Readonly<{
        readonly configuration: VersionedConfiguration;
        readonly version: ImmutableConfigurationVersion;
      }>
    | undefined
  >;
  recordMutation(
    input: Readonly<{
      readonly workspaceId: string;
      readonly identity: MutationIdentity;
      readonly result: StoredMutationResult;
    }>,
  ): Promise<void>;
}

/**
 * Opt-in successor-draft persistence. Existing configuration surfaces retain
 * their active/disabled transition contract; a feature that needs a fresh
 * immutable draft revision explicitly implements this additional port.
 */
export interface ConfigurationDraftRevisionStore {
  createDraftRevision(
    input: Readonly<{
      readonly workspaceId: string;
      readonly resourceType: string;
      readonly configurationId: string;
      readonly expectedRevision: number;
      readonly canonicalSettings: string;
      readonly secretReferenceIds: readonly string[];
      readonly descriptor?: ConfigurationDescriptorReference;
      readonly displayName?: string;
    }>,
  ): Promise<
    | Readonly<{
        readonly configuration: VersionedConfiguration;
        readonly version: ImmutableConfigurationVersion;
      }>
    | undefined
  >;
}

export interface CreateConfigurationDraftRevisionCommand
  extends Omit<ConfigurationTransitionCommand, "lifecycle"> {}

export interface ConfigurationLifecycleAudit {
  append(
    input: Readonly<{
      readonly action: string;
      readonly targetType: string;
      readonly targetId: string;
      readonly permission: Permission;
      readonly outcome: "succeeded";
      readonly beforeHash?: string;
      readonly afterHash: string;
    }>,
  ): Promise<void>;
}

/**
 * Creates the first immutable configuration version through the same
 * idempotency and audit boundary as later transitions.  A draft is deliberately
 * inert: feature projections decide when an activated version becomes usable.
 */
export class CreateConfigurationDraft {
  public constructor(
    private readonly transactions: AdministrationTransactionRunner,
    private readonly store: ConfigurationLifecycleStore,
    private readonly audit: ConfigurationLifecycleAudit,
  ) {}

  public async execute(
    command: CreateConfigurationDraftCommand,
  ): Promise<ConfigurationTransitionResult> {
    return this.transactions.transaction(async () => {
      const existing = await this.store.findMutation({
        workspaceId: command.workspaceId,
        identity: command.mutation,
      });
      if (existing !== undefined) {
        if (existing.requestDigest !== command.mutation.requestDigest) {
          throw new IdempotencyConflictError();
        }
        const version = await this.store.loadVersion({
          workspaceId: command.workspaceId,
          resourceType: command.resourceType,
          configurationId: command.configurationId,
          versionId: existing.resourceId,
        });
        if (version === undefined || version.version !== 1) {
          throw new AdministrationConflictError();
        }
        return Object.freeze({
          configuration: Object.freeze({
            id: command.configurationId,
            workspaceId: command.workspaceId,
            resourceType: command.resourceType,
            revision: 1,
            lifecycle: "draft",
            currentVersionId: version.id,
          }),
          version,
          idempotency: "replayed" as const,
        });
      }

      const canonicalSettings = canonicalizeConfiguration(command.settings);
      const created = await this.store.createDraft({
        workspaceId: command.workspaceId,
        resourceType: command.resourceType,
        configurationId: command.configurationId,
        displayName: command.displayName,
        canonicalSettings,
        secretReferenceIds: Object.freeze(
          [...new Set(command.secretReferenceIds)].sort(),
        ),
        ...(command.descriptor === undefined
          ? {}
          : { descriptor: command.descriptor }),
      });
      await this.store.recordMutation({
        workspaceId: command.workspaceId,
        identity: command.mutation,
        result: {
          requestDigest: command.mutation.requestDigest,
          resourceId: created.version.id,
        },
      });
      await this.audit.append({
        action: "admin.configuration.draft.created",
        targetType: command.resourceType,
        targetId: command.configurationId,
        permission: "configuration.manage",
        outcome: "succeeded",
        afterHash: configurationCanonicalHash(canonicalSettings),
      });
      return Object.freeze({ ...created, idempotency: "created" as const });
    });
  }
}

/**
 * Creates an inert immutable successor revision. The caller must supply a
 * complete new write-only settings payload; this use case never reads a prior
 * version's settings back into an administration response or command.
 */
export class CreateConfigurationDraftRevision {
  public constructor(
    private readonly transactions: AdministrationTransactionRunner,
    private readonly store: ConfigurationLifecycleStore &
      ConfigurationDraftRevisionStore,
    private readonly audit: ConfigurationLifecycleAudit,
  ) {}

  public async execute(
    command: CreateConfigurationDraftRevisionCommand,
  ): Promise<ConfigurationTransitionResult> {
    return this.transactions.transaction(async () => {
      const existing = await this.store.findMutation({
        workspaceId: command.workspaceId,
        identity: command.mutation,
      });
      if (existing !== undefined) {
        if (existing.requestDigest !== command.mutation.requestDigest) {
          throw new IdempotencyConflictError();
        }
        const version = await this.store.loadVersion({
          workspaceId: command.workspaceId,
          resourceType: command.resourceType,
          configurationId: command.configurationId,
          versionId: existing.resourceId,
        });
        if (version === undefined) throw new AdministrationConflictError();
        return Object.freeze({
          configuration: Object.freeze({
            id: command.configurationId,
            workspaceId: command.workspaceId,
            resourceType: command.resourceType,
            revision: command.expectedRevision + 1,
            lifecycle: "draft",
            currentVersionId: version.id,
          }),
          version,
          idempotency: "replayed" as const,
        });
      }

      const canonicalSettings = canonicalizeConfiguration(command.settings);
      const afterHash = configurationCanonicalHash(canonicalSettings);
      const created = await this.store.createDraftRevision({
        workspaceId: command.workspaceId,
        resourceType: command.resourceType,
        configurationId: command.configurationId,
        expectedRevision: command.expectedRevision,
        canonicalSettings,
        secretReferenceIds: Object.freeze(
          [...new Set(command.secretReferenceIds)].sort(),
        ),
        ...(command.descriptor === undefined
          ? {}
          : { descriptor: command.descriptor }),
        ...(command.displayName === undefined
          ? {}
          : { displayName: command.displayName }),
      });
      if (created === undefined) throw new AdministrationConflictError();
      await this.store.recordMutation({
        workspaceId: command.workspaceId,
        identity: command.mutation,
        result: {
          requestDigest: command.mutation.requestDigest,
          resourceId: created.version.id,
        },
      });
      await this.audit.append({
        action: "admin.configuration.draftRevision.created",
        targetType: command.resourceType,
        targetId: command.configurationId,
        permission: "configuration.manage",
        outcome: "succeeded",
        ...(command.beforeHash === undefined
          ? {}
          : { beforeHash: command.beforeHash }),
        afterHash,
      });
      return Object.freeze({ ...created, idempotency: "created" as const });
    });
  }
}

/**
 * Provider-neutral immutable configuration transition. The persistence adapter owns
 * locking and inserts; this service makes replay/conflict behaviour deterministic.
 */
export class TransitionConfigurationVersion {
  public constructor(
    private readonly transactions: AdministrationTransactionRunner,
    private readonly store: ConfigurationLifecycleStore,
    private readonly audit: ConfigurationLifecycleAudit,
  ) {}

  public async execute(
    command: ConfigurationTransitionCommand,
  ): Promise<ConfigurationTransitionResult> {
    return this.transactions.transaction(async () => {
      const existing = await this.store.findMutation({
        workspaceId: command.workspaceId,
        identity: command.mutation,
      });
      if (existing !== undefined) {
        if (existing.requestDigest !== command.mutation.requestDigest) {
          throw new IdempotencyConflictError();
        }
        const version = await this.store.loadVersion({
          workspaceId: command.workspaceId,
          resourceType: command.resourceType,
          configurationId: command.configurationId,
          versionId: existing.resourceId,
        });
        if (version === undefined) throw new AdministrationConflictError();
        return Object.freeze({
          configuration: Object.freeze({
            id: command.configurationId,
            workspaceId: command.workspaceId,
            resourceType: command.resourceType,
            revision: command.expectedRevision,
            lifecycle: command.lifecycle ?? "active",
            currentVersionId: version.id,
          }),
          version,
          idempotency: "replayed" as const,
        });
      }

      const canonicalSettings = canonicalizeConfiguration(command.settings);
      const afterHash = configurationCanonicalHash(canonicalSettings);
      const transitioned = await this.store.transition({
        workspaceId: command.workspaceId,
        resourceType: command.resourceType,
        configurationId: command.configurationId,
        expectedRevision: command.expectedRevision,
        canonicalSettings,
        secretReferenceIds: Object.freeze(
          [...new Set(command.secretReferenceIds)].sort(),
        ),
        ...(command.descriptor === undefined
          ? {}
          : { descriptor: command.descriptor }),
        ...(command.displayName === undefined
          ? {}
          : { displayName: command.displayName }),
        ...(command.lifecycle === undefined
          ? {}
          : { lifecycle: command.lifecycle }),
      });
      if (transitioned === undefined) throw new AdministrationConflictError();
      await this.store.recordMutation({
        workspaceId: command.workspaceId,
        identity: command.mutation,
        result: {
          requestDigest: command.mutation.requestDigest,
          resourceId: transitioned.version.id,
        },
      });
      await this.audit.append({
        action: "admin.configuration.transition",
        targetType: command.resourceType,
        targetId: command.configurationId,
        permission: "configuration.manage",
        outcome: "succeeded",
        ...(command.beforeHash === undefined
          ? {}
          : { beforeHash: command.beforeHash }),
        afterHash,
      });
      return Object.freeze({
        ...transitioned,
        idempotency: "created" as const,
      });
    });
  }
}

export function configurationCanonicalHash(
  canonicalSettings: string,
): ReturnType<typeof sha256Digest> {
  return sha256Digest(
    createHash("sha256").update(canonicalSettings, "utf8").digest("hex"),
  );
}
