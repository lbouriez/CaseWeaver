import type {
  RepositoryAnalysisTransitionSnapshot,
  RepositoryAnalysisTransitionSnapshotStore,
} from "@caseweaver/administration";
import type { PrismaClient } from "@prisma/client";

type Resource = RepositoryAnalysisTransitionSnapshot["resource"];

/**
 * Private current-version reader for successor lifecycle transitions. The
 * generic version's settings never leave this adapter; the corresponding
 * feature projection row must exist at the exact same immutable version.
 */
export class PostgresRepositoryAnalysisTransitionStore
  implements RepositoryAnalysisTransitionSnapshotStore
{
  public constructor(private readonly client: PrismaClient) {}

  public async resolveTransitionSnapshot(
    input: Parameters<
      RepositoryAnalysisTransitionSnapshotStore["resolveTransitionSnapshot"]
    >[0],
  ): Promise<RepositoryAnalysisTransitionSnapshot | undefined> {
    const configuration =
      await this.client.administrationConfiguration.findFirst({
        where: {
          workspaceId: input.workspaceId,
          id: input.configurationId,
          resourceType: input.resource,
        },
        select: { currentVersionId: true },
      });
    if (configuration?.currentVersionId === null || configuration === null) {
      return undefined;
    }
    const version =
      await this.client.administrationConfigurationVersion.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: configuration.currentVersionId,
          },
        },
        select: {
          configurationId: true,
          settings: true,
          secretReferences: true,
        },
      });
    if (
      version === null ||
      version.configurationId !== input.configurationId ||
      !isStringArray(version.secretReferences)
    ) {
      return undefined;
    }
    const settings = jsonRecord(version.settings);
    if (settings === undefined) return undefined;
    const projection = jsonRecord(settings.repositoryAnalysisProjection);
    if (projection === undefined) return undefined;
    if (
      !(await this.hasProjection(
        input.workspaceId,
        input.resource,
        configuration.currentVersionId,
      ))
    ) {
      return undefined;
    }
    return snapshot({
      resource: input.resource,
      configurationId: input.configurationId,
      settings,
      secretReferenceIds: version.secretReferences,
      projection,
    });
  }

  private async hasProjection(
    workspaceId: string,
    resource: Resource,
    configurationVersionId: string,
  ): Promise<boolean> {
    switch (resource) {
      case "code-repositories":
        return (
          (await this.client.codeRepositoryVersion.findUnique({
            where: {
              workspaceId_configurationVersionId: {
                workspaceId,
                configurationVersionId,
              },
            },
            select: { id: true },
          })) !== null
        );
      case "repository-execution-policies":
        return (
          (await this.client.repositoryExecutionPolicyVersion.findUnique({
            where: {
              workspaceId_configurationVersionId: {
                workspaceId,
                configurationVersionId,
              },
            },
            select: { id: true },
          })) !== null
        );
      case "attachment-policies":
        return (
          (await this.client.attachmentPolicyVersion.findUnique({
            where: {
              workspaceId_configurationVersionId: {
                workspaceId,
                configurationVersionId,
              },
            },
            select: { id: true },
          })) !== null
        );
      case "analysis-recipes":
        return (
          (await this.client.analysisRecipeVersion.findUnique({
            where: {
              workspaceId_configurationVersionId: {
                workspaceId,
                configurationVersionId,
              },
            },
            select: { id: true },
          })) !== null
        );
      case "case-analysis-triggers":
        return (
          (await this.client.analysisTriggerVersion.findUnique({
            where: {
              workspaceId_id: { workspaceId, id: configurationVersionId },
            },
            select: { id: true },
          })) !== null
        );
      case "case-analysis-schedules":
        return (
          (await this.client.caseAnalysisIntakeSchedule.findUnique({
            where: {
              workspaceId_configurationVersionId: {
                workspaceId,
                configurationVersionId,
              },
            },
            select: { id: true },
          })) !== null
        );
    }
  }
}

function snapshot(input: {
  readonly resource: Resource;
  readonly configurationId: string;
  readonly settings: Record<string, unknown>;
  readonly secretReferenceIds: readonly string[];
  readonly projection: Record<string, unknown>;
}): RepositoryAnalysisTransitionSnapshot | undefined {
  const command = Object.freeze({
    settings: Object.freeze({ ...input.settings }),
    secretReferenceIds: Object.freeze([...input.secretReferenceIds]),
    projection: Object.freeze({ ...input.projection }),
  });
  if (
    !sameIdentifier(
      projectionId(input.resource, command.projection),
      input.configurationId,
    )
  ) {
    return undefined;
  }
  // The administration manager performs the authoritative feature validation
  // before it writes a successor. This narrow cast only rehydrates the exact
  // private immutable material it previously created; no request data enters.
  return Object.freeze({
    resource: input.resource,
    command,
  }) as unknown as RepositoryAnalysisTransitionSnapshot;
}

function projectionId(
  resource: Resource,
  projection: Record<string, unknown>,
): unknown {
  switch (resource) {
    case "code-repositories":
      return projection.repositoryId;
    case "repository-execution-policies":
      return projection.executionPolicyId;
    case "attachment-policies":
      return projection.attachmentPolicyId;
    case "analysis-recipes":
      return projection.recipeId;
    case "case-analysis-triggers":
      return projection.triggerId;
    case "case-analysis-schedules":
      return projection.scheduleId;
  }
}

function sameIdentifier(value: unknown, expected: string): boolean {
  return (
    typeof value === "string" &&
    value === expected &&
    value.length > 0 &&
    value.length <= 1_024
  );
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "string" && entry.length > 0 && entry.length <= 1_024,
    )
  );
}
