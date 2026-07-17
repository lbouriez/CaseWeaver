import {
  AdministrationValidationError,
  type AnalysisRecipeConfigurationProjection,
  type AttachmentPolicyConfigurationProjection,
  type CaseAnalysisScheduleConfigurationProjection,
  type CaseAnalysisTriggerConfigurationProjection,
  type CodeRepositoryConfigurationProjection,
  type ConfigurationLifecycleStore,
  type RepositoryAnalysisConfigurationProjectionStore,
  type RepositoryExecutionPolicyConfigurationProjection,
} from "@caseweaver/administration";
import type { ApplicationTransaction } from "@caseweaver/application";
import type { Prisma } from "@prisma/client";

import type { PostgresTransactionLookup } from "../index.js";
import { PostgresConfigurationLifecycleStore } from "./configuration-store.js";

type RepositoryAnalysisResource =
  | "code-repositories"
  | "repository-execution-policies"
  | "attachment-policies"
  | "analysis-recipes"
  | "case-analysis-triggers"
  | "case-analysis-schedules"
  | "retrieval-profiles"
  | "prompt-profiles"
  | "knowledge-sources"
  | "webhook-endpoints";

type PersistedConfiguration = Readonly<{
  readonly version: number;
  readonly secretReferenceCount: number;
}>;

/**
 * Transaction-bound PostgreSQL projection store for repository-assisted
 * analysis administration. Generic immutable administration versions own
 * write-only settings and secret references; this store records only the
 * safe, workspace-scoped pins needed by feature runtime composition.
 */
