import type {
  AdministrationDetailDto,
  AdministrationListItemDto,
  CursorPageDto,
} from "@caseweaver/administration";
import type { Prisma, PrismaClient } from "@prisma/client";

export const repositoryAnalysisReadResources = [
  "code-repositories",
  "repository-execution-policies",
  "attachment-policies",
  "analysis-recipes",
  "case-analysis-triggers",
  "case-analysis-schedules",
] as const;

export type RepositoryAnalysisReadResource =
  (typeof repositoryAnalysisReadResources)[number];

/**
 * Safe specialized read projection used by the generic administration reader.
 * It reads configuration lifecycle/display metadata and explicitly allowlisted
 * immutable projection columns. It never selects `settings`, `secret_references`,
 * private checkout candidate material, or protected analysis content.
 */
export class PostgresRepositoryAnalysisResourceReadStore {
  public constructor(private readonly client: PrismaClient) {}

  public supports(
    resource: string,
  ): resource is RepositoryAnalysisReadResource {
    return repositoryAnalysisReadResources.includes(
      resource as RepositoryAnalysisReadResource,
    );
  }

  public async list(input: {
    readonly workspaceId: string;
    readonly resource: RepositoryAnalysisReadResource;
    readonly limit: number;
    readonly after?: string;
  }): Promise<CursorPageDto<AdministrationListItemDto>> {
    assertLimit(input.limit);
    const rows = await this.client.administrationConfiguration.findMany({
      where: { workspaceId: input.workspaceId, resourceType: input.resource },
      orderBy: { id: "asc" },
      take: input.limit + 1,
      ...idCursor(input.after),
      select: {
        id: true,
        lifecycle: true,
        revision: true,
        currentVersionId: true,
        updatedAt: true,
      },
    });
    const items = await Promise.all(
      rows.map(async (row) =>
        this.item({
          workspaceId: input.workspaceId,
          id: row.id,
          lifecycle: row.lifecycle,
          revision: row.revision,
          currentVersionId: row.currentVersionId,
          updatedAt: row.updatedAt,
        }),
      ),
    );
    const visible = items.slice(0, input.limit);
    const final = visible.at(-1);
    return Object.freeze({
      items: Object.freeze(visible),
      page: Object.freeze({
        hasNextPage: items.length > input.limit,
        ...(items.length > input.limit && final !== undefined
          ? { endCursor: final.id }
          : {}),
      }),
    });
  }

  public async detail(input: {
    readonly workspaceId: string;
    readonly resource: RepositoryAnalysisReadResource;
    readonly id: string;
  }): Promise<AdministrationDetailDto | undefined> {
    const configuration =
      await this.client.administrationConfiguration.findFirst({
        where: {
          workspaceId: input.workspaceId,
          resourceType: input.resource,
          id: input.id,
        },
        select: {
          id: true,
          lifecycle: true,
          revision: true,
          currentVersionId: true,
          updatedAt: true,
        },
      });
    if (configuration === null) return undefined;
    const item = await this.item({
      workspaceId: input.workspaceId,
      id: configuration.id,
      lifecycle: configuration.lifecycle,
      revision: configuration.revision,
      currentVersionId: configuration.currentVersionId,
      updatedAt: configuration.updatedAt,
    });
    return Object.freeze({
      ...item,
      fields: Object.freeze({
        lifecycle: configuration.lifecycle,
        revision: configuration.revision,
        ...(configuration.currentVersionId === null
          ? {}
          : { currentVersionId: configuration.currentVersionId }),
        ...(await this.projectionFields({
          workspaceId: input.workspaceId,
          resource: input.resource,
          configurationVersionId: configuration.currentVersionId,
        })),
      }),
    });
  }

  private async item(input: {
    readonly workspaceId: string;
    readonly id: string;
    readonly lifecycle: string;
    readonly revision: number;
    readonly currentVersionId: string | null;
    readonly updatedAt: Date;
  }): Promise<AdministrationListItemDto> {
    const version =
      input.currentVersionId === null
        ? undefined
        : await this.client.administrationConfigurationVersion.findUnique({
            where: {
              workspaceId_id: {
                workspaceId: input.workspaceId,
                id: input.currentVersionId,
              },
            },
            select: { configurationId: true, displayName: true },
          });
    const label =
      version === null ||
      version === undefined ||
      version.configurationId !== input.id ||
      version.displayName === null
        ? input.id
        : version.displayName;
    return Object.freeze({
      id: input.id,
      label,
      status: input.lifecycle,
      version: String(input.revision),
      updatedAt: input.updatedAt.toISOString(),
      summary:
        "Immutable configuration; sensitive settings remain server-private.",
    });
  }

