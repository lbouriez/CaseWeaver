import type { MutationIdentity } from "./configuration.js";
import type {
  AdministrationTransactionRunner,
  ConfigurationDraftRevisionStore,
  ConfigurationLifecycleAudit,
  ConfigurationLifecycleStore,
  ConfigurationTransitionResult,
} from "./configuration-lifecycle.js";
import {
  CreateConfigurationDraft,
  CreateConfigurationDraftRevision,
  TransitionConfigurationVersion,
} from "./configuration-lifecycle.js";
import {
  type RepositoryConfigurationActivationGuard,
  repositoryDraftCandidateDigest,
} from "./repository-draft-test.js";

/** Stable administration resource names; none is an HTTP route. */
export const codeRepositoryConfigurationResource = "code-repositories";
export const repositoryExecutionPolicyConfigurationResource =
  "repository-execution-policies";
export const attachmentPolicyConfigurationResource = "attachment-policies";
export const analysisRecipeConfigurationResource = "analysis-recipes";
export const caseAnalysisTriggerConfigurationResource =
  "case-analysis-triggers";
export const caseAnalysisScheduleConfigurationResource =
  "case-analysis-schedules";

/** Server-owned lifecycle audit codes. A browser never selects these values. */
export const repositoryAnalysisConfigurationActions = {
  codeRepositoryDraftCreated: "admin.codeRepository.draft.created",
  codeRepositoryDraftRevisionCreated:
    "admin.codeRepository.draftRevision.created",
  codeRepositoryChanged: "admin.codeRepository.configuration.changed",
  repositoryExecutionPolicyDraftCreated:
    "admin.repositoryExecutionPolicy.draft.created",
  repositoryExecutionPolicyDraftRevisionCreated:
    "admin.repositoryExecutionPolicy.draftRevision.created",
  repositoryExecutionPolicyChanged:
    "admin.repositoryExecutionPolicy.configuration.changed",
  attachmentPolicyDraftCreated: "admin.attachmentPolicy.draft.created",
  attachmentPolicyDraftRevisionCreated:
    "admin.attachmentPolicy.draftRevision.created",
  attachmentPolicyChanged: "admin.attachmentPolicy.configuration.changed",
  analysisRecipeDraftCreated: "admin.analysisRecipe.draft.created",
  analysisRecipeDraftRevisionCreated:
    "admin.analysisRecipe.draftRevision.created",
  analysisRecipeChanged: "admin.analysisRecipe.configuration.changed",
  caseAnalysisTriggerDraftCreated: "admin.caseAnalysisTrigger.draft.created",
  caseAnalysisTriggerDraftRevisionCreated:
    "admin.caseAnalysisTrigger.draftRevision.created",
  caseAnalysisTriggerChanged: "admin.caseAnalysisTrigger.configuration.changed",
  caseAnalysisScheduleDraftCreated: "admin.caseAnalysisSchedule.draft.created",
  caseAnalysisScheduleDraftRevisionCreated:
    "admin.caseAnalysisSchedule.draftRevision.created",
  caseAnalysisScheduleChanged:
    "admin.caseAnalysisSchedule.configuration.changed",
} as const;

export type RepositoryAnalysisConfigurationAction =
  (typeof repositoryAnalysisConfigurationActions)[keyof typeof repositoryAnalysisConfigurationActions];

export type CodeRepositoryMode = "deploymentMounted" | "remoteHttps";
export type CodeRepositoryAllowedRefKind = "branch" | "tag" | "commit";
/**
 * The authored ref is immutable configuration input, while a worker still
 * resolves it to a full commit for every analysis run. It deliberately does
 * not permit `HEAD`, arbitrary refspecs, or abbreviated object identifiers.
 */
export type CodeRepositoryCheckoutRef =
  | Readonly<{
      readonly kind: "branch" | "tag";
      readonly name: string;
    }>
  | Readonly<{
      readonly kind: "commit";
      readonly sha: string;
    }>;
export type RepositoryReadOnlyTool = "listFiles" | "readFile" | "searchFiles";
export type AnalysisRecipeStagePolicy = "disabled" | "optional" | "required";
export type CaseAnalysisTriggerIngress = "polling" | "verifiedWebhook";

/**
 * The HTTP boundary derives this from a validated server session. Commands
 * never contain actor, workspace, session, action, permission, or outcome.
 */
export interface TrustedRepositoryAnalysisConfigurationContext {
  readonly workspaceId: string;
  readonly actorPrincipalId: string;
  readonly sessionId: string;
  readonly occurredAt: string;
  readonly origin: "admin_ui" | "api" | "cli";
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly uiActionId?: string;
}

/**
 * The persistence implementation must append this inside the same durable
 * transaction as the immutable version, feature projection, and replay claim.
 */
export interface RepositoryAnalysisConfigurationAuditPort {
  append(
    input: Readonly<{
      readonly context: TrustedRepositoryAnalysisConfigurationContext;
      readonly action: RepositoryAnalysisConfigurationAction;
      readonly record: Parameters<ConfigurationLifecycleAudit["append"]>[0];
    }>,
  ): Promise<void>;
}

/**
 * Safe cross-feature projection of a repository aggregate. Server-private
 * settings can retain a deployment alias or remote URL, but neither belongs in
 * this projection, a DTO, audit event, or error.
 */
export interface CodeRepositoryConfigurationProjection {
  readonly repositoryId: string;
  readonly mode: CodeRepositoryMode;
  readonly allowedRefKinds: readonly CodeRepositoryAllowedRefKind[];
  /** Private settings retain the value; projection keeps it for validation only. */
  readonly configuredCheckoutRef: CodeRepositoryCheckoutRef;
}

/**
 * A provider-neutral, read-only runtime policy. It names no agent product or
 * SDK and can only allow the tools implemented by an attested read-only gateway.
 */
export interface RepositoryExecutionPolicyConfigurationProjection {
  readonly executionPolicyId: string;
  readonly repositoryAgentBindingVersionId: string;
  readonly sandboxPolicyVersionId: string;
  readonly allowedTools: readonly RepositoryReadOnlyTool[];
  readonly networkDisabled: true;
  readonly maximumDurationMs: number;
  readonly maximumTurns: number;
  readonly maximumToolCalls: number;
  readonly maximumOutputTokens: number;
  readonly maximumCpuMilliseconds: number;
  readonly maximumMemoryBytes: number;
  readonly maximumOutputBytes: number;
}

/**
 * Limits and immutable processor/binding identities for attachment handling.
 * MIME rules, public-image domain rules, and other raw settings remain in the
 * feature-owned write-only configuration payload.
 */