export class PostgresRepositoryAnalysisConfigurationStore
  implements RepositoryAnalysisConfigurationProjectionStore
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

  public createDraftRevision: RepositoryAnalysisConfigurationProjectionStore["createDraftRevision"] =
    (input) => this.configurations.createDraftRevision(input);

  public findMutation: ConfigurationLifecycleStore["findMutation"] = (input) =>
    this.configurations.findMutation(input);

  public loadVersion: ConfigurationLifecycleStore["loadVersion"] = (input) =>
    this.configurations.loadVersion(input);

  public transition: ConfigurationLifecycleStore["transition"] = (input) =>
    this.configurations.transition(input);

  public recordMutation: ConfigurationLifecycleStore["recordMutation"] = (
    input,
  ) => this.configurations.recordMutation(input);

  public async writeCodeRepository(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly lifecycle: "enabled" | "disabled";
      readonly repository: CodeRepositoryConfigurationProjection;
    }>,
  ): Promise<void> {
    const configuration = await this.requireConfiguration({
      workspaceId: input.workspaceId,
      resourceType: "code-repositories",
      configurationId: input.repository.repositoryId,
      configurationVersionId: input.configurationVersionId,
      lifecycle: input.lifecycle,
    });
    const database = this.database();
    const existing = await database.codeRepositoryVersion.findUnique({
      where: {
        workspaceId_configurationVersionId: {
          workspaceId: input.workspaceId,
          configurationVersionId: input.configurationVersionId,
        },
      },
      select: {
        id: true,
        mode: true,
        allowedRefKinds: true,
        checkoutCredentialRequired: true,
      },
    });
    const mode = input.repository.mode;
    const allowedRefKinds = canonicalStringArray(
      input.repository.allowedRefKinds,
    );
    const checkoutCredentialRequired = configuration.secretReferenceCount > 0;
    if (existing !== null) {
      if (
        existing.id !== input.configurationVersionId ||
        existing.mode !== mode ||
        !sameStringArray(existing.allowedRefKinds, allowedRefKinds) ||
        existing.checkoutCredentialRequired !== checkoutCredentialRequired
      ) {
        throw new AdministrationValidationError();
      }
      return;
    }
    await database.codeRepositoryVersion.create({
      data: {
        id: input.configurationVersionId,
        workspaceId: input.workspaceId,
        configurationVersionId: input.configurationVersionId,
        mode,
        allowedRefKinds,
        checkoutCredentialRequired,
      },
    });
  }

  public async writeRepositoryExecutionPolicy(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly lifecycle: "enabled" | "disabled";
      readonly policy: RepositoryExecutionPolicyConfigurationProjection;
    }>,
  ): Promise<void> {
    await Promise.all([
      this.requireConfiguration({
        workspaceId: input.workspaceId,
        resourceType: "repository-execution-policies",
        configurationId: input.policy.executionPolicyId,
        configurationVersionId: input.configurationVersionId,
        lifecycle: input.lifecycle,
      }),
      this.requireRepositoryAgentBinding({
        workspaceId: input.workspaceId,
        bindingVersionId: input.policy.repositoryAgentBindingVersionId,
        requireActive: input.lifecycle === "enabled",
      }),
    ]);
    const database = this.database();
    const existing = await database.repositoryExecutionPolicyVersion.findUnique(
      {
        where: {
          workspaceId_configurationVersionId: {
            workspaceId: input.workspaceId,
            configurationVersionId: input.configurationVersionId,
          },
        },
        select: {
          id: true,
          repositoryAgentBindingVersionId: true,
          sandboxPolicyVersionId: true,
          readOnlyToolAllowlist: true,
          networkDisabled: true,
          maximumDurationMilliseconds: true,
          maximumTurns: true,
          maximumToolCalls: true,
          maximumOutputTokens: true,
          maximumCpuMilliseconds: true,
          maximumMemoryBytes: true,
          maximumOutputBytes: true,
        },
      },
    );
    const allowedTools = canonicalStringArray(input.policy.allowedTools);
    if (existing !== null) {
      if (
        existing.id !== input.configurationVersionId ||
        existing.repositoryAgentBindingVersionId !==
          input.policy.repositoryAgentBindingVersionId ||
        existing.sandboxPolicyVersionId !==
          input.policy.sandboxPolicyVersionId ||
        !sameStringArray(existing.readOnlyToolAllowlist, allowedTools) ||
        existing.networkDisabled !== true ||
        existing.maximumDurationMilliseconds !==
          input.policy.maximumDurationMs ||
        existing.maximumTurns !== input.policy.maximumTurns ||
        existing.maximumToolCalls !== input.policy.maximumToolCalls ||
        existing.maximumOutputTokens !== input.policy.maximumOutputTokens ||
        existing.maximumCpuMilliseconds !==
          input.policy.maximumCpuMilliseconds ||
        existing.maximumMemoryBytes !==
          BigInt(input.policy.maximumMemoryBytes) ||
        existing.maximumOutputBytes !== BigInt(input.policy.maximumOutputBytes)
      ) {
        throw new AdministrationValidationError();
      }
      return;
    }
    await database.repositoryExecutionPolicyVersion.create({
      data: {
        id: input.configurationVersionId,
        workspaceId: input.workspaceId,
        configurationVersionId: input.configurationVersionId,
        repositoryAgentBindingVersionId:
          input.policy.repositoryAgentBindingVersionId,
        sandboxPolicyVersionId: input.policy.sandboxPolicyVersionId,
        readOnlyToolAllowlist: allowedTools,
        networkDisabled: true,
        maximumDurationMilliseconds: input.policy.maximumDurationMs,
        maximumTurns: input.policy.maximumTurns,
        maximumToolCalls: input.policy.maximumToolCalls,
        maximumOutputTokens: input.policy.maximumOutputTokens,
        maximumCpuMilliseconds: input.policy.maximumCpuMilliseconds,
        maximumMemoryBytes: BigInt(input.policy.maximumMemoryBytes),
        maximumOutputBytes: BigInt(input.policy.maximumOutputBytes),
      },
    });
  }

  public async writeAttachmentPolicy(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly lifecycle: "enabled" | "disabled";
      readonly policy: AttachmentPolicyConfigurationProjection;
    }>,
  ): Promise<void> {
    await this.requireConfiguration({
      workspaceId: input.workspaceId,
      resourceType: "attachment-policies",
      configurationId: input.policy.attachmentPolicyId,
      configurationVersionId: input.configurationVersionId,
      lifecycle: input.lifecycle,
    });
    const database = this.database();
    const existing = await database.attachmentPolicyVersion.findUnique({
      where: {
        workspaceId_configurationVersionId: {
          workspaceId: input.workspaceId,
          configurationVersionId: input.configurationVersionId,
        },
      },
      select: {
        id: true,
        processorSecurityPolicyVersionId: true,
        visionBindingVersionId: true,
        maximumAttachmentCount: true,
        maximumAttachmentBytes: true,
        maximumArchiveEntries: true,
        maximumExpandedArchiveBytes: true,
        maximumArchiveDepth: true,
      },
    });
    if (existing !== null) {
      if (!sameAttachmentPolicy(existing, input)) {
        throw new AdministrationValidationError();
      }
      return;
    }
    await database.attachmentPolicyVersion.create({
      data: attachmentPolicyData(input),
    });
  }

  public async writeAnalysisRecipe(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly lifecycle: "enabled" | "disabled";
      readonly recipe: AnalysisRecipeConfigurationProjection;
    }>,
  ): Promise<void> {
    await this.requireConfiguration({
      workspaceId: input.workspaceId,
      resourceType: "analysis-recipes",
      configurationId: input.recipe.recipeId,
      configurationVersionId: input.configurationVersionId,
      lifecycle: input.lifecycle,
    });
    await this.requireAnalysisRecipeReferences({
      ...input,
      requireActive: input.lifecycle === "enabled",
    });
    const database = this.database();
    const existing = await database.analysisRecipeVersion.findUnique({
      where: {
        workspaceId_configurationVersionId: {
          workspaceId: input.workspaceId,
          configurationVersionId: input.configurationVersionId,
        },
      },
      select: {
        id: true,
        analysisProfileVersionId: true,
        analysisBindingVersionId: true,
        retrievalProfileVersionId: true,
        promptProfileVersionId: true,
        publicationProfileVersionId: true,
        attachmentPolicyVersionId: true,
        attachmentStageMode: true,
        codeRepositoryVersionId: true,
        repositoryExecutionPolicyVersionId: true,
        repositoryStageMode: true,
      },
    });
    const data = analysisRecipeData(input);
    if (existing !== null) {
      if (!sameAnalysisRecipe(existing, data)) {
        throw new AdministrationValidationError();
      }
      return;
    }
    await database.analysisRecipeVersion.create({ data });
  }

  public async writeCaseAnalysisTrigger(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly lifecycle: "enabled" | "disabled";
      readonly automatedPrincipalId?: string;
      readonly trigger: CaseAnalysisTriggerConfigurationProjection;
    }>,
  ): Promise<void> {
    const configuration = await this.requireConfiguration({
      workspaceId: input.workspaceId,
      resourceType: "case-analysis-triggers",
      configurationId: input.trigger.triggerId,
      configurationVersionId: input.configurationVersionId,
      lifecycle: input.lifecycle,
    });
    const recipe = await this.requireTriggerReferences({
      ...input,
      requireActive: input.lifecycle === "enabled",
    });
    const database = this.database();
    const existingVersion = await database.analysisTriggerVersion.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: input.configurationVersionId,
        },
      },
      select: {
        analysisTriggerId: true,
        version: true,
        analysisProfileVersionId: true,
        connectorRegistrationId: true,
        connectorConfigurationVersionId: true,
      },
    });
    if (existingVersion === null) {
      await database.analysisTrigger.upsert({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.trigger.triggerId,
          },
        },
        create: {
          id: input.trigger.triggerId,
          workspaceId: input.workspaceId,
          lifecycle: "disabled",
          revision: configuration.version,
        },
        update: {},
      });
      await database.analysisTriggerVersion.create({
        data: {
          id: input.configurationVersionId,
          workspaceId: input.workspaceId,
          analysisTriggerId: input.trigger.triggerId,
          version: configuration.version,
          analysisProfileVersionId: recipe.analysisProfileVersionId,
          connectorRegistrationId: input.trigger.connectorRegistrationId,
          connectorConfigurationVersionId:
            input.trigger.connectorConfigurationVersionId,
        },
      });
    } else if (
      existingVersion.analysisTriggerId !== input.trigger.triggerId ||
      existingVersion.version !== configuration.version ||
      existingVersion.analysisProfileVersionId !==
        recipe.analysisProfileVersionId ||
      existingVersion.connectorRegistrationId !==
        input.trigger.connectorRegistrationId ||
      existingVersion.connectorConfigurationVersionId !==
        input.trigger.connectorConfigurationVersionId
    ) {
      throw new AdministrationValidationError();
    }

    if (input.lifecycle === "disabled") {
      await database.analysisTrigger.update({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.trigger.triggerId,
          },
        },
        data: { lifecycle: "disabled", revision: configuration.version },
      });
      return;
    }

    const automatedPrincipalId = await this.requirePrincipal(
      input.workspaceId,
      input.automatedPrincipalId,
    );
    await database.analysisTrigger.update({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: input.trigger.triggerId,
        },
      },
      data: {
        lifecycle: "active",
        revision: configuration.version,
        currentVersionId: input.configurationVersionId,
      },
    });
    const mapping = await database.caseAnalysisTriggerRecipeVersion.findUnique({
      where: {
        workspaceId_analysisTriggerVersionId: {
          workspaceId: input.workspaceId,
          analysisTriggerVersionId: input.configurationVersionId,
        },
      },
      select: {
        id: true,
        analysisRecipeVersionId: true,
        automatedPrincipalId: true,
      },
    });
    if (mapping === null) {
      await database.caseAnalysisTriggerRecipeVersion.create({
        data: {
          id: input.configurationVersionId,
          workspaceId: input.workspaceId,
          analysisTriggerVersionId: input.configurationVersionId,
          analysisRecipeVersionId:
            input.trigger.analysisRecipeConfigurationVersionId,
          automatedPrincipalId,
        },
      });
    } else if (
      mapping.id !== input.configurationVersionId ||
      mapping.analysisRecipeVersionId !==
        input.trigger.analysisRecipeConfigurationVersionId ||
      mapping.automatedPrincipalId !== automatedPrincipalId
    ) {
      throw new AdministrationValidationError();
    }
  }

  public async writeCaseAnalysisSchedule(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly lifecycle: "enabled" | "disabled";
      readonly automatedPrincipalId?: string;
      readonly schedule: CaseAnalysisScheduleConfigurationProjection;
    }>,
  ): Promise<void> {
    await this.requireConfiguration({
      workspaceId: input.workspaceId,
      resourceType: "case-analysis-schedules",
      configurationId: input.schedule.scheduleId,
      configurationVersionId: input.configurationVersionId,
      lifecycle: input.lifecycle,
    });
    await this.requireReferencedConfiguration({
      workspaceId: input.workspaceId,
      resourceType: "case-analysis-triggers",
      configurationId: input.schedule.triggerId,
      configurationVersionId: input.schedule.triggerConfigurationVersionId,
      requireActive: input.lifecycle === "enabled",
    });
    if (input.lifecycle === "enabled") {
      await this.requirePrincipal(
        input.workspaceId,
        input.automatedPrincipalId,
      );
    } else if (input.automatedPrincipalId !== undefined) {
      throw new AdministrationValidationError();
    }
    const database = this.database();
    const cadence = jsonObject(input.schedule.cadence);
    const existing = await database.caseAnalysisIntakeSchedule.findUnique({
      where: {
        workspaceId_configurationVersionId: {
          workspaceId: input.workspaceId,
          configurationVersionId: input.configurationVersionId,
        },
      },
      select: {
        id: true,
        scheduleId: true,
        analysisTriggerConfigurationVersionId: true,
        automatedPrincipalId: true,
        cadence: true,
        nextRunAt: true,
        enabled: true,
      },
    });
    if (existing !== null) {
      if (
        existing.id !== input.configurationVersionId ||
        existing.scheduleId !== input.schedule.scheduleId ||
        existing.analysisTriggerConfigurationVersionId !==
          input.schedule.triggerConfigurationVersionId ||
        existing.automatedPrincipalId !==
          (input.automatedPrincipalId ?? null) ||
        canonicalJson(existing.cadence) !== canonicalJson(cadence) ||
        existing.nextRunAt.toISOString() !== input.schedule.nextRunAt ||
        existing.enabled !== (input.lifecycle === "enabled")
      ) {
        throw new AdministrationValidationError();
      }
      return;
    }
    await database.caseAnalysisIntakeSchedule.create({
      data: {
        // This is an immutable schedule-version projection. The schedule ID is
        // its stable aggregate; the generic immutable configuration version is
        // the durable execution pin.
        id: input.configurationVersionId,
        workspaceId: input.workspaceId,
        scheduleId: input.schedule.scheduleId,
        configurationVersionId: input.configurationVersionId,
        analysisTriggerConfigurationVersionId:
          input.schedule.triggerConfigurationVersionId,
        ...(input.automatedPrincipalId === undefined
          ? {}
          : { automatedPrincipalId: input.automatedPrincipalId }),
        cadence,
        nextRunAt: new Date(input.schedule.nextRunAt),
        enabled: input.lifecycle === "enabled",
      },
    });
  }

  private database() {
    return this.transactions.get(this.transaction);
  }

  private async requireConfiguration(
    input: Readonly<{
      readonly workspaceId: string;
      readonly resourceType: RepositoryAnalysisResource;
      readonly configurationId: string;
      readonly configurationVersionId: string;
      readonly lifecycle: "enabled" | "disabled";
    }>,
  ): Promise<PersistedConfiguration> {
    const database = this.database();
    const [configuration, version] = await Promise.all([
      database.administrationConfiguration.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.configurationId,
          },
        },
        select: { resourceType: true, lifecycle: true, currentVersionId: true },
      }),
      database.administrationConfigurationVersion.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.configurationVersionId,
          },
        },
        select: {
          configurationId: true,
          version: true,
          secretReferenceCount: true,
        },
      }),
    ]);
    if (
      configuration === null ||
      configuration.resourceType !== input.resourceType ||
      configuration.currentVersionId !== input.configurationVersionId ||
      version === null ||
      version.configurationId !== input.configurationId ||
      !lifecycleMatches(configuration.lifecycle, input.lifecycle) ||
      !Number.isSafeInteger(version.secretReferenceCount) ||
      version.secretReferenceCount < 0
    ) {
      throw new AdministrationValidationError();
    }
    return Object.freeze({
      version: version.version,
      secretReferenceCount: version.secretReferenceCount,
    });
  }

  private async requireReferencedConfiguration(
    input: Readonly<{
      readonly workspaceId: string;
      readonly resourceType: RepositoryAnalysisResource;
      readonly configurationId: string;
      readonly configurationVersionId: string;
      readonly requireActive: boolean;
    }>,
  ): Promise<void> {
    const database = this.database();
    const [configuration, version] = await Promise.all([
      database.administrationConfiguration.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.configurationId,
          },
        },
        select: { resourceType: true, lifecycle: true },
      }),
      database.administrationConfigurationVersion.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.configurationVersionId,
          },
        },
        select: { configurationId: true },
      }),
    ]);
    if (
      configuration === null ||
      configuration.resourceType !== input.resourceType ||
      (input.requireActive && configuration.lifecycle !== "active") ||
      version === null ||
      version.configurationId !== input.configurationId
    ) {
      throw new AdministrationValidationError();
    }
  }

  /**
   * Recipe projections select retrieval/prompt immutable versions directly.
   * Resolve their owning aggregate inside PostgreSQL before reusing the normal
   * workspace/resource/lifecycle validation so a cross-resource or cross-workspace
   * version cannot be pinned into a draft or activation.
   */
  private async requireReferencedConfigurationVersion(
    input: Readonly<{
      readonly workspaceId: string;
      readonly resourceType: RepositoryAnalysisResource;
      readonly configurationVersionId: string;
      readonly requireActive: boolean;
    }>,
  ): Promise<void> {
    const version =
      await this.database().administrationConfigurationVersion.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.configurationVersionId,
          },
        },
        select: { configurationId: true },
      });
    if (version === null) throw new AdministrationValidationError();
    await this.requireReferencedConfiguration({
      workspaceId: input.workspaceId,
      resourceType: input.resourceType,
      configurationId: version.configurationId,
      configurationVersionId: input.configurationVersionId,
      requireActive: input.requireActive,
    });
  }

  private async requireAnalysisRecipeReferences(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly recipe: AnalysisRecipeConfigurationProjection;
      readonly requireActive: boolean;
    }>,
  ): Promise<void> {
    const database = this.database();
    const [profile, binding, publication] = await Promise.all([
      database.analysisProfileVersion.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.recipe.analysisProfileVersionId,
          },
        },
        select: { analysisProfileId: true },
      }),
      database.aiModelBindingVersion.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.recipe.analysisBindingVersionId,
          },
        },
        select: { id: true, modelBindingId: true },
      }),
      database.publicationProfileVersion.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.recipe.publicationProfileVersionId,
          },
        },
        select: { id: true, publicationProfileId: true },
      }),
      this.requireReferencedConfigurationVersion({
        workspaceId: input.workspaceId,
        resourceType: "retrieval-profiles",
        configurationVersionId: input.recipe.retrievalProfileVersionId,
        requireActive: input.requireActive,
      }),
      this.requireReferencedConfigurationVersion({
        workspaceId: input.workspaceId,
        resourceType: "prompt-profiles",
        configurationVersionId: input.recipe.promptProfileVersionId,
        requireActive: input.requireActive,
      }),
    ]);
    if (
      profile === null ||
      profile.analysisProfileId !== input.recipe.analysisProfileId ||
      binding === null ||
      publication === null
    ) {
      throw new AdministrationValidationError();
    }
    if (input.requireActive) {
      const [analysisProfile, bindingAggregate, publicationProfile] =
        await Promise.all([
          database.analysisProfile.findUnique({
            where: {
              workspaceId_id: {
                workspaceId: input.workspaceId,
                id: profile.analysisProfileId,
              },
            },
            select: { lifecycle: true },
          }),
          database.aiModelBinding.findUnique({
            where: {
              workspaceId_id: {
                workspaceId: input.workspaceId,
                id: binding.modelBindingId,
              },
            },
            select: { lifecycle: true, activeVersionId: true },
          }),
          database.publicationProfile.findUnique({
            where: {
              workspaceId_id: {
                workspaceId: input.workspaceId,
                id: publication.publicationProfileId,
              },
            },
            select: { lifecycle: true },
          }),
        ]);
      if (
        analysisProfile?.lifecycle !== "active" ||
        bindingAggregate?.lifecycle !== "active" ||
        bindingAggregate.activeVersionId !==
          input.recipe.analysisBindingVersionId ||
        publicationProfile?.lifecycle !== "active"
      ) {
        throw new AdministrationValidationError();
      }
    }
    if (input.recipe.repositoryStage.mode !== "disabled") {
      const stage = input.recipe.repositoryStage;
      await Promise.all([
        this.requireReferencedConfiguration({
          workspaceId: input.workspaceId,
          resourceType: "code-repositories",
          configurationId: stage.repositoryId as string,
          configurationVersionId:
            stage.repositoryConfigurationVersionId as string,
          requireActive: input.requireActive,
        }),
        this.requireReferencedConfiguration({
          workspaceId: input.workspaceId,
          resourceType: "repository-execution-policies",
          configurationId: stage.executionPolicyId as string,
          configurationVersionId:
            stage.executionPolicyConfigurationVersionId as string,
          requireActive: input.requireActive,
        }),
        this.requireRepositoryAgentBinding({
          workspaceId: input.workspaceId,
          bindingVersionId: stage.repositoryAgentBindingVersionId as string,
          requireActive: input.requireActive,
        }),
      ]);
      const [repository, policy] = await Promise.all([
        database.codeRepositoryVersion.findUnique({
          where: {
            workspaceId_configurationVersionId: {
              workspaceId: input.workspaceId,
              configurationVersionId:
                stage.repositoryConfigurationVersionId as string,
            },
          },
          select: { id: true },
        }),
        database.repositoryExecutionPolicyVersion.findUnique({
          where: {
            workspaceId_configurationVersionId: {
              workspaceId: input.workspaceId,
              configurationVersionId:
                stage.executionPolicyConfigurationVersionId as string,
            },
          },
          select: { id: true, repositoryAgentBindingVersionId: true },
        }),
      ]);
      if (
        repository === null ||
        repository.id !== stage.repositoryConfigurationVersionId ||
        policy === null ||
        policy.id !== stage.executionPolicyConfigurationVersionId ||
        policy.repositoryAgentBindingVersionId !==
          stage.repositoryAgentBindingVersionId
      ) {
        throw new AdministrationValidationError();
      }
    }
    if (input.recipe.attachmentStage.mode !== "disabled") {
      const stage = input.recipe.attachmentStage;
      await this.requireReferencedConfiguration({
        workspaceId: input.workspaceId,
        resourceType: "attachment-policies",
        configurationId: stage.attachmentPolicyId as string,
        configurationVersionId:
          stage.attachmentPolicyConfigurationVersionId as string,
        requireActive: input.requireActive,
      });
      const attachment = await database.attachmentPolicyVersion.findUnique({
        where: {
          workspaceId_configurationVersionId: {
            workspaceId: input.workspaceId,
            configurationVersionId:
              stage.attachmentPolicyConfigurationVersionId as string,
          },
        },
        select: { id: true },
      });
      if (
        attachment === null ||
        attachment.id !== stage.attachmentPolicyConfigurationVersionId
      ) {
        throw new AdministrationValidationError();
      }
    }
  }

  private async requireTriggerReferences(
    input: Readonly<{
      readonly workspaceId: string;
      readonly trigger: CaseAnalysisTriggerConfigurationProjection;
      readonly requireActive: boolean;
    }>,
  ): Promise<Readonly<{ readonly analysisProfileVersionId: string }>> {
    await this.requireReferencedConfiguration({
      workspaceId: input.workspaceId,
      resourceType: "analysis-recipes",
      configurationId: input.trigger.analysisRecipeId,
      configurationVersionId:
        input.trigger.analysisRecipeConfigurationVersionId,
      requireActive: input.requireActive,
    });
    await this.requireReferencedConfiguration({
      workspaceId: input.workspaceId,
      resourceType: "knowledge-sources",
      configurationId: input.trigger.caseSourceId,
      configurationVersionId: input.trigger.caseSourceConfigurationVersionId,
      requireActive: input.requireActive,
    });
    const database = this.database();
    const [source, recipe] = await Promise.all([
      database.knowledgeSource.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.trigger.caseSourceId,
          },
        },
        select: {
          lifecycle: true,
          configurationVersion: true,
          connectorRegistrationId: true,
          connectorConfigurationVersionId: true,
        },
      }),
      database.analysisRecipeVersion.findUnique({
        where: {
          workspaceId_configurationVersionId: {
            workspaceId: input.workspaceId,
            configurationVersionId:
              input.trigger.analysisRecipeConfigurationVersionId,
          },
        },
        select: {
          analysisProfileVersionId: true,
          publicationProfileVersionId: true,
        },
      }),
    ]);
    if (
      source === null ||
      (input.requireActive && source.lifecycle !== "enabled") ||
      source.configurationVersion !==
        input.trigger.caseSourceConfigurationVersionId ||
      source.connectorRegistrationId !==
        input.trigger.connectorRegistrationId ||
      source.connectorConfigurationVersionId !==
        input.trigger.connectorConfigurationVersionId ||
      recipe === null ||
      recipe.publicationProfileVersionId !==
        input.trigger.publicationProfileVersionId
    ) {
      throw new AdministrationValidationError();
    }
    if (input.trigger.ingress === "verifiedWebhook") {
      const webhookEndpointId = input.trigger.webhookEndpointId;
      const webhookEndpointConfigurationVersionId =
        input.trigger.webhookEndpointConfigurationVersionId;
      if (
        webhookEndpointId === undefined ||
        webhookEndpointConfigurationVersionId === undefined
      ) {
        throw new AdministrationValidationError();
      }
      await this.requireReferencedConfiguration({
        workspaceId: input.workspaceId,
        resourceType: "webhook-endpoints",
        configurationId: webhookEndpointId,
        configurationVersionId: webhookEndpointConfigurationVersionId,
        requireActive: input.requireActive,
      });
      if (!input.requireActive)
        return Object.freeze({
          analysisProfileVersionId: recipe.analysisProfileVersionId,
        });
      const endpoint = await database.webhookEndpoint.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: webhookEndpointId,
          },
        },
        select: {
          lifecycle: true,
          endpointConfigurationVersionId: true,
          analysisTriggerId: true,
        },
      });
      if (
        endpoint === null ||
        endpoint.lifecycle !== "active" ||
        endpoint.endpointConfigurationVersionId !==
          webhookEndpointConfigurationVersionId ||
        endpoint.analysisTriggerId !== input.trigger.triggerId
      ) {
        throw new AdministrationValidationError();
      }
    }
    return Object.freeze({
      analysisProfileVersionId: recipe.analysisProfileVersionId,
    });
  }

  private async requirePrincipal(
    workspaceId: string,
    principalId: string | undefined,
  ): Promise<string> {
    if (principalId === undefined) throw new AdministrationValidationError();
    const principal = await this.database().principal.findUnique({
      where: { workspaceId_id: { workspaceId, id: principalId } },
      select: { id: true },
    });
    if (principal === null) throw new AdministrationValidationError();
    return principalId;
  }

  /**
   * Repository execution is permitted only through an immutable binding whose
   * aggregate role and declared capabilities match the attested agent contract.
   * Drafts may preserve an inactive historical binding, but activation must
   * target the aggregate's current active version.
   */
  private async requireRepositoryAgentBinding(
    input: Readonly<{
      readonly workspaceId: string;
      readonly bindingVersionId: string;
      readonly requireActive: boolean;
    }>,
  ): Promise<void> {
    const database = this.database();
    const version = await database.aiModelBindingVersion.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: input.bindingVersionId,
        },
      },
      select: { modelBindingId: true, capabilities: true },
    });
    if (
      version === null ||
      !hasRepositoryAgentCapabilities(version.capabilities)
    ) {
      throw new AdministrationValidationError();
    }
    const binding = await database.aiModelBinding.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: version.modelBindingId,
        },
      },
      select: { role: true, lifecycle: true, activeVersionId: true },
    });
    if (
      binding === null ||
      binding.role !== "repositoryAgent" ||
      (input.requireActive &&
        (binding.lifecycle !== "active" ||
          binding.activeVersionId !== input.bindingVersionId))
    ) {
      throw new AdministrationValidationError();
    }
  }
}

