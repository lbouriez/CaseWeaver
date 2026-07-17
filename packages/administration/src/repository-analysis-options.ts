import { AdministrationValidationError } from "./errors.js";

export type RepositoryAnalysisOptionLifecycle = "draft" | "active" | "disabled";

/** Safe immutable configuration choice. No settings, endpoints, paths, refs, or secrets. */
export interface RepositoryAnalysisVersionOption {
  readonly id: string;
  readonly versionId: string;
  readonly label: string;
  readonly lifecycle: RepositoryAnalysisOptionLifecycle;
  readonly eligibleForDraft: boolean;
  readonly eligibleForActivation: boolean;
}

/** A source choice retains both immutable source and connector pins. */
export interface CaseSourceRepositoryAnalysisOption {
  readonly sourceId: string;
  readonly sourceConfigurationVersionId: string;
  readonly connectorRegistrationId: string;
  readonly connectorConfigurationVersionId: string;
  readonly label: string;
  readonly lifecycle: RepositoryAnalysisOptionLifecycle;
  readonly eligibleForDraft: boolean;
  readonly eligibleForActivation: boolean;
}

/** Checkout metadata is selection-only. A locator/value is never an option field. */
export interface CheckoutSecretReferenceOption {
  readonly secretReferenceId: string;
  readonly label: string;
  readonly lifecycle: RepositoryAnalysisOptionLifecycle;
  readonly eligibleForDraft: boolean;
  readonly eligibleForActivation: boolean;
}

/** A webhook's draft eligibility is intentionally distinct from routable activation. */
export interface WebhookEndpointRepositoryAnalysisOption
  extends RepositoryAnalysisVersionOption {}

/** Deployment registry choices are opaque aliases, not host paths or image references. */
export interface DeploymentRepositoryAnalysisOption {
  readonly id: string;
  readonly label: string;
  readonly eligibleForDraft: boolean;
  readonly eligibleForActivation: boolean;
}

export interface RepositoryAnalysisWorkspaceOptions {
  readonly codeRepositories: readonly RepositoryAnalysisVersionOption[];
  readonly repositoryExecutionPolicies: readonly RepositoryAnalysisVersionOption[];
  readonly attachmentPolicies: readonly RepositoryAnalysisVersionOption[];
  readonly analysisProfiles: readonly RepositoryAnalysisVersionOption[];
  readonly retrievalProfiles: readonly RepositoryAnalysisVersionOption[];
  readonly promptProfiles: readonly RepositoryAnalysisVersionOption[];
  readonly publicationProfiles: readonly RepositoryAnalysisVersionOption[];
  readonly repositoryAgentBindings: readonly RepositoryAnalysisVersionOption[];
  /** Active/current `analysis` bindings only; versions remain opaque pins. */
  readonly analysisBindings: readonly RepositoryAnalysisVersionOption[];
  /** Active/current `vision` bindings only; required by attachment policy. */
  readonly visionBindings: readonly RepositoryAnalysisVersionOption[];
  /** Active/current analysis-recipe projections only. */
  readonly analysisRecipes: readonly RepositoryAnalysisVersionOption[];
  /** Active/current case-trigger projections only. */
  readonly caseAnalysisTriggers: readonly RepositoryAnalysisVersionOption[];
  readonly caseSources: readonly CaseSourceRepositoryAnalysisOption[];
  readonly webhookEndpoints: readonly WebhookEndpointRepositoryAnalysisOption[];
  readonly checkoutSecretReferences: readonly CheckoutSecretReferenceOption[];
}

/**
 * Workspace-owned configuration catalog. The adapter may load private state
 * internally, but returns only these opaque choices to administration/API/UI.
 */
export interface RepositoryAnalysisOptionsCatalog {
  listWorkspaceOptions(input: {
    readonly workspaceId: string;
  }): Promise<RepositoryAnalysisWorkspaceOptions>;
}

/** Trusted deployment registry: values are aliases safe to display, never paths/images. */
export interface RepositoryAnalysisDeploymentRegistry {
  listMountedRepositories(): Promise<
    readonly DeploymentRepositoryAnalysisOption[]
  >;
  listSandboxPolicies(): Promise<readonly DeploymentRepositoryAnalysisOption[]>;
  listAttachmentProcessorSecurityPolicies(): Promise<
    readonly DeploymentRepositoryAnalysisOption[]
  >;
}

export interface RepositoryAnalysisAuthoringOptions
  extends RepositoryAnalysisWorkspaceOptions {
  readonly mountedRepositories: readonly DeploymentRepositoryAnalysisOption[];
  readonly sandboxPolicies: readonly DeploymentRepositoryAnalysisOption[];
  readonly attachmentProcessorSecurityPolicies: readonly DeploymentRepositoryAnalysisOption[];
}

export interface ListRepositoryAnalysisOptionsCommand {
  readonly workspaceId: string;
}

/**
 * Presents the backend catalog through an explicit safe allowlist. It does not
 * infer lifecycle eligibility, resolve a secret, or expose deployment internals.
 */
export class ListRepositoryAnalysisOptions {
  public constructor(
    private readonly catalog: RepositoryAnalysisOptionsCatalog,
    private readonly deployment: RepositoryAnalysisDeploymentRegistry,
  ) {}

