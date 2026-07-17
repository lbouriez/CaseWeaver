import {
  type AdministrationDetailDto,
  type AdministrationListItemDto,
  type AdministrationResource,
  type ConfigurationHistoryPageDto,
  type ConfigurationHistoryQuery,
  type ConfigurationInspectionDto,
  type ConfigurationVersionSummaryDto,
  type CursorPageDto,
  toConfigurationHistoryPageDto,
  toConfigurationInspectionDto,
} from "@caseweaver/administration";
import type { PrismaClient } from "@prisma/client";

import { PostgresRepositoryAnalysisResourceReadStore } from "./repository-analysis-resource-read-store.js";

export interface AdministrationResourceReadStore {
  list(
    input: Readonly<{
      readonly workspaceId: string;
      readonly resource: AdministrationResource;
      readonly limit: number;
      readonly after?: string;
    }>,
  ): Promise<CursorPageDto<AdministrationListItemDto>>;
  detail(
    input: Readonly<{
      readonly workspaceId: string;
      readonly resource: AdministrationResource;
      readonly id: string;
    }>,
  ): Promise<AdministrationDetailDto | undefined>;
  configurationInspection(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationId: string;
    }>,
  ): Promise<ConfigurationInspectionDto | undefined>;
  configurationHistory(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationId: string;
      readonly query: ConfigurationHistoryQuery;
    }>,
  ): Promise<ConfigurationHistoryPageDto | undefined>;
  configurationVersion(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationId: string;
      readonly versionId: string;
    }>,
  ): Promise<ConfigurationVersionSummaryDto | undefined>;
}

type Item = AdministrationListItemDto;

const configurationVersionInspectionSelection = {
  id: true,
  version: true,
  createdAt: true,
  canonicalSettingsSha256: true,
  secretReferenceCount: true,
  descriptorKind: true,
  descriptorType: true,
  descriptorVersion: true,
} as const;

function inspectionVersion(
  input: Readonly<{
    readonly id: string;
    readonly version: number;
    readonly createdAt: Date;
    readonly canonicalSettingsSha256: string;
    readonly secretReferenceCount: number;
    readonly descriptorKind: string | null;
    readonly descriptorType: string | null;
    readonly descriptorVersion: string | null;
  }>,
): ConfigurationVersionSummaryDto {
  const descriptorValues = [
    input.descriptorKind,
    input.descriptorType,
    input.descriptorVersion,
  ];
  if (
    descriptorValues.some((value) => value === null) &&
    descriptorValues.some((value) => value !== null)
  ) {
    throw new Error("Persisted configuration descriptor reference is invalid.");
  }
  return Object.freeze({
    id: input.id,
    version: input.version,
    createdAt: input.createdAt.toISOString(),
    canonicalSettingsSha256: input.canonicalSettingsSha256,
    secretReferenceCount: input.secretReferenceCount,
    ...(input.descriptorKind === null
      ? {}
      : {
          descriptor: {
            kind: input.descriptorKind as "connector" | "aiProvider",
            type: input.descriptorType as string,
            version: input.descriptorVersion as string,
          },
        }),
  });
}

function page(items: readonly Item[], limit: number): CursorPageDto<Item> {
  const visible = items.slice(0, limit);
  const final = visible.at(-1);
  return Object.freeze({
    items: Object.freeze(visible),
    page: Object.freeze({
      hasNextPage: items.length > limit,
      ...(items.length > limit && final !== undefined
        ? { endCursor: final.id }
        : {}),
    }),
  });
}

function item(
  input: Readonly<{
    readonly id: string;
    readonly label?: string;
    readonly status?: string;
    readonly version?: string;
    readonly updatedAt?: Date;
    readonly summary?: string;
  }>,
): Item {
  return Object.freeze({
    id: input.id,
    label: input.label ?? input.id,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.version === undefined ? {} : { version: input.version }),
    ...(input.updatedAt === undefined
      ? {}
      : { updatedAt: input.updatedAt.toISOString() }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
  });
}

function detailFrom(itemValue: Item): AdministrationDetailDto {
  return Object.freeze({ ...itemValue, fields: Object.freeze({}) });
}