function lifecycleMatches(
  persisted: string,
  requested: "enabled" | "disabled",
): boolean {
  return requested === "enabled"
    ? persisted === "active"
    : persisted === "draft" || persisted === "disabled";
}

function canonicalStringArray(
  values: readonly string[],
): Prisma.InputJsonArray {
  return [...new Set(values)].sort();
}

function hasRepositoryAgentCapabilities(value: Prisma.JsonValue): boolean {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string") &&
    value.includes("repositoryAgent") &&
    value.includes("tools")
  );
}

function sameStringArray(
  persisted: Prisma.JsonValue,
  expected: Prisma.InputJsonArray,
): boolean {
  return (
    Array.isArray(persisted) &&
    persisted.length === expected.length &&
    persisted.every(
      (value, index) => typeof value === "string" && value === expected[index],
    )
  );
}

function attachmentPolicyData(
  input: Readonly<{
    readonly workspaceId: string;
    readonly configurationVersionId: string;
    readonly policy: AttachmentPolicyConfigurationProjection;
  }>,
) {
  return {
    id: input.configurationVersionId,
    workspaceId: input.workspaceId,
    configurationVersionId: input.configurationVersionId,
    processorSecurityPolicyVersionId:
      input.policy.processorSecurityPolicyVersionId,
    visionBindingVersionId: input.policy.visionBindingVersionId,
    maximumAttachmentCount: input.policy.maximumAttachmentCount,
    maximumAttachmentBytes: BigInt(input.policy.maximumAttachmentBytes),
    maximumArchiveEntries: input.policy.maximumArchiveEntries,
    maximumExpandedArchiveBytes: BigInt(
      input.policy.maximumExpandedArchiveBytes,
    ),
    maximumArchiveDepth: input.policy.maximumArchiveDepth,
  };
}

