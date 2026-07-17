import type {
  CaseSourceRepositoryAnalysisOption,
  CheckoutSecretReferenceOption,
  RepositoryAnalysisOptionLifecycle,
  RepositoryAnalysisOptionsCatalog,
  RepositoryAnalysisVersionOption,
  RepositoryAnalysisWorkspaceOptions,
} from "@caseweaver/administration";
import type { PrismaClient } from "@prisma/client";

const activeAuthoringOptionLimit = 200;

/**
 * Safe workspace authoring catalog for repository-assisted analysis. Queries
 * deliberately select identity, lifecycle, immutable version, and display-name
 * fields only; no configuration JSON, URL, ref, deployment alias, locator, or
 * secret material is read into this adapter's output.
 */
export class PostgresRepositoryAnalysisOptionsStore
  implements RepositoryAnalysisOptionsCatalog
{
  public constructor(private readonly client: PrismaClient) {}

  public async listWorkspaceOptions(
    input: Parameters<
      RepositoryAnalysisOptionsCatalog["listWorkspaceOptions"]
    >[0],
  ): Promise<RepositoryAnalysisWorkspaceOptions> {
    const [
      codeRepositories,
      repositoryExecutionPolicies,
      attachmentPolicies,
      retrievalProfiles,
      promptProfiles,
      webhookEndpoints,
      analysisProfiles,
      publicationProfiles,
      repositoryAgentBindings,
      analysisBindings,
      visionBindings,
      analysisRecipes,
      caseAnalysisTriggers,
      caseSources,
      checkoutSecretReferences,
    ] = await Promise.all([
      this.configurationOptions(input.workspaceId, "code-repositories"),
      this.configurationOptions(
        input.workspaceId,
        "repository-execution-policies",
      ),
      this.configurationOptions(input.workspaceId, "attachment-policies"),
      this.configurationOptions(input.workspaceId, "retrieval-profiles"),
      this.configurationOptions(input.workspaceId, "prompt-profiles"),
      this.configurationOptions(input.workspaceId, "webhook-endpoints"),
      this.analysisProfileOptions(input.workspaceId),
      this.publicationProfileOptions(input.workspaceId),
      this.repositoryAgentBindingOptions(input.workspaceId),
      this.analysisBindingOptions(input.workspaceId),
      this.visionBindingOptions(input.workspaceId),
      this.analysisRecipeOptions(input.workspaceId),
      this.caseAnalysisTriggerOptions(input.workspaceId),
      this.caseSourceOptions(input.workspaceId),
      this.checkoutSecretReferenceOptions(input.workspaceId),
    ]);
    return Object.freeze({
      codeRepositories,
      repositoryExecutionPolicies,
      attachmentPolicies,
      analysisProfiles,
      retrievalProfiles,
      promptProfiles,
      publicationProfiles,
      repositoryAgentBindings,
      analysisBindings,
      visionBindings,
      analysisRecipes,
      caseAnalysisTriggers,
      caseSources,
      webhookEndpoints,
      checkoutSecretReferences,
    });
  }

  private async configurationOptions(
    workspaceId: string,
    resourceType:
      | "code-repositories"
      | "repository-execution-policies"
      | "attachment-policies"
      | "retrieval-profiles"
      | "prompt-profiles"
      | "webhook-endpoints",
  ): Promise<readonly RepositoryAnalysisVersionOption[]> {
    const configurations =
      await this.client.administrationConfiguration.findMany({
        where: { workspaceId, resourceType },
        orderBy: { id: "asc" },
        select: { id: true, lifecycle: true, currentVersionId: true },
      });
    const values = await Promise.all(
      configurations.map(async (configuration) => {
        if (configuration.currentVersionId === null) return undefined;
        const version =
          await this.client.administrationConfigurationVersion.findUnique({
            where: {
              workspaceId_id: {
                workspaceId,
                id: configuration.currentVersionId,
              },
            },
            select: { configurationId: true, displayName: true },
          });
        if (version === null || version.configurationId !== configuration.id) {
          return undefined;
        }
        return option({
          id: configuration.id,
          versionId: configuration.currentVersionId,
          label: version.displayName ?? configuration.id,
          lifecycle: configurationLifecycle(configuration.lifecycle),
        });
      }),
    );
    return freezeOptions(values);
  }

  private async analysisProfileOptions(
    workspaceId: string,
  ): Promise<readonly RepositoryAnalysisVersionOption[]> {
    const profiles = await this.client.analysisProfile.findMany({
      where: { workspaceId },
      orderBy: { id: "asc" },
      select: { id: true, lifecycle: true },
    });
    const versions = await this.client.analysisProfileVersion.findMany({
      where: {
        workspaceId,
        analysisProfileId: { in: profiles.map(({ id }) => id) },
      },
      orderBy: [
        { analysisProfileId: "asc" },
        { version: "desc" },
        { id: "asc" },
      ],
      select: { id: true, analysisProfileId: true },
    });
    const lifecycleByProfile = new Map(
      profiles.map((profile) => [
        profile.id,
        profileLifecycle(profile.lifecycle),
      ]),
    );
    return freezeOptions(
      versions.flatMap((version) => {
        const lifecycle = lifecycleByProfile.get(version.analysisProfileId);
        return lifecycle === undefined
          ? []
          : [
              option({
                id: version.analysisProfileId,
                versionId: version.id,
                label: version.analysisProfileId,
                lifecycle,
              }),
            ];
      }),
    );
  }

  private async publicationProfileOptions(
    workspaceId: string,
  ): Promise<readonly RepositoryAnalysisVersionOption[]> {
    const profiles = await this.client.publicationProfile.findMany({
      where: { workspaceId },
      orderBy: { id: "asc" },
      select: { id: true, lifecycle: true },
    });
    const versions = await this.client.publicationProfileVersion.findMany({
      where: {
        workspaceId,
        publicationProfileId: { in: profiles.map(({ id }) => id) },
      },
      orderBy: [
        { publicationProfileId: "asc" },
        { version: "desc" },
        { id: "asc" },
      ],
      select: { id: true, publicationProfileId: true },
    });
    const lifecycleByProfile = new Map(
      profiles.map((profile) => [
        profile.id,
        profileLifecycle(profile.lifecycle),
      ]),
    );
    return freezeOptions(
      versions.flatMap((version) => {
        const lifecycle = lifecycleByProfile.get(version.publicationProfileId);
        return lifecycle === undefined
          ? []
          : [
              option({
                id: version.publicationProfileId,
                versionId: version.id,
                label: version.publicationProfileId,
                lifecycle,
              }),
            ];
      }),
    );
  }

  private async repositoryAgentBindingOptions(
    workspaceId: string,
  ): Promise<readonly RepositoryAnalysisVersionOption[]> {
    const bindings = await this.client.aiModelBinding.findMany({
      where: {
        workspaceId,
        role: "repositoryAgent",
        lifecycle: "active",
        activeVersionId: { not: null },
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        role: true,
        lifecycle: true,
        activeVersionId: true,
      },
    });
    const activeVersionIds = bindings.flatMap((binding) =>
      binding.activeVersionId === null ? [] : [binding.activeVersionId],
    );
    if (activeVersionIds.length === 0) return Object.freeze([]);
    const versions = await this.client.aiModelBindingVersion.findMany({
      where: { workspaceId, id: { in: activeVersionIds } },
      select: { id: true, modelBindingId: true, capabilities: true },
    });
    const versionById = new Map(
      versions.map((version) => [version.id, version]),
    );
    return freezeOptions(
      bindings.flatMap((binding) => {
        if (binding.activeVersionId === null) return [];
        const version = versionById.get(binding.activeVersionId);
        if (
          binding.role !== "repositoryAgent" ||
          binding.lifecycle !== "active" ||
          version === undefined ||
          version.modelBindingId !== binding.id ||
          !hasRepositoryAgentCapabilities(version.capabilities)
        ) {
          return [];
        }
        return [
          option({
            id: binding.id,
            versionId: version.id,
            label: binding.id,
            lifecycle: "active",
          }),
        ];
      }),
    );
  }

  /**
   * Analysis bindings are selectable only when the aggregate is active and
   * its active pointer still names one workspace-owned immutable version.
   * Model/provider metadata and private binding settings remain unread.
   */
  private async analysisBindingOptions(
    workspaceId: string,
  ): Promise<readonly RepositoryAnalysisVersionOption[]> {
    const bindings = await this.client.aiModelBinding.findMany({
      where: {
        workspaceId,
        role: "analysis",
        lifecycle: "active",
        activeVersionId: { not: null },
      },
      orderBy: { id: "asc" },
      take: activeAuthoringOptionLimit,
      select: { id: true, role: true, lifecycle: true, activeVersionId: true },
    });
    const activeVersionIds = bindings.flatMap((binding) =>
      binding.activeVersionId === null ? [] : [binding.activeVersionId],
    );
    if (activeVersionIds.length === 0) return Object.freeze([]);
    const versions = await this.client.aiModelBindingVersion.findMany({
      where: { workspaceId, id: { in: activeVersionIds } },
      take: activeAuthoringOptionLimit,
      select: { id: true, modelBindingId: true },
    });
    const versionById = new Map(
      versions.map((version) => [version.id, version]),
    );
    return freezeOptions(
      bindings.flatMap((binding) => {
        if (binding.activeVersionId === null) return [];
        const version = versionById.get(binding.activeVersionId);
        if (
          binding.role !== "analysis" ||
          binding.lifecycle !== "active" ||
          version === undefined ||
          version.modelBindingId !== binding.id
        ) {
          return [];
        }
        return [
          option({
            id: binding.id,
            versionId: version.id,
            label: binding.id,
            lifecycle: "active",
          }),
        ];
      }),
    );
  }

  /** Vision is a separate role: an attachment policy must never select an
   * analysis-only binding merely because both happen to be active. */
  private async visionBindingOptions(
    workspaceId: string,
  ): Promise<readonly RepositoryAnalysisVersionOption[]> {
    const bindings = await this.client.aiModelBinding.findMany({
      where: {
        workspaceId,
        role: "vision",
        lifecycle: "active",
        activeVersionId: { not: null },
      },
      orderBy: { id: "asc" },
      take: activeAuthoringOptionLimit,
      select: { id: true, role: true, lifecycle: true, activeVersionId: true },
    });
    const activeVersionIds = bindings.flatMap((binding) =>
      binding.activeVersionId === null ? [] : [binding.activeVersionId],
    );
    if (activeVersionIds.length === 0) return Object.freeze([]);
    const versions = await this.client.aiModelBindingVersion.findMany({
      where: { workspaceId, id: { in: activeVersionIds } },
      take: activeAuthoringOptionLimit,
      select: { id: true, modelBindingId: true },
    });
    const versionById = new Map(
      versions.map((version) => [version.id, version]),
    );
    return freezeOptions(
      bindings.flatMap((binding) => {
        if (binding.activeVersionId === null) return [];
        const version = versionById.get(binding.activeVersionId);
        if (
          binding.role !== "vision" ||
          binding.lifecycle !== "active" ||
          version === undefined ||
          version.modelBindingId !== binding.id
        ) {
          return [];
        }
        return [
          option({
            id: binding.id,
            versionId: version.id,
            label: binding.id,
            lifecycle: "active",
          }),
        ];
      }),
    );
  }

  /**
   * A trigger may select only an enabled analysis-recipe projection—not merely
   * a generic configuration row with a matching resource name.
   */
  private async analysisRecipeOptions(
    workspaceId: string,
  ): Promise<readonly RepositoryAnalysisVersionOption[]> {
    const configurations =
      await this.client.administrationConfiguration.findMany({
        where: {
          workspaceId,
          resourceType: "analysis-recipes",
          lifecycle: "active",
          currentVersionId: { not: null },
        },
        orderBy: { id: "asc" },
        take: activeAuthoringOptionLimit,
        select: { id: true, lifecycle: true, currentVersionId: true },
      });
    const values = await Promise.all(
      configurations.map(async (configuration) => {
        if (configuration.currentVersionId === null) return undefined;
        const [version, projection] = await Promise.all([
          this.client.administrationConfigurationVersion.findUnique({
            where: {
              workspaceId_id: {
                workspaceId,
                id: configuration.currentVersionId,
              },
            },
            select: { configurationId: true, displayName: true },
          }),
          this.client.analysisRecipeVersion.findUnique({
            where: {
              workspaceId_configurationVersionId: {
                workspaceId,
                configurationVersionId: configuration.currentVersionId,
              },
            },
            select: { id: true, configurationVersionId: true },
          }),
        ]);
        if (
          configuration.lifecycle !== "active" ||
          version === null ||
          version.configurationId !== configuration.id ||
          projection === null ||
          projection.id !== configuration.currentVersionId ||
          projection.configurationVersionId !== configuration.currentVersionId
        ) {
          return undefined;
        }
        return option({
          id: configuration.id,
          versionId: configuration.currentVersionId,
          label: version.displayName ?? configuration.id,
          lifecycle: "active",
        });
      }),
    );
    return freezeOptions(values);
  }

  /**
   * Schedules may pin only a fully activated trigger: its generic configuration
   * pointer and the PBI-012 trigger aggregate/projection must name the same
   * workspace-scoped immutable version.
   */
  private async caseAnalysisTriggerOptions(
    workspaceId: string,
  ): Promise<readonly RepositoryAnalysisVersionOption[]> {
    const configurations =
      await this.client.administrationConfiguration.findMany({
        where: {
          workspaceId,
          resourceType: "case-analysis-triggers",
          lifecycle: "active",
          currentVersionId: { not: null },
        },
        orderBy: { id: "asc" },
        take: activeAuthoringOptionLimit,
        select: { id: true, lifecycle: true, currentVersionId: true },
      });
    const values = await Promise.all(
      configurations.map(async (configuration) => {
        if (configuration.currentVersionId === null) return undefined;
        const [version, trigger, projection] = await Promise.all([
          this.client.administrationConfigurationVersion.findUnique({
            where: {
              workspaceId_id: {
                workspaceId,
                id: configuration.currentVersionId,
              },
            },
            select: { configurationId: true, displayName: true },
          }),
          this.client.analysisTrigger.findUnique({
            where: {
              workspaceId_id: {
                workspaceId,
                id: configuration.id,
              },
            },
            select: { lifecycle: true, currentVersionId: true },
          }),
          this.client.analysisTriggerVersion.findUnique({
            where: {
              workspaceId_id: {
                workspaceId,
                id: configuration.currentVersionId,
              },
            },
            select: { id: true, analysisTriggerId: true },
          }),
        ]);
        if (
          configuration.lifecycle !== "active" ||
          version === null ||
          version.configurationId !== configuration.id ||
          trigger === null ||
          trigger.lifecycle !== "active" ||
          trigger.currentVersionId !== configuration.currentVersionId ||
          projection === null ||
          projection.id !== configuration.currentVersionId ||
          projection.analysisTriggerId !== configuration.id
        ) {
          return undefined;
        }
        return option({
          id: configuration.id,
          versionId: configuration.currentVersionId,
          label: version.displayName ?? configuration.id,
          lifecycle: "active",
        });
      }),
    );
    return freezeOptions(values);
  }

  private async caseSourceOptions(
    workspaceId: string,
  ): Promise<readonly CaseSourceRepositoryAnalysisOption[]> {
    const sources = await this.client.knowledgeSource.findMany({
      where: { workspaceId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        lifecycle: true,
        configurationVersion: true,
        connectorRegistrationId: true,
        connectorConfigurationVersionId: true,
      },
    });
    const values = await Promise.all(
      sources.map(async (source) => {
        if (source.connectorConfigurationVersionId === null) return undefined;
        const version =
          await this.client.administrationConfigurationVersion.findUnique({
            where: {
              workspaceId_id: {
                workspaceId,
                id: source.configurationVersion,
              },
            },
            select: { configurationId: true, displayName: true },
          });
        if (version === null || version.configurationId !== source.id) {
          return undefined;
        }
        const lifecycle = sourceLifecycle(source.lifecycle);
        return Object.freeze({
          sourceId: source.id,
          sourceConfigurationVersionId: source.configurationVersion,
          connectorRegistrationId: source.connectorRegistrationId,
          connectorConfigurationVersionId:
            source.connectorConfigurationVersionId,
          label: version.displayName ?? source.id,
          lifecycle,
          eligibleForDraft: lifecycle !== "disabled",
          eligibleForActivation: lifecycle === "active",
        });
      }),
    );
    return Object.freeze(
      values
        .filter(
          (value): value is CaseSourceRepositoryAnalysisOption =>
            value !== undefined,
        )
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    );
  }

  private async checkoutSecretReferenceOptions(
    workspaceId: string,
  ): Promise<readonly CheckoutSecretReferenceOption[]> {
    const registrations = await this.client.credentialRegistration.findMany({
      where: { workspaceId },
      orderBy: { id: "asc" },
      select: { id: true, lifecycle: true },
    });
    return Object.freeze(
      registrations.map((registration) => {
        const lifecycle = credentialLifecycle(registration.lifecycle);
        return Object.freeze({
          secretReferenceId: registration.id,
          label: `Secret reference ${registration.id}`,
          lifecycle,
          eligibleForDraft: lifecycle !== "disabled",
          eligibleForActivation: lifecycle === "active",
        });
      }),
    );
  }
}