  private async projectionFields(input: {
    readonly workspaceId: string;
    readonly resource: RepositoryAnalysisReadResource;
    readonly configurationVersionId: string | null;
  }): Promise<Readonly<Record<string, string | number | boolean | null>>> {
    if (input.configurationVersionId === null) return Object.freeze({});
    switch (input.resource) {
      case "code-repositories": {
        const value = await this.client.codeRepositoryVersion.findUnique({
          where: {
            workspaceId_configurationVersionId: {
              workspaceId: input.workspaceId,
              configurationVersionId: input.configurationVersionId,
            },
          },
          select: {
            mode: true,
            allowedRefKinds: true,
            checkoutCredentialRequired: true,
          },
        });
        if (value === null) return Object.freeze({});
        return Object.freeze({
          mode: value.mode,
          allowedRefKindCount: safeStringArray(value.allowedRefKinds).length,
          checkoutCredentialRequired: value.checkoutCredentialRequired,
        });
      }
      case "repository-execution-policies": {
        const value =
          await this.client.repositoryExecutionPolicyVersion.findUnique({
            where: {
              workspaceId_configurationVersionId: {
                workspaceId: input.workspaceId,
                configurationVersionId: input.configurationVersionId,
              },
            },
            select: {
              networkDisabled: true,
              readOnlyToolAllowlist: true,
              maximumDurationMilliseconds: true,
              maximumTurns: true,
              maximumToolCalls: true,
              maximumOutputTokens: true,
            },
          });
        if (value === null) return Object.freeze({});
        return Object.freeze({
          networkDisabled: value.networkDisabled,
          allowedToolCount: safeStringArray(value.readOnlyToolAllowlist).length,
          maximumDurationMilliseconds: value.maximumDurationMilliseconds,
          maximumTurns: value.maximumTurns,
          maximumToolCalls: value.maximumToolCalls,
          maximumOutputTokens: value.maximumOutputTokens,
        });
      }
      case "attachment-policies": {
        const value = await this.client.attachmentPolicyVersion.findUnique({
          where: {
            workspaceId_configurationVersionId: {
              workspaceId: input.workspaceId,
              configurationVersionId: input.configurationVersionId,
            },
          },
          select: {
            maximumAttachmentCount: true,
            maximumAttachmentBytes: true,
            maximumArchiveEntries: true,
            maximumExpandedArchiveBytes: true,
            maximumArchiveDepth: true,
          },
        });
        if (value === null) return Object.freeze({});
        return Object.freeze({
          maximumAttachmentCount: value.maximumAttachmentCount,
          maximumAttachmentBytes: value.maximumAttachmentBytes.toString(),
          maximumArchiveEntries: value.maximumArchiveEntries,
          maximumExpandedArchiveBytes:
            value.maximumExpandedArchiveBytes.toString(),
          maximumArchiveDepth: value.maximumArchiveDepth,
        });
      }
      case "analysis-recipes": {
        const value = await this.client.analysisRecipeVersion.findUnique({
          where: {
            workspaceId_configurationVersionId: {
              workspaceId: input.workspaceId,
              configurationVersionId: input.configurationVersionId,
            },
          },
          select: {
            repositoryStageMode: true,
            attachmentStageMode: true,
            codeRepositoryVersionId: true,
            attachmentPolicyVersionId: true,
          },
        });
        if (value === null) return Object.freeze({});
        return Object.freeze({
          repositoryStageMode: value.repositoryStageMode,
          attachmentStageMode: value.attachmentStageMode,
          hasRepositoryStage: value.codeRepositoryVersionId !== null,
          hasAttachmentStage: value.attachmentPolicyVersionId !== null,
        });
      }
      case "case-analysis-triggers": {
        const value = await this.client.analysisTriggerVersion.findUnique({
          where: {
            workspaceId_id: {
              workspaceId: input.workspaceId,
              id: input.configurationVersionId,
            },
          },
          select: { version: true },
        });
        return value === null
          ? Object.freeze({})
          : Object.freeze({ triggerVersion: value.version });
      }
      case "case-analysis-schedules": {
        const value = await this.client.caseAnalysisIntakeSchedule.findUnique({
          where: {
            workspaceId_configurationVersionId: {
              workspaceId: input.workspaceId,
              configurationVersionId: input.configurationVersionId,
            },
          },
          select: { enabled: true, nextRunAt: true },
        });
        return value === null
          ? Object.freeze({})
          : Object.freeze({
              enabled: value.enabled,
              nextRunAt: value.nextRunAt.toISOString(),
            });
      }
    }
  }
}

function idCursor(after: string | undefined): Readonly<{
  readonly cursor?: Prisma.AdministrationConfigurationWhereUniqueInput;
  readonly skip?: number;
}> {
  return after === undefined ? {} : { cursor: { id: after }, skip: 1 };
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new RangeError("Repository-analysis read page limit is invalid.");
  }
}

function safeStringArray(value: Prisma.JsonValue): readonly string[] {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : [];
}