export interface AttachmentPolicyConfigurationProjection {
  readonly attachmentPolicyId: string;
  readonly processorSecurityPolicyVersionId: string;
  readonly visionBindingVersionId: string;
  readonly maximumAttachmentCount: number;
  readonly maximumAttachmentBytes: number;
  readonly maximumArchiveEntries: number;
  readonly maximumExpandedArchiveBytes: number;
  readonly maximumArchiveDepth: number;
}

/** Exactly one repository/policy pair is permitted for phase-one analysis. */
export interface AnalysisRecipeRepositoryStageProjection {
  readonly mode: AnalysisRecipeStagePolicy;
  readonly repositoryId?: string;
  readonly repositoryConfigurationVersionId?: string;
  readonly executionPolicyId?: string;
  readonly executionPolicyConfigurationVersionId?: string;
  readonly repositoryAgentBindingVersionId?: string;
}

/** A non-disabled attachment stage must retain one immutable policy pin. */
export interface AnalysisRecipeAttachmentStageProjection {
  readonly mode: AnalysisRecipeStagePolicy;
  readonly attachmentPolicyId?: string;
  readonly attachmentPolicyConfigurationVersionId?: string;
}

/**
 * Feature-owned analysis settings remain opaque here. This projection gives
 * administration/persistence only the immutable cross-feature references it
 * needs to persist a durable analysis profile version without duplicating
 * analysis, retrieval, prompt, budget, attachment, or publication policy.
 */
export interface AnalysisRecipeConfigurationProjection {
  /** Recipe aggregate identity; it is distinct from the selected profile. */
  readonly recipeId: string;
  readonly analysisProfileId: string;
  readonly analysisProfileVersionId: string;
  readonly analysisBindingVersionId: string;
  readonly retrievalProfileVersionId: string;
  readonly promptProfileVersionId: string;
  readonly publicationProfileVersionId: string;
  readonly repositoryStage: AnalysisRecipeRepositoryStageProjection;
  readonly attachmentStage: AnalysisRecipeAttachmentStageProjection;
}

/**
 * An immutable mapping from one ingress source to a recipe/publication. The
 * server records the activating principal separately; it is not browser data.
 */
export interface CaseAnalysisTriggerConfigurationProjection {
  readonly triggerId: string;
  readonly ingress: CaseAnalysisTriggerIngress;
  readonly caseSourceId: string;
  readonly caseSourceConfigurationVersionId: string;
  readonly connectorRegistrationId: string;
  readonly connectorConfigurationVersionId: string;
  readonly analysisRecipeId: string;
  readonly analysisRecipeConfigurationVersionId: string;
  readonly publicationProfileVersionId: string;
  readonly webhookEndpointId?: string;
  readonly webhookEndpointConfigurationVersionId?: string;
}

export type CaseAnalysisScheduleCadence =
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
 * Authoring only. PBI-012/PBI-013 scheduling owns leases, occurrence identity,
 * verified webhook ingress, and durable enqueue; this projection pins its input.
 */
export interface CaseAnalysisScheduleConfigurationProjection {
  readonly scheduleId: string;
  readonly triggerId: string;
  readonly triggerConfigurationVersionId: string;
  readonly cadence: CaseAnalysisScheduleCadence;
  readonly nextRunAt: string;
}

/**
 * Public read models deliberately retain safe metadata only. They never expose
 * repository URLs/refs/mounts, secret identities/locators, paths, raw settings,
 * runtime output, candidate details, or connector errors.
 */
export interface CodeRepositoryConfigurationSummary {
  readonly repositoryId: string;
  readonly configurationVersionId: string;
  readonly lifecycle: "draft" | "active" | "disabled";
  readonly revision: number;
  readonly mode: CodeRepositoryMode;
  readonly allowedRefKinds: readonly CodeRepositoryAllowedRefKind[];
  readonly hasCheckoutSecretReference: boolean;
}

export interface RepositoryExecutionPolicyConfigurationSummary {
  readonly executionPolicyId: string;
  readonly configurationVersionId: string;
  readonly lifecycle: "draft" | "active" | "disabled";
  readonly revision: number;
  readonly repositoryAgentBindingVersionId: string;
  readonly sandboxPolicyVersionId: string;
  readonly allowedTools: readonly RepositoryReadOnlyTool[];
  readonly networkDisabled: true;
  readonly maximumDurationMs: number;
  readonly maximumTurns: number;
  readonly maximumToolCalls: number;
  readonly maximumOutputTokens: number;
}

export interface AttachmentPolicyConfigurationSummary {
  readonly attachmentPolicyId: string;
  readonly configurationVersionId: string;
  readonly lifecycle: "draft" | "active" | "disabled";
  readonly revision: number;
  readonly processorSecurityPolicyVersionId: string;
  readonly visionBindingVersionId: string;
  readonly maximumAttachmentCount: number;
  readonly maximumAttachmentBytes: number;
}

export interface AnalysisRecipeConfigurationSummary {
  readonly recipeId: string;
  readonly analysisProfileId: string;
  readonly configurationVersionId: string;
  readonly lifecycle: "draft" | "active" | "disabled";
  readonly revision: number;
  readonly repositoryStage: AnalysisRecipeStagePolicy;
  readonly attachmentStage: AnalysisRecipeStagePolicy;
  readonly hasRepositorySelection: boolean;
  readonly hasAttachmentPolicy: boolean;
}

export interface CaseAnalysisTriggerConfigurationSummary {
  readonly triggerId: string;
  readonly configurationVersionId: string;
  readonly lifecycle: "draft" | "active" | "disabled";
  readonly revision: number;
  readonly ingress: CaseAnalysisTriggerIngress;
  readonly automationEnabled: boolean;
}

export interface CaseAnalysisScheduleConfigurationSummary {
  readonly scheduleId: string;
  readonly configurationVersionId: string;
  readonly lifecycle: "draft" | "active" | "disabled";
  readonly revision: number;
  readonly cadenceKind: CaseAnalysisScheduleCadence["kind"];
  readonly automationEnabled: boolean;
}

/**
 * The durable adapter verifies workspace ownership, referenced active/retained
 * versions, feature-schema validation, OCC, idempotency, and atomic audit
 * durability before inserting any projection.
 */