  public async execute(
    command: ListRepositoryAnalysisOptionsCommand,
  ): Promise<RepositoryAnalysisAuthoringOptions> {
    identifier(command.workspaceId);
    const [
      workspace,
      mountedRepositories,
      sandboxPolicies,
      attachmentPolicies,
    ] = await Promise.all([
      this.catalog.listWorkspaceOptions({ workspaceId: command.workspaceId }),
      this.deployment.listMountedRepositories(),
      this.deployment.listSandboxPolicies(),
      this.deployment.listAttachmentProcessorSecurityPolicies(),
    ]);
    return Object.freeze({
      codeRepositories: versionOptions(workspace.codeRepositories),
      repositoryExecutionPolicies: versionOptions(
        workspace.repositoryExecutionPolicies,
      ),
      attachmentPolicies: versionOptions(workspace.attachmentPolicies),
      analysisProfiles: versionOptions(workspace.analysisProfiles),
      retrievalProfiles: versionOptions(workspace.retrievalProfiles),
      promptProfiles: versionOptions(workspace.promptProfiles),
      publicationProfiles: versionOptions(workspace.publicationProfiles),
      repositoryAgentBindings: versionOptions(
        workspace.repositoryAgentBindings,
      ),
      analysisBindings: versionOptions(workspace.analysisBindings),
      visionBindings: versionOptions(workspace.visionBindings),
      analysisRecipes: versionOptions(workspace.analysisRecipes),
      caseAnalysisTriggers: versionOptions(workspace.caseAnalysisTriggers),
      caseSources: sourceOptions(workspace.caseSources),
      webhookEndpoints: versionOptions(workspace.webhookEndpoints),
      checkoutSecretReferences: secretOptions(
        workspace.checkoutSecretReferences,
      ),
      mountedRepositories: deploymentOptions(mountedRepositories),
      sandboxPolicies: deploymentOptions(sandboxPolicies),
      attachmentProcessorSecurityPolicies:
        deploymentOptions(attachmentPolicies),
    });
  }
}

function versionOptions(
  values: readonly RepositoryAnalysisVersionOption[],
): readonly RepositoryAnalysisVersionOption[] {
  return Object.freeze(
    values.map((value) => {
      validateVersionOption(value);
      return Object.freeze({
        id: value.id,
        versionId: value.versionId,
        label: value.label,
        lifecycle: value.lifecycle,
        eligibleForDraft: value.eligibleForDraft,
        eligibleForActivation: value.eligibleForActivation,
      });
    }),
  );
}

function sourceOptions(
  values: readonly CaseSourceRepositoryAnalysisOption[],
): readonly CaseSourceRepositoryAnalysisOption[] {
  return Object.freeze(
    values.map((value) => {
      for (const identifierValue of [
        value.sourceId,
        value.sourceConfigurationVersionId,
        value.connectorRegistrationId,
        value.connectorConfigurationVersionId,
      ]) {
        identifier(identifierValue);
      }
      validateOptionState(value);
      return Object.freeze({
        sourceId: value.sourceId,
        sourceConfigurationVersionId: value.sourceConfigurationVersionId,
        connectorRegistrationId: value.connectorRegistrationId,
        connectorConfigurationVersionId: value.connectorConfigurationVersionId,
        label: value.label,
        lifecycle: value.lifecycle,
        eligibleForDraft: value.eligibleForDraft,
        eligibleForActivation: value.eligibleForActivation,
      });
    }),
  );
}

function secretOptions(
  values: readonly CheckoutSecretReferenceOption[],
): readonly CheckoutSecretReferenceOption[] {
  return Object.freeze(
    values.map((value) => {
      identifier(value.secretReferenceId);
      validateOptionState(value);
      return Object.freeze({
        secretReferenceId: value.secretReferenceId,
        label: value.label,
        lifecycle: value.lifecycle,
        eligibleForDraft: value.eligibleForDraft,
        eligibleForActivation: value.eligibleForActivation,
      });
    }),
  );
}

function deploymentOptions(
  values: readonly DeploymentRepositoryAnalysisOption[],
): readonly DeploymentRepositoryAnalysisOption[] {
  return Object.freeze(
    values.map((value) => {
      identifier(value.id);
      label(value.label);
      eligibility(value.eligibleForDraft, value.eligibleForActivation);
      return Object.freeze({
        id: value.id,
        label: value.label,
        eligibleForDraft: value.eligibleForDraft,
        eligibleForActivation: value.eligibleForActivation,
      });
    }),
  );
}

function validateVersionOption(value: RepositoryAnalysisVersionOption): void {
  identifier(value.id);
  identifier(value.versionId);
  validateOptionState(value);
}

function validateOptionState(value: {
  readonly label: string;
  readonly lifecycle: RepositoryAnalysisOptionLifecycle;
  readonly eligibleForDraft: boolean;
  readonly eligibleForActivation: boolean;
}): void {
  label(value.label);
  if (
    value.lifecycle !== "draft" &&
    value.lifecycle !== "active" &&
    value.lifecycle !== "disabled"
  ) {
    throw new AdministrationValidationError();
  }
  eligibility(value.eligibleForDraft, value.eligibleForActivation);
  if (value.eligibleForActivation && value.lifecycle !== "active") {
    throw new AdministrationValidationError();
  }
}

function eligibility(
  eligibleForDraft: unknown,
  eligibleForActivation: unknown,
): void {
  if (
    typeof eligibleForDraft !== "boolean" ||
    typeof eligibleForActivation !== "boolean"
  ) {
    throw new AdministrationValidationError();
  }
}

function label(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 200 ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code === undefined || code < 32 || code === 127;
    })
  ) {
    throw new AdministrationValidationError();
  }
}

function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)
  ) {
    throw new AdministrationValidationError();
  }
}