function sameAttachmentPolicy(
  existing: Readonly<{
    readonly id: string;
    readonly processorSecurityPolicyVersionId: string;
    readonly visionBindingVersionId: string;
    readonly maximumAttachmentCount: number;
    readonly maximumAttachmentBytes: bigint;
    readonly maximumArchiveEntries: number;
    readonly maximumExpandedArchiveBytes: bigint;
    readonly maximumArchiveDepth: number;
  }>,
  input: Readonly<{
    readonly configurationVersionId: string;
    readonly policy: AttachmentPolicyConfigurationProjection;
  }>,
): boolean {
  return (
    existing.id === input.configurationVersionId &&
    existing.processorSecurityPolicyVersionId ===
      input.policy.processorSecurityPolicyVersionId &&
    existing.visionBindingVersionId === input.policy.visionBindingVersionId &&
    existing.maximumAttachmentCount === input.policy.maximumAttachmentCount &&
    existing.maximumAttachmentBytes ===
      BigInt(input.policy.maximumAttachmentBytes) &&
    existing.maximumArchiveEntries === input.policy.maximumArchiveEntries &&
    existing.maximumExpandedArchiveBytes ===
      BigInt(input.policy.maximumExpandedArchiveBytes) &&
    existing.maximumArchiveDepth === input.policy.maximumArchiveDepth
  );
}

