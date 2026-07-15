import { randomUUID } from "node:crypto";

import type { ApplicationTransaction } from "@caseweaver/application";
import { canonicalizeConfiguration } from "@caseweaver/administration";
import type {
  ClaimedConfigurationChange,
  ConfigurationDescriptorReference,
  ConfigurationLifecycleStore,
  ConfigurationChangeOutbox,
  ConfigurationChangeNotice,
  ImmutableConfigurationVersion,
  MutationIdentity,
  StoredMutationResult,
  VersionedConfiguration,
} from "@caseweaver/administration";
import type { Prisma } from "@prisma/client";

import type { PostgresTransactionLookup } from "../index.js";

interface ConfigurationRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly resource_type: string;
  readonly lifecycle: string;
  readonly revision: number;
  readonly current_version_id: string | null;
}

interface ChangeOutboxRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly resource_type: string;
  readonly configuration_id: string;
  readonly previous_version_id: string | null;
  readonly current_version_id: string;
  readonly cache_scopes: unknown;
}

interface VersionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly configuration_id: string;
  readonly version: number;
  readonly settings: unknown;
  readonly secret_references: unknown;
  readonly display_name: string | null;
  readonly descriptor_kind: string | null;
  readonly descriptor_type: string | null;
  readonly descriptor_version: string | null;
}

function asConfiguration(row: ConfigurationRow): VersionedConfiguration {
  if (
    row.lifecycle !== "draft" &&
    row.lifecycle !== "active" &&
    row.lifecycle !== "disabled" &&
    row.lifecycle !== "superseded"
  ) {
    throw new Error(
      "Persisted administration configuration lifecycle is invalid.",
    );
  }
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspace_id,
    resourceType: row.resource_type,
    revision: row.revision,
    lifecycle: row.lifecycle,
    ...(row.current_version_id === null
      ? {}
      : { currentVersionId: row.current_version_id }),
  });
}

function asVersion(row: VersionRow): ImmutableConfigurationVersion {
  if (
    !Array.isArray(row.secret_references) ||
    !row.secret_references.every((value) => typeof value === "string")
  ) {
    throw new Error("Persisted administration secret references are invalid.");
  }
  if (
    row.settings === null ||
    typeof row.settings !== "object" ||
    Array.isArray(row.settings)
  ) {
    throw new Error(
      "Persisted administration configuration settings are invalid.",
    );
  }
  const descriptorValues = [
    row.descriptor_kind,
    row.descriptor_type,
    row.descriptor_version,
  ];
  if (
    descriptorValues.some((value) => value === null) &&
    descriptorValues.some((value) => value !== null)
  ) {
    throw new Error(
      "Persisted administration descriptor reference is invalid.",
    );
  }
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspace_id,
    configurationId: row.configuration_id,
    version: row.version,
    canonicalSettings: canonicalizeConfiguration(row.settings),
    secretReferenceIds: Object.freeze([...row.secret_references]),
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    ...(row.descriptor_kind === null
      ? {}
      : {
          descriptor: Object.freeze({
            kind: row.descriptor_kind as ConfigurationDescriptorReference["kind"],
            type: row.descriptor_type as string,
            version: row.descriptor_version as string,
          }),
        }),
  });
}

function validatedJsonObject(value: string): Prisma.InputJsonObject {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "Canonical administration configuration must be an object.",
    );
  }
  return parsed as Prisma.InputJsonObject;
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Transaction-bound store for an immutable administration configuration aggregate.
 * Construct it inside the caller's UnitOfWork transaction; all methods reject use
 * outside that active transaction through the shared transaction lookup.
 */