function option(input: {
  readonly id: string;
  readonly versionId: string;
  readonly label: string;
  readonly lifecycle: RepositoryAnalysisOptionLifecycle;
}): RepositoryAnalysisVersionOption {
  return Object.freeze({
    ...input,
    eligibleForDraft: input.lifecycle !== "disabled",
    eligibleForActivation: input.lifecycle === "active",
  });
}

function freezeOptions(
  values: readonly (RepositoryAnalysisVersionOption | undefined)[],
): readonly RepositoryAnalysisVersionOption[] {
  return Object.freeze(
    values
      .filter(
        (value): value is RepositoryAnalysisVersionOption =>
          value !== undefined,
      )
      .sort(
        (left, right) =>
          left.id.localeCompare(right.id) ||
          left.versionId.localeCompare(right.versionId),
      ),
  );
}

function configurationLifecycle(
  value: string,
): RepositoryAnalysisOptionLifecycle {
  if (value === "draft") return "draft";
  if (value === "active") return "active";
  return "disabled";
}

function profileLifecycle(value: string): RepositoryAnalysisOptionLifecycle {
  return value === "active" ? "active" : "disabled";
}

function sourceLifecycle(value: string): RepositoryAnalysisOptionLifecycle {
  return value === "enabled" || value === "active" ? "active" : "disabled";
}

function credentialLifecycle(value: string): RepositoryAnalysisOptionLifecycle {
  return value === "active" ? "active" : "disabled";
}

function hasRepositoryAgentCapabilities(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string") &&
    value.includes("repositoryAgent") &&
    value.includes("tools")
  );
}