/**
 * Every backing table in this projection has a string primary key. Keeping the
 * optional cursor shape stable avoids widening Prisma's inferred argument type
 * while also ensuring that the opaque API cursor is never used as a filter.
 */
function idCursor(after: string | undefined): Readonly<{
  readonly cursor?: Readonly<{ readonly id: string }>;
  readonly skip?: number;
}> {
  return after === undefined ? {} : { cursor: { id: after }, skip: 1 };
}

/**
 * Safe workspace projections for the complete console inventory. It never
 * returns JSON configuration bodies, secret-reference values, webhook payloads,
 * provider responses, audit hashes, or protected evidence content.
 */
export class PostgresAdministrationResourceReadStore
  implements AdministrationResourceReadStore
{
  private readonly repositoryAnalysis: PostgresRepositoryAnalysisResourceReadStore;

  public constructor(private readonly client: PrismaClient) {
    this.repositoryAnalysis = new PostgresRepositoryAnalysisResourceReadStore(
      client,
    );
  }

  public async list(
    input: Readonly<{
      readonly workspaceId: string;
      readonly resource: AdministrationResource;
      readonly limit: number;
      readonly after?: string;
    }>,
  ): Promise<CursorPageDto<Item>> {
    const resource = input.resource;
    if (this.repositoryAnalysis.supports(resource)) {
      return this.repositoryAnalysis.list({ ...input, resource });
    }
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 200
    ) {
      throw new RangeError("Administration page limit is invalid.");
    }
    const items = await this.items(input);
    return page(items, input.limit);
  }

  public async detail(
    input: Readonly<{
      readonly workspaceId: string;
      readonly resource: AdministrationResource;
      readonly id: string;
    }>,
  ): Promise<AdministrationDetailDto | undefined> {
    const resource = input.resource;
    if (this.repositoryAnalysis.supports(resource)) {
      return this.repositoryAnalysis.detail({ ...input, resource });
    }
    const values = await this.items({ ...input, limit: 200 });
    const found = values.find((value) => value.id === input.id);
    return found === undefined ? undefined : detailFrom(found);
  }

  /**
   * Reads only generated immutable-version metadata. Configuration JSON and
   * secret-reference identities are deliberately not selected at this boundary.
   */
  public async configurationInspection(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationId: string;
    }>,
  ): Promise<ConfigurationInspectionDto | undefined> {
    const configuration =
      await this.client.administrationConfiguration.findFirst({
        where: { workspaceId: input.workspaceId, id: input.configurationId },
        select: {
          id: true,
          resourceType: true,
          lifecycle: true,
          revision: true,
          updatedAt: true,
          currentVersionId: true,
        },
      });
    if (configuration === null) return undefined;
    const currentVersion =
      configuration.currentVersionId === null
        ? undefined
        : await this.client.administrationConfigurationVersion.findFirst({
            where: {
              workspaceId: input.workspaceId,
              configurationId: configuration.id,
              id: configuration.currentVersionId,
            },
            select: configurationVersionInspectionSelection,
          });
    if (configuration.currentVersionId !== null && currentVersion === null) {
      throw new Error("Persisted configuration version reference is invalid.");
    }
    return toConfigurationInspectionDto({
      id: configuration.id,
      resourceType: configuration.resourceType,
      lifecycle: configuration.lifecycle,
      revision: configuration.revision,
      updatedAt: configuration.updatedAt.toISOString(),
      ...(configuration.currentVersionId === null
        ? {}
        : { currentVersionId: configuration.currentVersionId }),
      ...(currentVersion === undefined || currentVersion === null
        ? {}
        : { currentVersion: inspectionVersion(currentVersion) }),
    });
  }

  public async configurationHistory(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationId: string;
      readonly query: ConfigurationHistoryQuery;
    }>,
  ): Promise<ConfigurationHistoryPageDto | undefined> {
    const configuration =
      await this.client.administrationConfiguration.findFirst({
        where: { workspaceId: input.workspaceId, id: input.configurationId },
        select: { id: true },
      });
    if (configuration === null) return undefined;
    const after =
      input.query.after === undefined
        ? undefined
        : await this.client.administrationConfigurationVersion.findFirst({
            where: {
              workspaceId: input.workspaceId,
              configurationId: configuration.id,
              id: input.query.after,
            },
            select: { version: true },
          });
    if (input.query.after !== undefined && after === null) {
      return toConfigurationHistoryPageDto({
        items: [],
        page: { hasNextPage: false },
      });
    }
    const rows = await this.client.administrationConfigurationVersion.findMany({
      where: {
        workspaceId: input.workspaceId,
        configurationId: configuration.id,
        ...(after === undefined || after === null
          ? {}
          : { version: { lt: after.version } }),
      },
      orderBy: [{ version: "desc" }, { id: "desc" }],
      take: input.query.limit + 1,
      select: configurationVersionInspectionSelection,
    });
    const visible = rows.slice(0, input.query.limit);
    const final = visible.at(-1);
    return toConfigurationHistoryPageDto({
      items: visible.map(inspectionVersion),
      page: {
        hasNextPage: rows.length > input.query.limit,
        ...(rows.length > input.query.limit && final !== undefined
          ? { endCursor: final.id }
          : {}),
      },
    });
  }

  public async configurationVersion(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationId: string;
      readonly versionId: string;
    }>,
  ): Promise<ConfigurationVersionSummaryDto | undefined> {
    const version =
      await this.client.administrationConfigurationVersion.findFirst({
        where: {
          workspaceId: input.workspaceId,
          configurationId: input.configurationId,
          id: input.versionId,
        },
        select: configurationVersionInspectionSelection,
      });
    return version === null ? undefined : inspectionVersion(version);
  }

  private async items(
    input: Readonly<{
      readonly workspaceId: string;
      readonly resource: AdministrationResource;
      readonly limit: number;
      readonly after?: string;
    }>,
  ): Promise<readonly Item[]> {
    const take = input.limit + 1;
    const workspaceId = input.workspaceId;
    const cursor = idCursor(input.after);
    switch (input.resource) {
      case "overview": {
        const [jobs, failed, sources, budgets] = await Promise.all([
          this.client.analysisJob.count({ where: { workspaceId } }),
          this.client.analysisJob.count({
            where: { workspaceId, state: "failed" },
          }),
          this.client.knowledgeSource.count({ where: { workspaceId } }),
          this.client.aiBudgetPolicy.count({
            where: { workspaceId, active: true },
          }),
        ]);
        return [
          item({
            id: "workspace-overview",
            label: "Workspace operational summary",
            status: failed === 0 ? "healthy" : "attention",
            summary: `${jobs} analyses · ${failed} failed · ${sources} knowledge sources · ${budgets} active budgets`,
          }),
        ];
      }
      case "secret-references": {
        const rows = await this.client.credentialRegistration.findMany({
          where: { workspaceId },
          orderBy: { id: "asc" },
          take,
          ...cursor,
          select: { id: true, lifecycle: true, updatedAt: true },
        });
        // The opaque external reference is intentionally never selected here.
        return rows.map((row) =>
          item({
            id: row.id,
            label: `Secret reference ${row.id}`,
            status: row.lifecycle,
            updatedAt: row.updatedAt,
            summary:
              "Reference metadata only; secret material is never returned.",
          }),
        );
      }
      case "connector-instances":
      case "ai-provider-instances": {
        const rows = await this.client.administrationConfiguration.findMany({
          where: { workspaceId, resourceType: input.resource },
          orderBy: { id: "asc" },
          take,
          ...cursor,
          select: {
            id: true,
            lifecycle: true,
            revision: true,
            updatedAt: true,
            currentVersionId: true,
          },
        });
        const versions = await Promise.all(
          rows.map(async (row) =>
            row.currentVersionId === null
              ? undefined
              : this.client.administrationConfigurationVersion.findUnique({
                  where: { id: row.currentVersionId },
                  select: {
                    displayName: true,
                    descriptorType: true,
                    descriptorVersion: true,
                  },
                }),
          ),
        );
        return rows.map((row, index) =>
          item({
            id: row.id,
            label: versions[index]?.displayName ?? row.id,
            status: row.lifecycle,
            version: versions[index]?.descriptorVersion ?? String(row.revision),
            updatedAt: row.updatedAt,
            summary: versions[index]?.descriptorType ?? undefined,
          }),
        );
      }
      case "knowledge-sources": {
        const rows = await this.client.knowledgeSource.findMany({
          where: { workspaceId },
          orderBy: { id: "asc" },
          take,
          ...cursor,
          select: {
            id: true,
            lifecycle: true,
            configurationVersion: true,
            updatedAt: true,
            connectorRegistrationId: true,
          },
        });
        return rows.map((row) =>
          item({
            id: row.id,
            status: row.lifecycle,
            version: row.configurationVersion,
            updatedAt: row.updatedAt,
            summary: `connector ${row.connectorRegistrationId}`,
          }),
        );
      }
      case "schedules": {
        const rows = await this.client.knowledgeSchedule.findMany({
          where: { workspaceId },
          orderBy: { id: "asc" },
          take,
          ...cursor,
          select: {
            id: true,
            enabled: true,
            configurationVersion: true,
            updatedAt: true,
            scheduleKind: true,
          },
        });
        return rows.map((row) =>
          item({
            id: row.id,
            status: row.enabled ? "enabled" : "disabled",
            version: row.configurationVersion,
            updatedAt: row.updatedAt,
            summary: row.scheduleKind,
          }),
        );
      }
      case "publication-profiles": {
        const rows = await this.client.publicationProfile.findMany({
          where: { workspaceId },
          orderBy: { id: "asc" },
          take,
          ...cursor,
          select: { id: true, lifecycle: true, createdAt: true },
        });
        return rows.map((row) =>
          item({ id: row.id, status: row.lifecycle, updatedAt: row.createdAt }),
        );
      }
      case "webhook-endpoints": {
        const rows = await this.client.webhookEndpoint.findMany({
          where: { workspaceId },
          orderBy: { id: "asc" },
          take,
          ...cursor,
          select: {
            id: true,
            lifecycle: true,
            endpointConfigurationVersionId: true,
            updatedAt: true,
            connectorInstanceId: true,
          },
        });
        return rows.map((row) =>
          item({
            id: row.id,
            label: row.id,
            status: row.lifecycle,
            version: row.endpointConfigurationVersionId,
            updatedAt: row.updatedAt,
            summary: `connector ${row.connectorInstanceId}`,
          }),
        );
      }
      case "ai-models": {
        const rows = await this.client.aiCatalogModel.findMany({
          orderBy: { id: "asc" },
          take,
          ...cursor,
          select: {
            id: true,
            canonicalModel: true,
            provider: true,
            createdAt: true,
          },
        });
        return rows.map((row) =>
          item({
            id: row.id,
            label: row.canonicalModel,
            status: "catalog",
            updatedAt: row.createdAt,
            summary: row.provider,
          }),
        );
      }
      case "ai-catalog-snapshots": {
        const rows = await this.client.aiCatalogSnapshot.findMany({
          orderBy: { id: "asc" },
          take,
          ...cursor,
          select: {
            id: true,
            upstreamCommitSha: true,
            fetchedAt: true,
          },
        });
        return rows.map((row) =>
          item({
            id: row.id,
            label: `Catalog snapshot ${row.id}`,
            status: "pinned",
            updatedAt: row.fetchedAt,
            summary: row.upstreamCommitSha,
          }),
        );
      }
      case "ai-bindings": {
        const rows = await this.client.aiModelBinding.findMany({
          where: { workspaceId },
          orderBy: { id: "asc" },
          take,
          ...cursor,
          select: {
            id: true,
            role: true,
            lifecycle: true,
            revision: true,
            activeVersionId: true,
            draftVersionId: true,
            createdAt: true,
          },
        });
        return rows.map((row) =>
          item({
            id: row.id,
            label: row.role,
            status: row.lifecycle,
            version: String(row.revision),
            updatedAt: row.createdAt,
            summary: row.activeVersionId ?? row.draftVersionId ?? undefined,
          }),
        );
      }
      case "ai-role-defaults": {
        const rows = await this.client.aiWorkspaceBindingDefault.findMany({
          where: { workspaceId },
          orderBy: { role: "asc" },
          take,
          select: {
            role: true,
            modelBindingVersionId: true,
            revision: true,
            updatedAt: true,
          },
        });
        return rows.map((row) =>
          item({
            id: row.role,
            label: row.role,
            status: "configured",
            version: String(row.revision),
            updatedAt: row.updatedAt,
            summary: `binding ${row.modelBindingVersionId}`,
          }),
        );
      }
      case "ai-pricing-overrides": {
        const rows = await this.client.aiWorkspacePriceOverride.findMany({
          where: { workspaceId },
          orderBy: { id: "asc" },
          take,
          ...cursor,
          select: {
            id: true,
            provider: true,
            canonicalModel: true,
            source: true,
            createdAt: true,
          },
        });
        return rows.map((row) =>
          item({
            id: row.id,
            label: row.canonicalModel,
            status: "priced",
            updatedAt: row.createdAt,
            summary: `${row.provider} · ${row.source}`,
          }),
        );
      }
      case "ai-budgets": {
        const rows = await this.client.aiBudgetPolicy.findMany({
          where: { workspaceId },
          orderBy: { id: "asc" },
          take,
          ...cursor,
          select: {
            id: true,
            scope: true,
            scopeKey: true,
            hard: true,
            active: true,
            revision: true,
            createdAt: true,
          },
        });
        return rows.map((row) =>
          item({
            id: row.id,
            label: `${row.scope} · ${row.scopeKey}`,
            status: row.active ? (row.hard ? "hard" : "soft") : "disabled",
            version: String(row.revision),
            updatedAt: row.createdAt,
          }),
        );
      }
      case "collections": {
        const rows = await this.client.knowledgeCollection.findMany({
          where: { workspaceId },
          orderBy: { id: "asc" },
          take,
          ...cursor,
          select: {
            id: true,
            dimensions: true,
            embeddingProfileVersion: true,
            createdAt: true,
          },
        });
        return rows.map((row) =>
          item({
            id: row.id,
            status: "active",
            version: row.embeddingProfileVersion,
            updatedAt: row.createdAt,
            summary: `${row.dimensions} dimensions`,
          }),
        );
      }
      case "analysis-profiles": {
        const rows = await this.client.analysisProfile.findMany({
          where: { workspaceId },
          orderBy: { id: "asc" },
          take,
          ...cursor,
          select: { id: true, lifecycle: true, createdAt: true },
        });
        return rows.map((row) =>
          item({ id: row.id, status: row.lifecycle, updatedAt: row.createdAt }),
        );
      }
      case "retrieval-profiles":
      case "prompt-profiles": {
        const rows = await this.client.administrationConfiguration.findMany({
          where: { workspaceId, resourceType: input.resource },
          orderBy: { id: "asc" },
          take,
          ...cursor,
          select: {
            id: true,
            lifecycle: true,
            revision: true,
            updatedAt: true,
          },
        });
        return rows.map((row) =>
          item({
            id: row.id,
            status: row.lifecycle,
            version: String(row.revision),
            updatedAt: row.updatedAt,
          }),
        );
      }
      case "analyses":
      case "operation-jobs": {
        const rows = await this.client.analysisJob.findMany({
          where: { workspaceId },
          orderBy: { id: "asc" },
          take,
          ...cursor,
          select: { id: true, state: true, runOrdinal: true, updatedAt: true },
        });
        return rows.map((row) =>
          item({
            id: row.id,
            status: row.state,
            version: String(row.runOrdinal),
            updatedAt: row.updatedAt,
          }),
        );
      }
      case "publications": {
        const rows = await this.client.publicationIntent.findMany({
          where: { workspaceId },
          orderBy: { id: "asc" },
          take,
          ...cursor,
          select: {
            id: true,
            state: true,
            updatedAt: true,
            analysisJobId: true,
          },
        });
        return rows.map((row) =>
          item({
            id: row.id,
            status: row.state,
            updatedAt: row.updatedAt,
            summary: `analysis ${row.analysisJobId}`,
          }),
        );
      }
      case "dead-letters": {
        const rows = await this.client.analysisAttempt.findMany({
          where: { workspaceId, state: "failed" },
          orderBy: { id: "asc" },
          take,
          ...cursor,
          select: {
            id: true,
            analysisJobId: true,
            errorCode: true,
            errorRetryable: true,
            finishedAt: true,
          },
        });
        return rows.map((row) =>
          item({
            id: row.analysisJobId,
            label: row.analysisJobId,
            status: row.errorRetryable ? "retryable" : "failed",
            updatedAt: row.finishedAt ?? undefined,
            summary: row.errorCode ?? "failure recorded",
          }),
        );
      }
      case "costs": {
        const rows = await this.client.aiOperation.findMany({
          where: { workspaceId },
          orderBy: { id: "asc" },
          take,
          ...cursor,
          select: {
            id: true,
            configuredModel: true,
            status: true,
            startedAt: true,
            role: true,
          },
        });
        return rows.map((row) =>
          item({
            id: row.id,
            label: row.configuredModel,
            status: row.status,
            updatedAt: row.startedAt,
            summary: row.role,
          }),
        );
      }
      case "retention": {
        const [attachments, derivatives] = await Promise.all([
          this.client.attachment.count({
            where: { workspaceId, retentionExpiresAt: { not: null } },
          }),
          this.client.attachmentDerivative.count({
            where: { workspaceId, retentionExpiresAt: { not: null } },
          }),
        ]);
        return [
          item({
            id: "retention-summary",
            label: "Retention work",
            status: "server-managed",
            summary: `${attachments} attachments and ${derivatives} derivatives have retention deadlines.`,
          }),
        ];
      }
      case "privacy": {
        const rows = await this.client.caseSnapshot.findMany({
          where: { workspaceId, tombstonedAt: null },
          orderBy: { id: "asc" },
          take,
          ...cursor,
          select: { id: true, observedAt: true },
        });
        return rows.map((row) =>
          item({
            id: row.id,
            label: `Case snapshot ${row.id}`,
            status: "eligible",
            updatedAt: row.observedAt,
            summary:
              "Request a governed privacy purge. Snapshot content is never displayed here.",
          }),
        );
      }
      case "diagnostics":
        return [
          item({
            id: "diagnostics-runtime",
            label: "Diagnostics posture",
            status: "redacted",
            summary:
              "Diagnostics are server-generated, bounded, and omit secrets, tokens, request bodies, and protected content.",
          }),
        ];
      case "audit-events": {
        const rows = await this.client.auditEvent.findMany({
          where: { workspaceId },
          orderBy: { occurredAt: "desc" },
          take,
          select: {
            id: true,
            action: true,
            outcome: true,
            occurredAt: true,
            targetType: true,
          },
        });
        return rows.map((row) =>
          item({
            id: row.id,
            label: row.action,
            status: row.outcome ?? "recorded",
            updatedAt: row.occurredAt,
            summary: row.targetType ?? "audit",
          }),
        );
      }
      case "workspaces":
        return [
          item({ id: workspaceId, label: workspaceId, status: "active" }),
        ];
      case "principals": {
        const rows = await this.client.principal.findMany({
          where: { workspaceId },
          orderBy: { id: "asc" },
          take,
          ...cursor,
          select: { id: true, createdAt: true },
        });
        return rows.map((row) =>
          item({ id: row.id, status: "enabled", updatedAt: row.createdAt }),
        );
      }
      case "role-assignments": {
        const rows = await this.client.workspaceRoleAssignment.findMany({
          where: { workspaceId },
          orderBy: [{ principalId: "asc" }, { role: "asc" }],
          take,
          select: { principalId: true, role: true, createdAt: true },
        });
        return rows.map((row) =>
          item({
            id: `${row.principalId}:${row.role}`,
            label: row.principalId,
            status: row.role,
            updatedAt: row.createdAt,
          }),
        );
      }
      case "platform":
        return [
          item({
            id: "platform-runtime",
            label: "Runtime configuration",
            status: "read-only",
            summary:
              "Deployment-owned bootstrap and readiness state; no secret values are exposed.",
          }),
        ];
      default:
        return [];
    }
  }
}