function analysisRecipeData(
  input: Readonly<{
    readonly workspaceId: string;
    readonly configurationVersionId: string;
    readonly recipe: AnalysisRecipeConfigurationProjection;
  }>,
) {
  const repository = input.recipe.repositoryStage;
  const attachment = input.recipe.attachmentStage;
  return {
    id: input.configurationVersionId,
    workspaceId: input.workspaceId,
    configurationVersionId: input.configurationVersionId,
    analysisProfileVersionId: input.recipe.analysisProfileVersionId,
    analysisBindingVersionId: input.recipe.analysisBindingVersionId,
    retrievalProfileVersionId: input.recipe.retrievalProfileVersionId,
    promptProfileVersionId: input.recipe.promptProfileVersionId,
    publicationProfileVersionId: input.recipe.publicationProfileVersionId,
    attachmentPolicyVersionId:
      attachment.mode === "disabled"
        ? null
        : attachment.attachmentPolicyConfigurationVersionId,
    attachmentStageMode: attachment.mode,
    codeRepositoryVersionId:
      repository.mode === "disabled"
        ? null
        : repository.repositoryConfigurationVersionId,
    repositoryExecutionPolicyVersionId:
      repository.mode === "disabled"
        ? null
        : repository.executionPolicyConfigurationVersionId,
    repositoryStageMode: repository.mode,
  };
}