export interface RepositoryAnalysisConfigurationProjectionStore
  extends ConfigurationLifecycleStore,
    ConfigurationDraftRevisionStore {
  writeCodeRepository(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly lifecycle: "enabled" | "disabled";
      readonly repository: CodeRepositoryConfigurationProjection;
    }>,
  ): Promise<void>;
  writeRepositoryExecutionPolicy(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly lifecycle: "enabled" | "disabled";
      readonly policy: RepositoryExecutionPolicyConfigurationProjection;
    }>,
  ): Promise<void>;
  writeAttachmentPolicy(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly lifecycle: "enabled" | "disabled";
      readonly policy: AttachmentPolicyConfigurationProjection;
    }>,
  ): Promise<void>;
  writeAnalysisRecipe(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly lifecycle: "enabled" | "disabled";
      readonly recipe: AnalysisRecipeConfigurationProjection;
    }>,
  ): Promise<void>;
  writeCaseAnalysisTrigger(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly lifecycle: "enabled" | "disabled";
      /** Server-owned activation principal; absent for non-active versions. */
      readonly automatedPrincipalId?: string;
      readonly trigger: CaseAnalysisTriggerConfigurationProjection;
    }>,
  ): Promise<void>;
  writeCaseAnalysisSchedule(
    input: Readonly<{
      readonly workspaceId: string;
      readonly configurationVersionId: string;
      readonly lifecycle: "enabled" | "disabled";
      /** Server-owned activation principal; absent for non-active versions. */
      readonly automatedPrincipalId?: string;
      readonly schedule: CaseAnalysisScheduleConfigurationProjection;
    }>,
  ): Promise<void>;
}

interface CreateConfigurationCommand<TProjection> {
  readonly displayName: string;
  /** Feature/adapter-validated write-only settings. They have no generic read DTO. */
  readonly settings: Readonly<Record<string, unknown>>;
  readonly projection: TProjection;
  readonly mutation: MutationIdentity;
}

interface TransitionConfigurationCommand<TProjection>
  extends Omit<CreateConfigurationCommand<TProjection>, "displayName"> {
  readonly displayName?: string;
  readonly expectedRevision: number;
  readonly lifecycle: "active" | "disabled";
  readonly beforeHash?: string;
}

interface CreateDraftRevisionCommand<TProjection>
  extends Omit<TransitionConfigurationCommand<TProjection>, "lifecycle"> {}

export interface CreateCodeRepositoryConfigurationCommand
  extends CreateConfigurationCommand<CodeRepositoryConfigurationProjection> {
  /** Secret-reference identities only; never a locator or secret value. */
  readonly secretReferenceIds: readonly string[];
}

export interface TransitionCodeRepositoryConfigurationCommand
  extends TransitionConfigurationCommand<CodeRepositoryConfigurationProjection> {
  readonly secretReferenceIds: readonly string[];
}

export interface CreateCodeRepositoryDraftRevisionCommand
  extends CreateDraftRevisionCommand<CodeRepositoryConfigurationProjection> {
  readonly secretReferenceIds: readonly string[];
}

export interface CreateRepositoryExecutionPolicyConfigurationCommand
  extends CreateConfigurationCommand<RepositoryExecutionPolicyConfigurationProjection> {}
export interface TransitionRepositoryExecutionPolicyConfigurationCommand
  extends TransitionConfigurationCommand<RepositoryExecutionPolicyConfigurationProjection> {}
export interface CreateRepositoryExecutionPolicyDraftRevisionCommand
  extends CreateDraftRevisionCommand<RepositoryExecutionPolicyConfigurationProjection> {}

export interface CreateAttachmentPolicyConfigurationCommand
  extends CreateConfigurationCommand<AttachmentPolicyConfigurationProjection> {}
export interface TransitionAttachmentPolicyConfigurationCommand
  extends TransitionConfigurationCommand<AttachmentPolicyConfigurationProjection> {}
export interface CreateAttachmentPolicyDraftRevisionCommand
  extends CreateDraftRevisionCommand<AttachmentPolicyConfigurationProjection> {}

export interface CreateAnalysisRecipeConfigurationCommand
  extends CreateConfigurationCommand<AnalysisRecipeConfigurationProjection> {}
export interface TransitionAnalysisRecipeConfigurationCommand
  extends TransitionConfigurationCommand<AnalysisRecipeConfigurationProjection> {}
export interface CreateAnalysisRecipeDraftRevisionCommand
  extends CreateDraftRevisionCommand<AnalysisRecipeConfigurationProjection> {}

export interface CreateCaseAnalysisTriggerConfigurationCommand
  extends CreateConfigurationCommand<CaseAnalysisTriggerConfigurationProjection> {}
export interface TransitionCaseAnalysisTriggerConfigurationCommand
  extends TransitionConfigurationCommand<CaseAnalysisTriggerConfigurationProjection> {}
export interface CreateCaseAnalysisTriggerDraftRevisionCommand
  extends CreateDraftRevisionCommand<CaseAnalysisTriggerConfigurationProjection> {}

export interface CreateCaseAnalysisScheduleConfigurationCommand
  extends CreateConfigurationCommand<CaseAnalysisScheduleConfigurationProjection> {}
export interface TransitionCaseAnalysisScheduleConfigurationCommand
  extends TransitionConfigurationCommand<CaseAnalysisScheduleConfigurationProjection> {}
export interface CreateCaseAnalysisScheduleDraftRevisionCommand
  extends CreateDraftRevisionCommand<CaseAnalysisScheduleConfigurationProjection> {}

export type RepositoryConfigurationTestOutcome =
  | "completed"
  | "failed"
  | "outcome_unknown";

/**
 * A separate in-progress branch prevents an accepted duplicate from being
 * consumed as a completed candidate test by activation code.
 */
export type RepositoryConfigurationTestExecutionResult =
  | Readonly<{
      readonly kind: "inProgress";
      readonly operationId: string;
      readonly outcome: "accepted";
      readonly status: "inProgress";
    }>
  | Readonly<{
      readonly kind: "terminal";
      readonly operationId: string;
      readonly outcome: RepositoryConfigurationTestOutcome;
    }>;

/**
 * Server-only, session-bound candidate test seam. The API stores a validated
 * candidate privately and passes only its opaque ID/digest here. In particular,
 * this contract cannot carry a URL, Git ref, mount, locator, credential, or
 * test output. A confirmation is one-use and expiring in the durable adapter.
 * A live duplicate returns the non-terminal `inProgress` branch. Only durable
 * storage may reclaim a database-time-expired claim according to its lease
 * policy.
 */
export interface RepositoryConfigurationTestPort {
  preview(
    input: Readonly<{
      readonly context: TrustedRepositoryAnalysisConfigurationContext;
      readonly candidateId: string;
      readonly candidateDigest: string;
    }>,
  ): Promise<
    Readonly<{
      readonly confirmationId: string;
      readonly expiresAt: string;
      readonly canConfirm: boolean;
    }>
  >;
  execute(
    input: Readonly<{
      readonly context: TrustedRepositoryAnalysisConfigurationContext;
      readonly candidateId: string;
      readonly candidateDigest: string;
      readonly confirmationId: string;
      readonly idempotencyKeyDigest: string;
    }>,
  ): Promise<RepositoryConfigurationTestExecutionResult>;
}

