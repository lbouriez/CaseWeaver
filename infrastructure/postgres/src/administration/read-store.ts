import type { Permission } from "@caseweaver/security";
import { effectivePermissions, isWorkspaceRole } from "@caseweaver/security";
import type { PrismaClient } from "@prisma/client";

export interface AdministrationReadStore {
  workspaceName(workspaceId: string): Promise<string | undefined>;
  permissionsFor(
    input: Readonly<{ workspaceId: string; principalId: string }>,
  ): Promise<readonly Permission[]>;
  listConfigurations(
    input: Readonly<{
      workspaceId: string;
      resourceType?: string;
      limit: number;
    }>,
  ): Promise<readonly ConfigurationProjection[]>;
  configuration(
    input: Readonly<{ workspaceId: string; id: string }>,
  ): Promise<ConfigurationProjection | undefined>;
  operationJob(
    input: Readonly<{ workspaceId: string; id: string }>,
  ): Promise<
    Readonly<{ state: string; runningLeaseExpiresAt?: string }> | undefined
  >;
  publicationIntent(
    input: Readonly<{ workspaceId: string; id: string }>,
  ): Promise<Readonly<{ state: string }> | undefined>;
  caseSnapshotExists(
    input: Readonly<{ workspaceId: string; id: string }>,
  ): Promise<boolean>;
  knowledgeSource(
    input: Readonly<{ workspaceId: string; id: string }>,
  ): Promise<
    Readonly<{ lifecycle: string; configurationVersion: string }> | undefined
  >;
  secretReferenceDependencies(
    input: Readonly<{ workspaceId: string; secretReferenceId: string }>,
  ): Promise<
    readonly Readonly<{ configurationId: string; resourceType: string }>[]
  >;
}

export interface ConfigurationProjection {
  readonly id: string;
  readonly resourceType: string;
  readonly lifecycle: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly displayName?: string;
  readonly descriptorType?: string;
  readonly descriptorVersion?: string;
}