function sameAnalysisRecipe(
  existing: Readonly<{
    readonly id: string;
    readonly analysisProfileVersionId: string;
    readonly analysisBindingVersionId: string;
    readonly retrievalProfileVersionId: string | null;
    readonly promptProfileVersionId: string | null;
    readonly publicationProfileVersionId: string | null;
    readonly attachmentPolicyVersionId: string | null;
    readonly attachmentStageMode: string;
    readonly codeRepositoryVersionId: string | null;
    readonly repositoryExecutionPolicyVersionId: string | null;
    readonly repositoryStageMode: string;
  }>,
  expected: ReturnType<typeof analysisRecipeData>,
): boolean {
  return (
    existing.id === expected.id &&
    existing.analysisProfileVersionId === expected.analysisProfileVersionId &&
    existing.analysisBindingVersionId === expected.analysisBindingVersionId &&
    existing.retrievalProfileVersionId === expected.retrievalProfileVersionId &&
    existing.promptProfileVersionId === expected.promptProfileVersionId &&
    existing.publicationProfileVersionId ===
      expected.publicationProfileVersionId &&
    existing.attachmentPolicyVersionId === expected.attachmentPolicyVersionId &&
    existing.attachmentStageMode === expected.attachmentStageMode &&
    existing.codeRepositoryVersionId === expected.codeRepositoryVersionId &&
    existing.repositoryExecutionPolicyVersionId ===
      expected.repositoryExecutionPolicyVersionId &&
    existing.repositoryStageMode === expected.repositoryStageMode
  );
}

function jsonObject(value: object): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

function canonicalJson(
  value: Prisma.JsonValue | Prisma.InputJsonObject,
): string {
  return JSON.stringify(value);
}