/**
 * Immutable authoring for repository analysis. Drafts and draft revisions are
 * inert; each successor requires write-only settings to be submitted again.
 * A successful write persists the exact immutable projection in the same
 * transaction as lifecycle/OCC/idempotency/audit state. Replay never rewrites
 * a feature projection.
 */
export class ManageRepositoryAnalysisConfiguration {
  public constructor(
    private readonly transactions: AdministrationTransactionRunner,
    private readonly store: RepositoryAnalysisConfigurationProjectionStore,
    private readonly audit: RepositoryAnalysisConfigurationAuditPort,
    private readonly repositoryActivationGuard: RepositoryConfigurationActivationGuard,
  ) {}

  public async createCodeRepository(
    command: CreateCodeRepositoryConfigurationCommand,
    context: TrustedRepositoryAnalysisConfigurationContext,
  ): Promise<ConfigurationTransitionResult> {
    validateTrustedContext(context);
    assertRepository(command.projection, command.secretReferenceIds);
    return this.createInitial(
      context,
      command,
      codeRepositoryConfigurationResource,
      command.projection.repositoryId,
      command.secretReferenceIds,
      repositoryAnalysisConfigurationActions.codeRepositoryDraftCreated,
      (versionId) =>
        this.store.writeCodeRepository({
          workspaceId: context.workspaceId,
          configurationVersionId: versionId,
          lifecycle: "disabled",
          repository: command.projection,
        }),
    );
  }

  public async createCodeRepositoryDraftRevision(
    command: CreateCodeRepositoryDraftRevisionCommand,
    context: TrustedRepositoryAnalysisConfigurationContext,
  ): Promise<ConfigurationTransitionResult> {
    validateTrustedContext(context);
    assertRepository(command.projection, command.secretReferenceIds);
    return this.createDraftRevision(
      context,
      command,
      codeRepositoryConfigurationResource,
      command.projection.repositoryId,
      command.secretReferenceIds,
      repositoryAnalysisConfigurationActions.codeRepositoryDraftRevisionCreated,
      (versionId) =>
        this.store.writeCodeRepository({
          workspaceId: context.workspaceId,
          configurationVersionId: versionId,
          lifecycle: "disabled",
          repository: command.projection,
        }),
    );
  }

  public async transitionCodeRepository(
    command: TransitionCodeRepositoryConfigurationCommand,
    context: TrustedRepositoryAnalysisConfigurationContext,
  ): Promise<ConfigurationTransitionResult> {
    validateTrustedContext(context);
    assertRepository(command.projection, command.secretReferenceIds);
    return this.transition(
      context,
      command,
      codeRepositoryConfigurationResource,
      command.projection.repositoryId,
      command.secretReferenceIds,
      repositoryAnalysisConfigurationActions.codeRepositoryChanged,
      (versionId) =>
        this.store.writeCodeRepository({
          workspaceId: context.workspaceId,
          configurationVersionId: versionId,
          lifecycle: lifecycleProjection(command.lifecycle),
          repository: command.projection,
        }),
      async () => {
        if (command.lifecycle !== "active") return;
        await this.repositoryActivationGuard.requireSuccessfulCandidate({
          workspaceId: context.workspaceId,
          repositoryId: command.projection.repositoryId,
          candidateDigest: repositoryDraftCandidateDigest({
            settings: command.settings,
            secretReferenceIds: command.secretReferenceIds,
            projection: command.projection,
          }),
        });
      },
    );
  }

  public async createRepositoryExecutionPolicy(
    command: CreateRepositoryExecutionPolicyConfigurationCommand,
    context: TrustedRepositoryAnalysisConfigurationContext,
  ): Promise<ConfigurationTransitionResult> {
    validateTrustedContext(context);
    assertExecutionPolicy(command.projection);
    return this.createInitial(
      context,
      command,
      repositoryExecutionPolicyConfigurationResource,
      command.projection.executionPolicyId,
      [],
      repositoryAnalysisConfigurationActions.repositoryExecutionPolicyDraftCreated,
      (versionId) =>
        this.store.writeRepositoryExecutionPolicy({
          workspaceId: context.workspaceId,
          configurationVersionId: versionId,
          lifecycle: "disabled",
          policy: command.projection,
        }),
    );
  }

  public async createRepositoryExecutionPolicyDraftRevision(
    command: CreateRepositoryExecutionPolicyDraftRevisionCommand,
    context: TrustedRepositoryAnalysisConfigurationContext,
  ): Promise<ConfigurationTransitionResult> {
    validateTrustedContext(context);
    assertExecutionPolicy(command.projection);
    return this.createDraftRevision(
      context,
      command,
      repositoryExecutionPolicyConfigurationResource,
      command.projection.executionPolicyId,
      [],
      repositoryAnalysisConfigurationActions.repositoryExecutionPolicyDraftRevisionCreated,
      (versionId) =>
        this.store.writeRepositoryExecutionPolicy({
          workspaceId: context.workspaceId,
          configurationVersionId: versionId,
          lifecycle: "disabled",
          policy: command.projection,
        }),
    );
  }

  public async transitionRepositoryExecutionPolicy(
    command: TransitionRepositoryExecutionPolicyConfigurationCommand,
    context: TrustedRepositoryAnalysisConfigurationContext,
  ): Promise<ConfigurationTransitionResult> {
    validateTrustedContext(context);
    assertExecutionPolicy(command.projection);
    return this.transition(
      context,
      command,
      repositoryExecutionPolicyConfigurationResource,
      command.projection.executionPolicyId,
      [],
      repositoryAnalysisConfigurationActions.repositoryExecutionPolicyChanged,
      (versionId) =>
        this.store.writeRepositoryExecutionPolicy({
          workspaceId: context.workspaceId,
          configurationVersionId: versionId,
          lifecycle: lifecycleProjection(command.lifecycle),
          policy: command.projection,
        }),
    );
  }

  public async createAttachmentPolicy(
    command: CreateAttachmentPolicyConfigurationCommand,
    context: TrustedRepositoryAnalysisConfigurationContext,
  ): Promise<ConfigurationTransitionResult> {
    validateTrustedContext(context);
    assertAttachmentPolicy(command.projection);
    return this.createInitial(
      context,
      command,
      attachmentPolicyConfigurationResource,
      command.projection.attachmentPolicyId,
      [],
      repositoryAnalysisConfigurationActions.attachmentPolicyDraftCreated,
      (versionId) =>
        this.store.writeAttachmentPolicy({
          workspaceId: context.workspaceId,
          configurationVersionId: versionId,
          lifecycle: "disabled",
          policy: command.projection,
        }),
    );
  }