export class PostgresConfigurationLifecycleStore
  implements ConfigurationLifecycleStore
{
  public constructor(
    private readonly transactions: PostgresTransactionLookup,
    private readonly transaction: ApplicationTransaction,
    private readonly nextId: () => string = randomUUID,
  ) {}

  public async createDraft(
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
  > {
    const database = this.transactions.get(this.transaction);
    const created = await database.administrationConfiguration.create({
      data: {
        id: input.configurationId,
        workspaceId: input.workspaceId,
        resourceType: input.resourceType,
        lifecycle: "draft",
        revision: 1,
      },
      select: {
        id: true,
        workspaceId: true,
        resourceType: true,
        lifecycle: true,
        revision: true,
        currentVersionId: true,
      },
    });
    const configuration = asConfiguration({
      id: created.id,
      workspace_id: created.workspaceId,
      resource_type: created.resourceType,
      lifecycle: created.lifecycle,
      revision: created.revision,
      current_version_id: created.currentVersionId,
    });
    const versionId = this.nextId();
    const version = await database.administrationConfigurationVersion.create({
      data: {
        id: versionId,
        workspaceId: input.workspaceId,
        configurationId: input.configurationId,
        version: 1,
        settings: validatedJsonObject(input.canonicalSettings),
        secretReferences: [...new Set(input.secretReferenceIds)].sort(),
        displayName: input.displayName,
        ...(input.descriptor === undefined
          ? {}
          : {
              descriptorKind: input.descriptor.kind,
              descriptorType: input.descriptor.type,
              descriptorVersion: input.descriptor.version,
            }),
      },
      select: {
        id: true,
        workspaceId: true,
        configurationId: true,
        version: true,
        settings: true,
        secretReferences: true,
        displayName: true,
        descriptorKind: true,
        descriptorType: true,
        descriptorVersion: true,
      },
    });
    const pointed = await database.administrationConfiguration.updateMany({
      where: {
        workspaceId: input.workspaceId,
        id: input.configurationId,
        revision: 1,
      },
      data: { currentVersionId: version.id },
    });
    if (pointed.count !== 1)
      throw new Error("Administration draft version was not retained.");
    await this.appendChange({
      workspaceId: input.workspaceId,
      resourceType: input.resourceType,
      configurationId: input.configurationId,
      currentVersionId: version.id,
    });
    return Object.freeze({
      configuration: Object.freeze({
        ...configuration,
        currentVersionId: version.id,
      }),
      version: asVersion({
        id: version.id,
        workspace_id: version.workspaceId,
        configuration_id: version.configurationId,
        version: version.version,
        settings: version.settings,
        secret_references: version.secretReferences,
        display_name: version.displayName,
        descriptor_kind: version.descriptorKind,
        descriptor_type: version.descriptorType,
        descriptor_version: version.descriptorVersion,
      }),
    });
  }

  public async findMutation(
    input: Readonly<{
      readonly workspaceId: string;
      readonly identity: MutationIdentity;
    }>,
  ): Promise<StoredMutationResult | undefined> {
    const database = this.transactions.get(this.transaction);
    const lockKey = `${input.workspaceId}:${input.identity.operation}:${input.identity.keyDigest}`;
    // Select a scalar around the void-returning PostgreSQL lock function; Prisma
    // cannot deserialize a bare `void` result from pg_advisory_xact_lock.
    await database.$queryRaw`
      SELECT 1 AS locked
      FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    `;
    const row = await database.idempotencyRecord.findUnique({
      where: {
        workspaceId_operation_keyDigest: {
          workspaceId: input.workspaceId,
          operation: input.identity.operation,
          keyDigest: input.identity.keyDigest,
        },
      },
      select: { requestDigest: true, resourceId: true },
    });
    return row === null
      ? undefined
      : Object.freeze({
          requestDigest: row.requestDigest,
          resourceId: row.resourceId,
        });
  }

  public async loadVersion(
    input: Readonly<{
      readonly workspaceId: string;
      readonly resourceType: string;
      readonly configurationId: string;
      readonly versionId: string;
    }>,
  ): Promise<ImmutableConfigurationVersion | undefined> {
    const database = this.transactions.get(this.transaction);
    const rows = await database.$queryRaw<readonly VersionRow[]>`
      SELECT version.id, version.workspace_id, version.configuration_id,
        version.version, version.settings, version.secret_references,
        version.display_name, version.descriptor_kind, version.descriptor_type,
        version.descriptor_version
      FROM administration_configuration_versions AS version
      INNER JOIN administration_configurations AS configuration
        ON configuration.workspace_id = version.workspace_id
        AND configuration.id = version.configuration_id
      WHERE version.workspace_id = ${input.workspaceId}
        AND version.configuration_id = ${input.configurationId}
        AND version.id = ${input.versionId}
        AND configuration.resource_type = ${input.resourceType}
    `;
    const row = rows[0];
    return row === undefined ? undefined : asVersion(row);
  }

  public async transition(
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
  > {
    if (!validRevision(input.expectedRevision)) {
      throw new RangeError(
        "Expected administration configuration revision is invalid.",
      );
    }
    const database = this.transactions.get(this.transaction);
    const claimed = await database.$queryRaw<readonly ConfigurationRow[]>`
      UPDATE administration_configurations
      SET revision = revision + 1,
          lifecycle = ${input.lifecycle ?? "active"},
          updated_at = now()
      WHERE workspace_id = ${input.workspaceId}
        AND id = ${input.configurationId}
        AND resource_type = ${input.resourceType}
        AND revision = ${input.expectedRevision}
      RETURNING id, workspace_id, resource_type, lifecycle, revision, current_version_id
    `;
    const configuration = claimed[0];
    if (configuration === undefined) return undefined;

    const previousVersionId = configuration.current_version_id;
    const previous =
      previousVersionId === null
        ? undefined
        : await this.loadVersion({
            workspaceId: input.workspaceId,
            resourceType: input.resourceType,
            configurationId: input.configurationId,
            versionId: previousVersionId,
          });
    const versionId = this.nextId();
    const settings = validatedJsonObject(input.canonicalSettings);
    const secretReferences = [...new Set(input.secretReferenceIds)].sort();
    const version = await database.administrationConfigurationVersion.create({
      data: {
        id: versionId,
        workspaceId: input.workspaceId,
        configurationId: input.configurationId,
        version: configuration.revision,
        settings,
        secretReferences,
        ...(input.displayName === undefined &&
        previous?.displayName === undefined
          ? {}
          : { displayName: input.displayName ?? previous?.displayName }),
        ...(input.descriptor === undefined && previous?.descriptor === undefined
          ? {}
          : {
              descriptorKind: (input.descriptor ?? previous?.descriptor)?.kind,
              descriptorType: (input.descriptor ?? previous?.descriptor)?.type,
              descriptorVersion: (input.descriptor ?? previous?.descriptor)
                ?.version,
            }),
      },
      select: {
        id: true,
        workspaceId: true,
        configurationId: true,
        version: true,
        settings: true,
        secretReferences: true,
        displayName: true,
        descriptorKind: true,
        descriptorType: true,
        descriptorVersion: true,
      },
    });
    const current = await database.administrationConfiguration.updateMany({
      where: {
        workspaceId: input.workspaceId,
        id: input.configurationId,
        resourceType: input.resourceType,
        revision: configuration.revision,
      },
      data: { currentVersionId: version.id },
    });
    if (current.count !== 1) {
      throw new Error(
        "Administration configuration transition was not retained.",
      );
    }
    await this.appendChange({
      workspaceId: input.workspaceId,
      resourceType: input.resourceType,
      configurationId: input.configurationId,
      ...(previousVersionId === null ? {} : { previousVersionId }),
      currentVersionId: version.id,
    });

    return Object.freeze({
      configuration: asConfiguration({
        ...configuration,
        current_version_id: version.id,
      }),
      version: asVersion({
        id: version.id,
        workspace_id: version.workspaceId,
        configuration_id: version.configurationId,
        version: version.version,
        settings: version.settings,
        secret_references: version.secretReferences,
        display_name: version.displayName,
        descriptor_kind: version.descriptorKind,
        descriptor_type: version.descriptorType,
        descriptor_version: version.descriptorVersion,
      }),
    });
  }

  public async recordMutation(
    input: Readonly<{
      readonly workspaceId: string;
      readonly identity: MutationIdentity;
      readonly result: StoredMutationResult;
    }>,
  ): Promise<void> {
    const database = this.transactions.get(this.transaction);
    await database.idempotencyRecord.create({
      data: {
        workspaceId: input.workspaceId,
        operation: input.identity.operation,
        keyDigest: input.identity.keyDigest,
        requestDigest: input.result.requestDigest,
        resourceId: input.result.resourceId,
      },
    });
  }

  private async appendChange(
    input: Readonly<{
      readonly workspaceId: string;
      readonly resourceType: string;
      readonly configurationId: string;
      readonly previousVersionId?: string;
      readonly currentVersionId: string;
    }>,
  ): Promise<void> {
    await this.transactions
      .get(this.transaction)
      .administrationConfigurationChangeOutbox.create({
        data: {
          id: this.nextId(),
          workspaceId: input.workspaceId,
          resourceType: input.resourceType,
          configurationId: input.configurationId,
          ...(input.previousVersionId === undefined
            ? {}
            : { previousVersionId: input.previousVersionId }),
          currentVersionId: input.currentVersionId,
          cacheScopes: [
            `workspace:${input.workspaceId}:configuration`,
            `workspace:${input.workspaceId}:${input.resourceType}`,
            `configuration:${input.configurationId}`,
          ],
        },
      });
  }
}

/** Transaction-bound durable relay store for committed cache-invalidation notices. */
export class PostgresConfigurationChangeOutbox
  implements ConfigurationChangeOutbox
{
  public constructor(
    private readonly transactions: PostgresTransactionLookup,
    private readonly transaction: ApplicationTransaction,
  ) {}

  public async claim(
    input: Readonly<{
      readonly limit: number;
      readonly leaseMs: number;
    }>,
  ): Promise<readonly ClaimedConfigurationChange[]> {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new RangeError(
        "Configuration change claim limit must be between 1 and 100.",
      );
    }
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1) {
      throw new RangeError(
        "Configuration change claim lease must be positive.",
      );
    }
    const claimToken = randomUUID();
    const rows = await this.transactions.get(this.transaction).$queryRaw<
      readonly ChangeOutboxRow[]
    >`
      WITH selected AS (
        SELECT id
        FROM administration_configuration_change_outbox
        WHERE published_at IS NULL
          AND (claimed_until IS NULL OR claimed_until <= NOW())
        ORDER BY created_at, id
        LIMIT ${input.limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE administration_configuration_change_outbox AS notice
      SET claim_token = ${claimToken},
          claimed_until = NOW() + (${input.leaseMs} * INTERVAL '1 millisecond'),
          claim_attempts = notice.claim_attempts + 1
      FROM selected
      WHERE notice.id = selected.id
      RETURNING notice.id, notice.workspace_id, notice.resource_type,
        notice.configuration_id, notice.previous_version_id,
        notice.current_version_id, notice.cache_scopes
    `;
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          claimToken,
          id: row.id,
          change: toChangeNotice(row),
        }),
      ),
    );
  }

  public async acknowledge(claim: ClaimedConfigurationChange): Promise<void> {
    const updated = await this.transactions.get(this.transaction).$executeRaw`
      UPDATE administration_configuration_change_outbox
      SET published_at = NOW(), claim_token = NULL, claimed_until = NULL
      WHERE id = ${claim.id}
        AND claim_token = ${claim.claimToken}
        AND published_at IS NULL
    `;
    if (updated !== 1) {
      throw new Error(
        "Configuration change outbox claim is no longer current.",
      );
    }
  }
}

function toChangeNotice(row: ChangeOutboxRow): ConfigurationChangeNotice {
  if (
    !Array.isArray(row.cache_scopes) ||
    !row.cache_scopes.every((scope) => typeof scope === "string")
  ) {
    throw new Error("Persisted configuration change cache scopes are invalid.");
  }
  return Object.freeze({
    workspaceId: row.workspace_id,
    resourceType: row.resource_type,
    configurationId: row.configuration_id,
    ...(row.previous_version_id === null
      ? {}
      : { previousVersionId: row.previous_version_id }),
    currentVersionId: row.current_version_id,
    cacheScopes: Object.freeze([...row.cache_scopes]),
  });
}