/** Safe, workspace-bound administration projections. It exposes neither settings nor secret values. */
export class PostgresAdministrationReadStore
  implements AdministrationReadStore
{
  public constructor(private readonly client: PrismaClient) {}
  public async workspaceName(workspaceId: string): Promise<string | undefined> {
    // Workspaces presently have no mutable display-name column; the stable ID is the safe label.
    const row = await this.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    });
    return row?.id;
  }
  public async permissionsFor(
    input: Readonly<{ workspaceId: string; principalId: string }>,
  ): Promise<readonly Permission[]> {
    const rows = await this.client.workspaceRoleAssignment.findMany({
      where: input,
      select: { role: true },
    });
    return effectivePermissions(
      rows.flatMap((row) => (isWorkspaceRole(row.role) ? [row.role] : [])),
    );
  }
  public async listConfigurations(
    input: Readonly<{
      workspaceId: string;
      resourceType?: string;
      limit: number;
    }>,
  ) {
    const rows = await this.client.administrationConfiguration.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(input.resourceType === undefined
          ? {}
          : { resourceType: input.resourceType }),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: input.limit,
      select: {
        id: true,
        resourceType: true,
        lifecycle: true,
        revision: true,
        currentVersionId: true,
        updatedAt: true,
      },
    });
    return Object.freeze(
      await Promise.all(rows.map((row) => this.toConfigurationProjection(row))),
    );
  }
  public async configuration(
    input: Readonly<{ workspaceId: string; id: string }>,
  ) {
    const row = await this.client.administrationConfiguration.findUnique({
      where: { workspaceId_id: input },
      select: {
        id: true,
        resourceType: true,
        lifecycle: true,
        revision: true,
        currentVersionId: true,
        updatedAt: true,
      },
    });
    return row === null ? undefined : this.toConfigurationProjection(row);
  }

  public async operationJob(
    input: Readonly<{ workspaceId: string; id: string }>,
  ) {
    const job = await this.client.analysisJob.findUnique({
      where: { workspaceId_id: input },
      select: { state: true },
    });
    if (job === null) return undefined;
    const attempt =
      job.state !== "running"
        ? undefined
        : await this.client.analysisAttempt.findFirst({
            where: {
              workspaceId: input.workspaceId,
              analysisJobId: input.id,
              state: "running",
            },
            orderBy: { attemptOrdinal: "desc" },
            select: { leaseExpiresAt: true },
          });
    return Object.freeze({
      state: job.state,
      ...(attempt === null || attempt === undefined
        ? {}
        : { runningLeaseExpiresAt: attempt.leaseExpiresAt.toISOString() }),
    });
  }

  public async publicationIntent(
    input: Readonly<{ workspaceId: string; id: string }>,
  ): Promise<Readonly<{ state: string }> | undefined> {
    const intent = await this.client.publicationIntent.findUnique({
      where: { workspaceId_id: input },
      select: { state: true },
    });
    return intent === null ? undefined : Object.freeze({ state: intent.state });
  }

  public async caseSnapshotExists(
    input: Readonly<{ workspaceId: string; id: string }>,
  ): Promise<boolean> {
    const snapshot = await this.client.caseSnapshot.findUnique({
      where: { workspaceId_id: input },
      select: { id: true },
    });
    return snapshot !== null;
  }

  public async knowledgeSource(
    input: Readonly<{ workspaceId: string; id: string }>,
  ): Promise<
    Readonly<{ lifecycle: string; configurationVersion: string }> | undefined
  > {
    const source = await this.client.knowledgeSource.findUnique({
      where: { workspaceId_id: input },
      select: { lifecycle: true, configurationVersion: true },
    });
    return source === null
      ? undefined
      : Object.freeze({
          lifecycle: source.lifecycle,
          configurationVersion: source.configurationVersion,
        });
  }

  public async secretReferenceDependencies(
    input: Readonly<{ workspaceId: string; secretReferenceId: string }>,
  ): Promise<
    readonly Readonly<{ configurationId: string; resourceType: string }>[]
  > {
    const registration = await this.client.credentialRegistration.findFirst({
      where: {
        workspaceId: input.workspaceId,
        id: input.secretReferenceId,
      },
      select: { secretReference: true },
    });
    if (registration === null) return Object.freeze([]);
    const versions =
      await this.client.administrationConfigurationVersion.findMany({
        where: {
          workspaceId: input.workspaceId,
          secretReferences: { array_contains: [registration.secretReference] },
        },
        distinct: ["configurationId"],
        orderBy: [{ configurationId: "asc" }, { version: "desc" }],
        take: 20,
        select: {
          configurationId: true,
          configuration: { select: { resourceType: true } },
        },
      });
    return Object.freeze(
      versions.map((version) =>
        Object.freeze({
          configurationId: version.configurationId,
          resourceType: version.configuration.resourceType,
        }),
      ),
    );
  }

  private async toConfigurationProjection(
    row: Readonly<{
      readonly id: string;
      readonly resourceType: string;
      readonly lifecycle: string;
      readonly revision: number;
      readonly currentVersionId: string | null;
      readonly updatedAt: Date;
    }>,
  ): Promise<ConfigurationProjection> {
    const version =
      row.currentVersionId === null
        ? undefined
        : await this.client.administrationConfigurationVersion.findUnique({
            where: { id: row.currentVersionId },
            select: {
              displayName: true,
              descriptorType: true,
              descriptorVersion: true,
            },
          });
    return Object.freeze({
      id: row.id,
      resourceType: row.resourceType,
      lifecycle: row.lifecycle,
      revision: row.revision,
      updatedAt: row.updatedAt.toISOString(),
      ...(version?.displayName === null || version?.displayName === undefined
        ? {}
        : { displayName: version.displayName }),
      ...(version?.descriptorType === null ||
      version?.descriptorType === undefined
        ? {}
        : { descriptorType: version.descriptorType }),
      ...(version?.descriptorVersion === null ||
      version?.descriptorVersion === undefined
        ? {}
        : { descriptorVersion: version.descriptorVersion }),
    });
  }
}