  public async createAttachmentPolicyDraftRevision(
    command: CreateAttachmentPolicyDraftRevisionCommand,
    context: TrustedRepositoryAnalysisConfigurationContext,
  ): Promise<ConfigurationTransitionResult> {
    validateTrustedContext(context);
    assertAttachmentPolicy(command.projection);
    return this.createDraftRevision(
      context,
      command,
      attachmentPolicyConfigurationResource,
      command.projection.attachmentPolicyId,
      [],
      repositoryAnalysisConfigurationActions.attachmentPolicyDraftRevisionCreated,
      (versionId) =>
        this.store.writeAttachmentPolicy({
          workspaceId: context.workspaceId,
          configurationVersionId: versionId,
          lifecycle: "disabled",
          policy: command.projection,
        }),
    );
  }

  public async transitionAttachmentPolicy(
    command: TransitionAttachmentPolicyConfigurationCommand,
    context: TrustedRepositoryAnalysisConfigurationContext,
  ): Promise<ConfigurationTransitionResult> {
    validateTrustedContext(context);
    assertAttachmentPolicy(command.projection);
    return this.transition(
      context,
      command,
      attachmentPolicyConfigurationResource,
      command.projection.attachmentPolicyId,
      [],
      repositoryAnalysisConfigurationActions.attachmentPolicyChanged,
      (versionId) =>
        this.store.writeAttachmentPolicy({
          workspaceId: context.workspaceId,
          configurationVersionId: versionId,
          lifecycle: lifecycleProjection(command.lifecycle),
          policy: command.projection,
        }),
    );
  }

  public async createAnalysisRecipe(
    command: CreateAnalysisRecipeConfigurationCommand,
    context: TrustedRepositoryAnalysisConfigurationContext,
  ): Promise<ConfigurationTransitionResult> {
    validateTrustedContext(context);
    assertRecipe(command.projection);
    return this.createInitial(
      context,
      command,
      analysisRecipeConfigurationResource,
      command.projection.recipeId,
      [],
      repositoryAnalysisConfigurationActions.analysisRecipeDraftCreated,
      (versionId) =>
        this.store.writeAnalysisRecipe({
          workspaceId: context.workspaceId,
          configurationVersionId: versionId,
          lifecycle: "disabled",
          recipe: command.projection,
        }),
    );
  }

  public async createAnalysisRecipeDraftRevision(
    command: CreateAnalysisRecipeDraftRevisionCommand,
    context: TrustedRepositoryAnalysisConfigurationContext,
  ): Promise<ConfigurationTransitionResult> {
    validateTrustedContext(context);
    assertRecipe(command.projection);
    return this.createDraftRevision(
      context,
      command,
      analysisRecipeConfigurationResource,
      command.projection.recipeId,
      [],
      repositoryAnalysisConfigurationActions.analysisRecipeDraftRevisionCreated,
      (versionId) =>
        this.store.writeAnalysisRecipe({
          workspaceId: context.workspaceId,
          configurationVersionId: versionId,
          lifecycle: "disabled",
          recipe: command.projection,
        }),
    );
  }

  public async transitionAnalysisRecipe(
    command: TransitionAnalysisRecipeConfigurationCommand,
    context: TrustedRepositoryAnalysisConfigurationContext,
  ): Promise<ConfigurationTransitionResult> {
    validateTrustedContext(context);
    assertRecipe(command.projection);
    return this.transition(
      context,
      command,
      analysisRecipeConfigurationResource,
      command.projection.recipeId,
      [],
      repositoryAnalysisConfigurationActions.analysisRecipeChanged,
      (versionId) =>
        this.store.writeAnalysisRecipe({
          workspaceId: context.workspaceId,
          configurationVersionId: versionId,
          lifecycle: lifecycleProjection(command.lifecycle),
          recipe: command.projection,
        }),
    );
  }

  public async createCaseAnalysisTrigger(
    command: CreateCaseAnalysisTriggerConfigurationCommand,
    context: TrustedRepositoryAnalysisConfigurationContext,
  ): Promise<ConfigurationTransitionResult> {
    validateTrustedContext(context);
    assertTrigger(command.projection);
    return this.createInitial(
      context,
      command,
      caseAnalysisTriggerConfigurationResource,
      command.projection.triggerId,
      [],
      repositoryAnalysisConfigurationActions.caseAnalysisTriggerDraftCreated,
      (versionId) =>
        this.store.writeCaseAnalysisTrigger({
          workspaceId: context.workspaceId,
          configurationVersionId: versionId,
          lifecycle: "disabled",
          trigger: command.projection,
        }),
    );
  }

  public async createCaseAnalysisTriggerDraftRevision(
    command: CreateCaseAnalysisTriggerDraftRevisionCommand,
    context: TrustedRepositoryAnalysisConfigurationContext,
  ): Promise<ConfigurationTransitionResult> {
    validateTrustedContext(context);
    assertTrigger(command.projection);
    return this.createDraftRevision(
      context,
      command,
      caseAnalysisTriggerConfigurationResource,
      command.projection.triggerId,
      [],
      repositoryAnalysisConfigurationActions.caseAnalysisTriggerDraftRevisionCreated,
      (versionId) =>
        this.store.writeCaseAnalysisTrigger({
          workspaceId: context.workspaceId,
          configurationVersionId: versionId,
          lifecycle: "disabled",
          trigger: command.projection,
        }),
    );
  }

  public async transitionCaseAnalysisTrigger(
    command: TransitionCaseAnalysisTriggerConfigurationCommand,
    context: TrustedRepositoryAnalysisConfigurationContext,
  ): Promise<ConfigurationTransitionResult> {
    validateTrustedContext(context);
    assertTrigger(command.projection);
    return this.transition(
      context,
      command,
      caseAnalysisTriggerConfigurationResource,
      command.projection.triggerId,
      [],
      repositoryAnalysisConfigurationActions.caseAnalysisTriggerChanged,
      (versionId) =>
        this.store.writeCaseAnalysisTrigger({
          workspaceId: context.workspaceId,
          configurationVersionId: versionId,
          lifecycle: lifecycleProjection(command.lifecycle),
          ...(command.lifecycle === "active"
            ? { automatedPrincipalId: context.actorPrincipalId }
            : {}),
          trigger: command.projection,
        }),
    );
  }

  public async createCaseAnalysisSchedule(
    command: CreateCaseAnalysisScheduleConfigurationCommand,
    context: TrustedRepositoryAnalysisConfigurationContext,
  ): Promise<ConfigurationTransitionResult> {
    validateTrustedContext(context);
    assertSchedule(command.projection);
    return this.createInitial(
      context,
      command,
      caseAnalysisScheduleConfigurationResource,
      command.projection.scheduleId,
      [],
      repositoryAnalysisConfigurationActions.caseAnalysisScheduleDraftCreated,
      (versionId) =>
        this.store.writeCaseAnalysisSchedule({
          workspaceId: context.workspaceId,
          configurationVersionId: versionId,
          lifecycle: "disabled",
          schedule: command.projection,
        }),
    );
  }

  public async createCaseAnalysisScheduleDraftRevision(
    command: CreateCaseAnalysisScheduleDraftRevisionCommand,
    context: TrustedRepositoryAnalysisConfigurationContext,
  ): Promise<ConfigurationTransitionResult> {
    validateTrustedContext(context);
    assertSchedule(command.projection);
    return this.createDraftRevision(
      context,
      command,
      caseAnalysisScheduleConfigurationResource,
      command.projection.scheduleId,
      [],
      repositoryAnalysisConfigurationActions.caseAnalysisScheduleDraftRevisionCreated,
      (versionId) =>
        this.store.writeCaseAnalysisSchedule({
          workspaceId: context.workspaceId,
          configurationVersionId: versionId,
          lifecycle: "disabled",
          schedule: command.projection,
        }),
    );
  }

  public async transitionCaseAnalysisSchedule(
    command: TransitionCaseAnalysisScheduleConfigurationCommand,
    context: TrustedRepositoryAnalysisConfigurationContext,
  ): Promise<ConfigurationTransitionResult> {
    validateTrustedContext(context);
    assertSchedule(command.projection);
    return this.transition(
      context,
      command,
      caseAnalysisScheduleConfigurationResource,
      command.projection.scheduleId,
      [],
      repositoryAnalysisConfigurationActions.caseAnalysisScheduleChanged,
      (versionId) =>
        this.store.writeCaseAnalysisSchedule({
          workspaceId: context.workspaceId,
          configurationVersionId: versionId,
          lifecycle: lifecycleProjection(command.lifecycle),
          ...(command.lifecycle === "active"
            ? { automatedPrincipalId: context.actorPrincipalId }
            : {}),
          schedule: command.projection,
        }),
    );
  }

  private async createInitial<TProjection>(
    context: TrustedRepositoryAnalysisConfigurationContext,
    command: CreateConfigurationCommand<TProjection>,
    resourceType: string,
    configurationId: string,
    secretReferenceIds: readonly string[],
    action: RepositoryAnalysisConfigurationAction,
    writeProjection: (configurationVersionId: string) => Promise<void>,
  ): Promise<ConfigurationTransitionResult> {
    validateCreateCommand(command);
    return this.transactions.transaction(async () => {
      const created = await new CreateConfigurationDraft(
        passthroughTransaction,
        this.store,
        repositoryAnalysisAudit(this.audit, context, action),
      ).execute({
        workspaceId: context.workspaceId,
        configurationId,
        resourceType,
        displayName: command.displayName,
        settings: command.settings,
        secretReferenceIds,
        mutation: command.mutation,
      });
      if (created.idempotency === "created") {
        await writeProjection(created.version.id);
      }
      return created;
    });
  }

  private async createDraftRevision<TProjection>(
    context: TrustedRepositoryAnalysisConfigurationContext,
    command: CreateDraftRevisionCommand<TProjection>,
    resourceType: string,
    configurationId: string,
    secretReferenceIds: readonly string[],
    action: RepositoryAnalysisConfigurationAction,
    writeProjection: (configurationVersionId: string) => Promise<void>,
  ): Promise<ConfigurationTransitionResult> {
    validateTransitionCommand(command);
    return this.transactions.transaction(async () => {
      const created = await new CreateConfigurationDraftRevision(
        passthroughTransaction,
        this.store,
        repositoryAnalysisAudit(this.audit, context, action),
      ).execute({
        workspaceId: context.workspaceId,
        configurationId,
        resourceType,
        expectedRevision: command.expectedRevision,
        settings: command.settings,
        secretReferenceIds,
        ...(command.displayName === undefined
          ? {}
          : { displayName: command.displayName }),
        ...(command.beforeHash === undefined
          ? {}
          : { beforeHash: command.beforeHash }),
        mutation: command.mutation,
      });
      if (created.idempotency === "created") {
        await writeProjection(created.version.id);
      }
      return created;
    });
  }

  private async transition<TProjection>(
    context: TrustedRepositoryAnalysisConfigurationContext,
    command: TransitionConfigurationCommand<TProjection>,
    resourceType: string,
    configurationId: string,
    secretReferenceIds: readonly string[],
    action: RepositoryAnalysisConfigurationAction,
    writeProjection: (configurationVersionId: string) => Promise<void>,
    beforeProjection?: (result: ConfigurationTransitionResult) => Promise<void>,
  ): Promise<ConfigurationTransitionResult> {
    validateTransitionCommand(command);
    return this.writeTransition(
      context,
      command,
      resourceType,
      configurationId,
      secretReferenceIds,
      action,
      writeProjection,
      beforeProjection,
    );
  }

  private async writeTransition<TProjection>(
    context: TrustedRepositoryAnalysisConfigurationContext,
    command: TransitionConfigurationCommand<TProjection>,
    resourceType: string,
    configurationId: string,
    secretReferenceIds: readonly string[],
    action: RepositoryAnalysisConfigurationAction,
    writeProjection: (configurationVersionId: string) => Promise<void>,
    beforeProjection?: (result: ConfigurationTransitionResult) => Promise<void>,
  ): Promise<ConfigurationTransitionResult> {
    return this.transactions.transaction(async () => {
      const transitioned = await new TransitionConfigurationVersion(
        passthroughTransaction,
        this.store,
        repositoryAnalysisAudit(this.audit, context, action),
      ).execute({
        workspaceId: context.workspaceId,
        configurationId,
        resourceType,
        expectedRevision: command.expectedRevision,
        settings: command.settings,
        secretReferenceIds,
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
        await beforeProjection?.(transitioned);
        await writeProjection(transitioned.version.id);
      }
      return transitioned;
    });
  }
}

const passthroughTransaction: AdministrationTransactionRunner = Object.freeze({
  transaction: async <T>(operation: () => Promise<T>) => operation(),
});

function repositoryAnalysisAudit(
  audit: RepositoryAnalysisConfigurationAuditPort,
  context: TrustedRepositoryAnalysisConfigurationContext,
  action: RepositoryAnalysisConfigurationAction,
): ConfigurationLifecycleAudit {
  return Object.freeze({
    append: (record: Parameters<ConfigurationLifecycleAudit["append"]>[0]) =>
      audit.append({ context, action, record: { ...record, action } }),
  });
}

function lifecycleProjection(
  lifecycle: "active" | "disabled",
): "enabled" | "disabled" {
  return lifecycle === "active" ? "enabled" : "disabled";
}

function validateTrustedContext(
  context: TrustedRepositoryAnalysisConfigurationContext,
): void {
  for (const value of [
    context.workspaceId,
    context.actorPrincipalId,
    context.sessionId,
  ]) {
    assertIdentifier(value, "Trusted configuration context identifier");
  }
  if (
    !(["admin_ui", "api", "cli"] as const).includes(context.origin) ||
    !isIsoTimestamp(context.occurredAt)
  ) {
    throw new RangeError("Trusted configuration context is invalid.");
  }
  for (const value of [
    context.requestId,
    context.correlationId,
    context.uiActionId,
  ]) {
    if (value !== undefined) {
      assertIdentifier(value, "Trusted configuration request identifier");
    }
  }
}

function validateCreateCommand<TProjection>(
  command: CreateConfigurationCommand<TProjection>,
): void {
  if (
    typeof command.displayName !== "string" ||
    command.displayName.trim().length === 0 ||
    command.displayName.length > 200 ||
    !isPlainRecord(command.settings)
  ) {
    throw new RangeError("Configuration draft command is invalid.");
  }
  assertMutation(command.mutation);
}

function validateTransitionCommand<TProjection>(
  command: CreateDraftRevisionCommand<TProjection>,
): void {
  if (
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 1 ||
    !isPlainRecord(command.settings) ||
    (command.displayName !== undefined &&
      (command.displayName.trim().length === 0 ||
        command.displayName.length > 200))
  ) {
    throw new RangeError("Configuration revision command is invalid.");
  }
  if (command.beforeHash !== undefined) assertDigest(command.beforeHash);
  assertMutation(command.mutation);
}

function assertMutation(mutation: MutationIdentity): void {
  assertIdentifier(mutation.operation, "Configuration mutation operation");
  assertDigest(mutation.keyDigest);
  assertDigest(mutation.requestDigest);
}

function assertRepository(
  repository: CodeRepositoryConfigurationProjection,
  secretReferenceIds: readonly string[],
): void {
  assertIdentifier(repository.repositoryId, "Repository identifier");
  if (
    repository.mode !== "deploymentMounted" &&
    repository.mode !== "remoteHttps"
  ) {
    throw new RangeError("Repository mode is invalid.");
  }
  assertDistinctValues(
    repository.allowedRefKinds,
    ["branch", "tag", "commit"],
    "Repository allowed ref policy",
  );
  assertConfiguredCheckoutRef(repository.configuredCheckoutRef);
  if (
    !repository.allowedRefKinds.includes(repository.configuredCheckoutRef.kind)
  ) {
    throw new RangeError(
      "Repository configured checkout reference is not allowed by its ref policy.",
    );
  }
  if (
    repository.mode === "deploymentMounted" &&
    secretReferenceIds.length > 0
  ) {
    throw new RangeError(
      "A deployment-mounted repository cannot retain checkout secret references.",
    );
  }
  if (secretReferenceIds.length > 1) {
    throw new RangeError("Repository checkout secret references are invalid.");
  }
  for (const referenceId of secretReferenceIds) {
    assertIdentifier(referenceId, "Repository secret reference identifier");
  }
}

function assertConfiguredCheckoutRef(
  reference: CodeRepositoryCheckoutRef,
): void {
  if (reference.kind === "commit") {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(reference.sha)) {
      throw new RangeError(
        "Repository configured commit reference is invalid.",
      );
    }
    return;
  }
  if (reference.kind !== "branch" && reference.kind !== "tag") {
    throw new RangeError(
      "Repository configured checkout reference kind is invalid.",
    );
  }
  const name = reference.name;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 512 ||
    hasUnsafeGitRefCharacters(name) ||
    name.startsWith("refs/") ||
    name === "HEAD" ||
    name.includes("@{") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new RangeError(
      "Repository configured checkout reference is invalid.",
    );
  }
}

function hasUnsafeGitRefCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return (
      code === undefined ||
      code <= 32 ||
      code === 127 ||
      "\\:~^?*[]".includes(character)
    );
  });
}

function assertExecutionPolicy(
  policy: RepositoryExecutionPolicyConfigurationProjection,
): void {
  for (const value of [
    policy.executionPolicyId,
    policy.repositoryAgentBindingVersionId,
    policy.sandboxPolicyVersionId,
  ]) {
    assertIdentifier(value, "Repository execution policy identifier");
  }
  if (policy.networkDisabled !== true) {
    throw new RangeError("Repository sandbox network must be disabled.");
  }
  assertDistinctValues(
    policy.allowedTools,
    ["listFiles", "readFile", "searchFiles"],
    "Repository read-only tool allowlist",
  );
  assertBoundedPositiveInteger(
    policy.maximumDurationMs,
    1_000,
    15 * 60_000,
    "Repository execution duration",
  );
  assertBoundedPositiveInteger(
    policy.maximumTurns,
    1,
    100,
    "Repository execution maximum turns",
  );
  assertBoundedPositiveInteger(
    policy.maximumToolCalls,
    1,
    200,
    "Repository execution maximum tool calls",
  );
  assertBoundedPositiveInteger(
    policy.maximumOutputTokens,
    1,
    128_000,
    "Repository execution maximum output tokens",
  );
  assertBoundedPositiveInteger(
    policy.maximumCpuMilliseconds,
    100,
    15 * 60_000,
    "Repository execution CPU limit",
  );
  assertBoundedPositiveInteger(
    policy.maximumMemoryBytes,
    16 * 1024 * 1024,
    8 * 1024 * 1024 * 1024,
    "Repository execution memory limit",
  );
  assertBoundedPositiveInteger(
    policy.maximumOutputBytes,
    1_024,
    32 * 1024 * 1024,
    "Repository execution output-byte limit",
  );
}

function assertAttachmentPolicy(
  policy: AttachmentPolicyConfigurationProjection,
): void {
  for (const value of [
    policy.attachmentPolicyId,
    policy.processorSecurityPolicyVersionId,
    policy.visionBindingVersionId,
  ]) {
    assertIdentifier(value, "Attachment policy identifier");
  }
  assertBoundedPositiveInteger(
    policy.maximumAttachmentCount,
    1,
    10_000,
    "Attachment policy attachment count",
  );
  assertBoundedPositiveInteger(
    policy.maximumAttachmentBytes,
    1_024,
    2 * 1024 * 1024 * 1024,
    "Attachment policy byte limit",
  );
  assertBoundedPositiveInteger(
    policy.maximumArchiveEntries,
    1,
    100_000,
    "Attachment policy archive entry limit",
  );
  assertBoundedPositiveInteger(
    policy.maximumExpandedArchiveBytes,
    1_024,
    8 * 1024 * 1024 * 1024,
    "Attachment policy expanded archive byte limit",
  );
  assertBoundedPositiveInteger(
    policy.maximumArchiveDepth,
    0,
    16,
    "Attachment policy archive depth",
  );
}

function assertRecipe(recipe: AnalysisRecipeConfigurationProjection): void {
  for (const value of [
    recipe.recipeId,
    recipe.analysisProfileId,
    recipe.analysisProfileVersionId,
    recipe.analysisBindingVersionId,
    recipe.retrievalProfileVersionId,
    recipe.promptProfileVersionId,
    recipe.publicationProfileVersionId,
  ]) {
    assertIdentifier(value, "Analysis recipe projection identifier");
  }
  assertRecipeRepositoryStage(recipe.repositoryStage);
  assertRecipeAttachmentStage(recipe.attachmentStage);
}

function assertRecipeRepositoryStage(
  stage: AnalysisRecipeRepositoryStageProjection,
): void {
  assertStagePolicy(stage.mode, "Analysis recipe repository stage");
  const pins = [
    stage.repositoryId,
    stage.repositoryConfigurationVersionId,
    stage.executionPolicyId,
    stage.executionPolicyConfigurationVersionId,
    stage.repositoryAgentBindingVersionId,
  ];
  const supplied = pins.filter((value) => value !== undefined);
  if (stage.mode === "disabled") {
    if (supplied.length !== 0) {
      throw new RangeError(
        "A disabled repository stage cannot retain repository selections.",
      );
    }
    return;
  }
  if (supplied.length !== pins.length) {
    throw new RangeError(
      "An enabled repository stage requires one pinned repository and execution policy pair.",
    );
  }
  for (const value of supplied) {
    assertIdentifier(value, "Analysis recipe repository stage identifier");
  }
}

function assertRecipeAttachmentStage(
  stage: AnalysisRecipeAttachmentStageProjection,
): void {
  assertStagePolicy(stage.mode, "Analysis recipe attachment stage");
  const pins = [
    stage.attachmentPolicyId,
    stage.attachmentPolicyConfigurationVersionId,
  ];
  const supplied = pins.filter((value) => value !== undefined);
  if (stage.mode === "disabled") {
    if (supplied.length !== 0) {
      throw new RangeError(
        "A disabled attachment stage cannot retain an attachment policy pin.",
      );
    }
    return;
  }
  if (supplied.length !== pins.length) {
    throw new RangeError(
      "An enabled attachment stage requires one immutable attachment policy pin.",
    );
  }
  for (const value of supplied) {
    assertIdentifier(value, "Analysis recipe attachment stage identifier");
  }
}

function assertTrigger(
  trigger: CaseAnalysisTriggerConfigurationProjection,
): void {
  for (const value of [
    trigger.triggerId,
    trigger.caseSourceId,
    trigger.caseSourceConfigurationVersionId,
    trigger.connectorRegistrationId,
    trigger.connectorConfigurationVersionId,
    trigger.analysisRecipeId,
    trigger.analysisRecipeConfigurationVersionId,
    trigger.publicationProfileVersionId,
  ]) {
    assertIdentifier(value, "Case analysis trigger identifier");
  }
  const webhookPins = [
    trigger.webhookEndpointId,
    trigger.webhookEndpointConfigurationVersionId,
  ];
  const supplied = webhookPins.filter((value) => value !== undefined);
  if (trigger.ingress === "polling" && supplied.length !== 0) {
    throw new RangeError("A polling case trigger cannot retain a webhook pin.");
  }
  if (trigger.ingress === "verifiedWebhook") {
    if (supplied.length !== webhookPins.length) {
      throw new RangeError(
        "A verified webhook trigger requires one immutable endpoint pin.",
      );
    }
    for (const value of supplied) {
      assertIdentifier(value, "Case analysis webhook endpoint identifier");
    }
  } else if (trigger.ingress !== "polling") {
    throw new RangeError("Case analysis trigger ingress is invalid.");
  }
}

function assertSchedule(
  schedule: CaseAnalysisScheduleConfigurationProjection,
): void {
  for (const value of [
    schedule.scheduleId,
    schedule.triggerId,
    schedule.triggerConfigurationVersionId,
  ]) {
    assertIdentifier(value, "Case analysis schedule identifier");
  }
  if (!isIsoTimestamp(schedule.nextRunAt)) {
    throw new RangeError("Case analysis schedule next run is invalid.");
  }
  if (schedule.cadence.kind === "cron") {
    if (
      schedule.cadence.expression.trim().length === 0 ||
      schedule.cadence.expression.length > 500 ||
      schedule.cadence.timezone.trim().length === 0 ||
      schedule.cadence.timezone.length > 100
    ) {
      throw new RangeError("Case analysis cron cadence is invalid.");
    }
  } else if (
    schedule.cadence.kind !== "interval" ||
    !Number.isSafeInteger(schedule.cadence.intervalMs) ||
    schedule.cadence.intervalMs < 1 ||
    schedule.cadence.intervalMs > 86_400_000
  ) {
    throw new RangeError("Case analysis interval cadence is invalid.");
  }
  if (
    schedule.cadence.jitterMs !== undefined &&
    (!Number.isSafeInteger(schedule.cadence.jitterMs) ||
      schedule.cadence.jitterMs < 0 ||
      schedule.cadence.jitterMs > 86_400_000)
  ) {
    throw new RangeError("Case analysis schedule jitter is invalid.");
  }
  if (
    schedule.cadence.overlapPolicy !== "skip" &&
    schedule.cadence.overlapPolicy !== "queue"
  ) {
    throw new RangeError("Case analysis schedule overlap policy is invalid.");
  }
}

function assertStagePolicy(
  value: AnalysisRecipeStagePolicy,
  label: string,
): void {
  if (value !== "disabled" && value !== "optional" && value !== "required") {
    throw new RangeError(`${label} is invalid.`);
  }
}

function assertDistinctValues<T extends string>(
  values: readonly T[],
  allowed: readonly T[],
  label: string,
): void {
  const unique = new Set(values);
  if (
    values.length === 0 ||
    unique.size !== values.length ||
    [...unique].some((value) => !allowed.includes(value))
  ) {
    throw new RangeError(`${label} is invalid.`);
  }
}

function assertBoundedPositiveInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} is invalid.`);
  }
}

function assertIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)
  ) {
    throw new RangeError(`${label} is invalid.`);
  }
}

function assertDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/iu.test(value)) {
    throw new RangeError("Configuration mutation digest is invalid.");
  }
}

function isPlainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
