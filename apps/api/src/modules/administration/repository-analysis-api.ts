import { createHash } from "node:crypto";

import {
  AdministrationNotFoundError,
  AdministrationUnavailableError,
  type CaseAnalysisScheduleCadence,
  type ConfigurationTransitionResult,
  type CreateAnalysisRecipeConfigurationCommand,
  type CreateAttachmentPolicyConfigurationCommand,
  type CreateCaseAnalysisScheduleConfigurationCommand,
  type CreateCaseAnalysisTriggerConfigurationCommand,
  type CreateCodeRepositoryConfigurationCommand,
  type CreateRepositoryExecutionPolicyConfigurationCommand,
  canonicalizeConfiguration,
  type ListRepositoryAnalysisOptions,
  type ManageRepositoryAnalysisConfiguration,
  type PreviewRepositoryDraftTest,
  type RepositoryAnalysisAuthoringOptions,
  type RepositoryAnalysisTransitionSnapshot,
  type RunRepositoryDraftTest,
  type TransitionAnalysisRecipeConfigurationCommand,
  type TransitionAttachmentPolicyConfigurationCommand,
  type TransitionCaseAnalysisScheduleConfigurationCommand,
  type TransitionCaseAnalysisTriggerConfigurationCommand,
  type TransitionCodeRepositoryConfigurationCommand,
  type TransitionRepositoryExecutionPolicyConfigurationCommand,
} from "@caseweaver/administration";
import type { Permission } from "@caseweaver/security";
import { z } from "zod";

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const displayName = z.string().trim().min(1).max(200);
const expectedRevision = z.number().int().min(1);
const lifecycle = z.enum(["active", "disabled"]);
const allowedRefKinds = z
  .array(z.enum(["branch", "tag", "commit"]))
  .min(1)
  .max(3)
  .refine((values) => new Set(values).size === values.length);
const safeGitRefName = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .superRefine((value, context) => {
    if (
      hasUnsafeGitRefCharacters(value) ||
      value.startsWith("refs/") ||
      value === "HEAD" ||
      value.includes("@{") ||
      value.startsWith("/") ||
      value.endsWith("/") ||
      value.endsWith(".") ||
      value
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    ) {
      context.addIssue({
        code: "custom",
        message: "Git reference is invalid.",
      });
    }
  });
const checkoutRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), name: safeGitRefName }).strict(),
  z.object({ kind: z.literal("tag"), name: safeGitRefName }).strict(),
  z
    .object({
      kind: z.literal("commit"),
      sha: z
        .string()
        .regex(/^[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?$/u)
        .transform((value) => value.toLowerCase()),
    })
    .strict(),
]);
const allowedTools = z
  .array(z.enum(["listFiles", "readFile", "searchFiles"]))
  .min(1)
  .max(3)
  .refine((values) => new Set(values).size === values.length);
const bounded = (minimum: number, maximum: number) =>
  z.number().int().min(minimum).max(maximum);

const credentialFreeHttpsUrl = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .superRefine((value, context) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "Expected an HTTPS URL." });
      return;
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.length === 0 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Expected a credential-free HTTPS URL without query or fragment data.",
      });
    }
  });

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

const repositoryLocation = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("remoteHttps"),
      remoteUrl: credentialFreeHttpsUrl,
      checkoutSecretReferenceId: identifier.optional(),
    })
    .strict(),
  z
    .object({ mode: z.literal("deploymentMounted"), mountAlias: identifier })
    .strict(),
]);

const codeRepositoryDraft = z
  .object({
    resource: z.literal("code-repositories"),
    displayName,
    location: repositoryLocation,
    allowedRefKinds,
    checkoutRef,
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.allowedRefKinds.includes(value.checkoutRef.kind)) {
      context.addIssue({
        code: "custom",
        message: "The configured checkout reference kind must be allowed.",
        path: ["checkoutRef"],
      });
    }
  });

const repositoryExecutionPolicyDraft = z
  .object({
    resource: z.literal("repository-execution-policies"),
    displayName,
    repositoryAgentBindingVersionId: identifier,
    sandboxPolicyVersionId: identifier,
    allowedTools,
    maximumDurationMs: bounded(1_000, 15 * 60_000),
    maximumTurns: bounded(1, 100),
    maximumToolCalls: bounded(1, 200),
    maximumOutputTokens: bounded(1, 128_000),
    maximumCpuMilliseconds: bounded(100, 15 * 60_000),
    maximumMemoryBytes: bounded(16 * 1024 * 1024, 8 * 1024 * 1024 * 1024),
    maximumOutputBytes: bounded(1_024, 32 * 1024 * 1024),
  })
  .strict();

const attachmentPolicyDraft = z
  .object({
    resource: z.literal("attachment-policies"),
    displayName,
    processorSecurityPolicyVersionId: identifier,
    visionBindingVersionId: identifier,
    maximumAttachmentCount: bounded(1, 10_000),
    maximumAttachmentBytes: bounded(1_024, 2 * 1024 * 1024 * 1024),
    maximumArchiveEntries: bounded(1, 100_000),
    maximumExpandedArchiveBytes: bounded(1_024, 8 * 1024 * 1024 * 1024),
    maximumArchiveDepth: bounded(0, 16),
  })
  .strict();

const repositoryStage = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("disabled") }).strict(),
  z
    .object({
      mode: z.literal("optional"),
      repositoryId: identifier,
      repositoryConfigurationVersionId: identifier,
      executionPolicyId: identifier,
      executionPolicyConfigurationVersionId: identifier,
      repositoryAgentBindingVersionId: identifier,
    })
    .strict(),
  z
    .object({
      mode: z.literal("required"),
      repositoryId: identifier,
      repositoryConfigurationVersionId: identifier,
      executionPolicyId: identifier,
      executionPolicyConfigurationVersionId: identifier,
      repositoryAgentBindingVersionId: identifier,
    })
    .strict(),
]);

const attachmentStage = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("disabled") }).strict(),
  z
    .object({
      mode: z.literal("optional"),
      attachmentPolicyId: identifier,
      attachmentPolicyConfigurationVersionId: identifier,
    })
    .strict(),
  z
    .object({
      mode: z.literal("required"),
      attachmentPolicyId: identifier,
      attachmentPolicyConfigurationVersionId: identifier,
    })
    .strict(),
]);

const analysisRecipeDraft = z
  .object({
    resource: z.literal("analysis-recipes"),
    displayName,
    analysisProfileId: identifier,
    analysisProfileVersionId: identifier,
    analysisBindingVersionId: identifier,
    retrievalProfileVersionId: identifier,
    promptProfileVersionId: identifier,
    publicationProfileVersionId: identifier,
    repositoryStage,
    attachmentStage,
  })
  .strict();

const caseAnalysisIngress = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("polling") }).strict(),
  z
    .object({
      kind: z.literal("verifiedWebhook"),
      webhookEndpointId: identifier,
      webhookEndpointConfigurationVersionId: identifier,
    })
    .strict(),
]);

const caseAnalysisTriggerDraft = z
  .object({
    resource: z.literal("case-analysis-triggers"),
    displayName,
    caseSourceId: identifier,
    caseSourceConfigurationVersionId: identifier,
    connectorRegistrationId: identifier,
    connectorConfigurationVersionId: identifier,
    analysisRecipeId: identifier,
    analysisRecipeConfigurationVersionId: identifier,
    publicationProfileVersionId: identifier,
    ingress: caseAnalysisIngress,
  })
  .strict();

const scheduleCadence = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("cron"),
      expression: z.string().trim().min(1).max(500),
      timezone: z.string().trim().min(1).max(100),
      jitterMs: bounded(0, 86_400_000).optional(),
      overlapPolicy: z.enum(["skip", "queue"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("interval"),
      intervalMs: bounded(1, 86_400_000),
      jitterMs: bounded(0, 86_400_000).optional(),
      overlapPolicy: z.enum(["skip", "queue"]),
    })
    .strict(),
]);

const caseAnalysisScheduleDraft = z
  .object({
    resource: z.literal("case-analysis-schedules"),
    displayName,
    triggerId: identifier,
    triggerConfigurationVersionId: identifier,
    cadence: scheduleCadence,
  })
  .strict();

const createDraftSchema = z.discriminatedUnion("resource", [
  codeRepositoryDraft,
  repositoryExecutionPolicyDraft,
  attachmentPolicyDraft,
  analysisRecipeDraft,
  caseAnalysisTriggerDraft,
  caseAnalysisScheduleDraft,
]);

const createDraftRevisionSchema = z.discriminatedUnion("resource", [
  codeRepositoryDraft.extend({ configurationId: identifier, expectedRevision }),
  repositoryExecutionPolicyDraft.extend({
    configurationId: identifier,
    expectedRevision,
  }),
  attachmentPolicyDraft.extend({
    configurationId: identifier,
    expectedRevision,
  }),
  analysisRecipeDraft.extend({ configurationId: identifier, expectedRevision }),
  caseAnalysisTriggerDraft.extend({
    configurationId: identifier,
    expectedRevision,
  }),
  caseAnalysisScheduleDraft.extend({
    configurationId: identifier,
    expectedRevision,
  }),
]);

const transitionSchema = z
  .object({
    resource: z.enum([
      "code-repositories",
      "repository-execution-policies",
      "attachment-policies",
      "analysis-recipes",
      "case-analysis-triggers",
      "case-analysis-schedules",
    ]),
    configurationId: identifier,
    expectedRevision,
    lifecycle,
  })
  .strict();

const draftTestPreviewSchema = z
  .object({ repositoryId: identifier, candidateVersionId: identifier })
  .strict();
const draftTestExecutionSchema = draftTestPreviewSchema
  .extend({ confirmationId: identifier })
  .strict();

export const repositoryAnalysisApiSchemas = Object.freeze({
  createDraft: createDraftSchema,
  createDraftRevision: createDraftRevisionSchema,
  transition: transitionSchema,
  draftTestPreview: draftTestPreviewSchema,
  draftTestExecution: draftTestExecutionSchema,
});

export type RepositoryAnalysisApiResource = z.infer<
  typeof transitionSchema
>["resource"];
export type RepositoryAnalysisCreateDraftInput = z.infer<
  typeof createDraftSchema
>;
export type RepositoryAnalysisCreateDraftRevisionInput = z.infer<
  typeof createDraftRevisionSchema
>;
export type RepositoryAnalysisTransitionInput = z.infer<
  typeof transitionSchema
>;

/**
 * This is constructed only after authentication, CSRF, trusted-origin, and
 * workspace selection have completed. It deliberately has no browser-supplied
 * actor, workspace, session, permission, audit, or timestamp field.
 */
export interface RepositoryAnalysisApiSessionContext {
  readonly principalId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly permissions: readonly Permission[];
  readonly requestId: string;
  readonly correlationId: string;
  readonly uiActionId?: string;
  readonly idempotencyKey?: string;
}

/** Parent composition records the route-owned audit before it allows a read or mutation. */
export interface RepositoryAnalysisApiAuthorizer {
  require(
    input: Readonly<{
      readonly context: RepositoryAnalysisApiSessionContext;
      readonly permission: "configuration.read" | "configuration.manage";
      readonly action: string;
      readonly targetType: string;
      readonly targetId: string;
      readonly mutation: boolean;
    }>,
  ): Promise<void>;
}

export interface RepositoryAnalysisIdentifierFactory {
  create(resource: RepositoryAnalysisApiResource): string;
}

/** The scheduler owns cadence math; a browser never provides the next-run instant. */
export interface RepositoryAnalysisScheduleTiming {
  nextRunAt(
    input: Readonly<{
      /** Server-issued aggregate ID keeps jitter deterministic per schedule. */
      readonly scheduleId: string;
      readonly cadence: CaseAnalysisScheduleCadence;
      readonly now: Date;
    }>,
  ): string;
}

/**
 * Resolves server-private, immutable draft material for lifecycle transitions.
 * It must enforce workspace scope and never return this material through HTTP.
 */
export interface RepositoryAnalysisTransitionResolver {
  resolve(
    input: Readonly<{
      readonly workspaceId: string;
      readonly resource: RepositoryAnalysisApiResource;
      readonly configurationId: string;
    }>,
  ): Promise<RepositoryAnalysisTransitionSnapshot | undefined>;
}

export interface RepositoryAnalysisConfigurationDto {
  readonly id: string;
  readonly versionId: string;
  readonly lifecycle: "draft" | "active" | "disabled" | "superseded";
  readonly revision: number;
  readonly idempotency: "created" | "replayed";
}

export interface RepositoryDraftTestPreviewDto {
  readonly confirmationId: string;
  readonly confirmation: string;
  readonly impact: string;
  readonly expiresAt: string;
}

export type RepositoryDraftTestExecutionDto =
  | Readonly<{
      readonly kind: "inProgress";
      readonly id: string;
      readonly outcome: "accepted";
      readonly status: "inProgress";
      readonly acceptedAt: string;
    }>
  | Readonly<{
      readonly kind: "terminal";
      readonly id: string;
      readonly outcome: "completed" | "failed" | "outcome_unknown";
      readonly completedAt: string;
    }>;

export interface RepositoryAnalysisOptionsDto
  extends RepositoryAnalysisAuthoringOptions {}

type RepositoryAnalysisManager = Pick<
  ManageRepositoryAnalysisConfiguration,
  | "createCodeRepository"
  | "createCodeRepositoryDraftRevision"
  | "transitionCodeRepository"
  | "createRepositoryExecutionPolicy"
  | "createRepositoryExecutionPolicyDraftRevision"
  | "transitionRepositoryExecutionPolicy"
  | "createAttachmentPolicy"
  | "createAttachmentPolicyDraftRevision"
  | "transitionAttachmentPolicy"
  | "createAnalysisRecipe"
  | "createAnalysisRecipeDraftRevision"
  | "transitionAnalysisRecipe"
  | "createCaseAnalysisTrigger"
  | "createCaseAnalysisTriggerDraftRevision"
  | "transitionCaseAnalysisTrigger"
  | "createCaseAnalysisSchedule"
  | "createCaseAnalysisScheduleDraftRevision"
  | "transitionCaseAnalysisSchedule"
>;

export class RepositoryAnalysisApiFacade {
  public constructor(
    private readonly dependencies: Readonly<{
      readonly manager: RepositoryAnalysisManager;
      readonly options: Pick<ListRepositoryAnalysisOptions, "execute">;
      readonly previewDraftTest: Pick<PreviewRepositoryDraftTest, "execute">;
      readonly runDraftTest: Pick<RunRepositoryDraftTest, "execute">;
      readonly transitions: RepositoryAnalysisTransitionResolver;
      readonly identifiers: RepositoryAnalysisIdentifierFactory;
      readonly scheduleTiming: RepositoryAnalysisScheduleTiming;
      readonly authorizer: RepositoryAnalysisApiAuthorizer;
      readonly now?: () => Date;
    }>,
  ) {}

  public parse(
    operation: "createDraft",
    input: unknown,
  ): RepositoryAnalysisCreateDraftInput;
  public parse(
    operation: "createDraftRevision",
    input: unknown,
  ): RepositoryAnalysisCreateDraftRevisionInput;
  public parse(
    operation: "transition",
    input: unknown,
  ): RepositoryAnalysisTransitionInput;
  public parse(
    operation: "draftTestPreview",
    input: unknown,
  ): z.infer<typeof draftTestPreviewSchema>;
  public parse(
    operation: "draftTestExecution",
    input: unknown,
  ): z.infer<typeof draftTestExecutionSchema>;
  public parse(
    operation:
      | "createDraft"
      | "createDraftRevision"
      | "transition"
      | "draftTestPreview"
      | "draftTestExecution",
    input: unknown,
  ) {
    return repositoryAnalysisApiSchemas[operation].parse(input);
  }

  public async createDraft(
    input: unknown,
    context: RepositoryAnalysisApiSessionContext,
  ): Promise<RepositoryAnalysisConfigurationDto> {
    const command = this.parse("createDraft", input);
    const configurationId = identifier.parse(
      this.dependencies.identifiers.create(command.resource),
    );
    await this.authorizeMutation(
      context,
      `admin.repositoryAnalysis.${resourceAction(command.resource)}.draft.create`,
      command.resource,
      configurationId,
    );
    return configurationDto(
      await this.create(command, configurationId, context, "createDraft"),
    );
  }

  public async createDraftRevision(
    input: unknown,
    context: RepositoryAnalysisApiSessionContext,
  ): Promise<RepositoryAnalysisConfigurationDto> {
    const command = this.parse("createDraftRevision", input);
    await this.authorizeMutation(
      context,
      `admin.repositoryAnalysis.${resourceAction(command.resource)}.draftRevision.create`,
      command.resource,
      command.configurationId,
    );
    return configurationDto(
      await this.create(
        command,
        command.configurationId,
        context,
        "createDraftRevision",
      ),
    );
  }

  public async transition(
    input: unknown,
    context: RepositoryAnalysisApiSessionContext,
  ): Promise<RepositoryAnalysisConfigurationDto> {
    const command = this.parse("transition", input);
    await this.authorizeMutation(
      context,
      `admin.repositoryAnalysis.${resourceAction(command.resource)}.lifecycle.${command.lifecycle}`,
      command.resource,
      command.configurationId,
    );
    const snapshot = await this.dependencies.transitions.resolve({
      workspaceId: context.workspaceId,
      resource: command.resource,
      configurationId: command.configurationId,
    });
    if (
      snapshot === undefined ||
      snapshot.resource !== command.resource ||
      snapshotConfigurationId(snapshot) !== command.configurationId
    ) {
      throw new AdministrationNotFoundError();
    }
    const trusted = trustedContext(context, this.dependencies.now);
    const identity = mutation(
      context,
      `admin.repositoryAnalysis.${resourceAction(command.resource)}.transition`,
      command,
    );
    const result = await transitionWithSnapshot(
      this.dependencies.manager,
      snapshot,
      command.expectedRevision,
      command.lifecycle,
      identity,
      trusted,
    );
    return configurationDto(result);
  }

  public async listOptions(
    context: RepositoryAnalysisApiSessionContext,
  ): Promise<RepositoryAnalysisOptionsDto> {
    await this.dependencies.authorizer.require({
      context,
      permission: "configuration.read",
      action: "admin.repositoryAnalysis.options.read",
      targetType: "repository-analysis-options",
      targetId: "workspace",
      mutation: false,
    });
    return optionsDto(
      await this.dependencies.options.execute({
        workspaceId: context.workspaceId,
      }),
    );
  }

  public async previewRepositoryDraftTest(
    input: unknown,
    context: RepositoryAnalysisApiSessionContext,
  ): Promise<RepositoryDraftTestPreviewDto> {
    const command = this.parse("draftTestPreview", input);
    await this.authorizeMutation(
      context,
      "admin.codeRepository.draftTest.preview",
      "code-repository",
      command.repositoryId,
    );
    const preview = await this.dependencies.previewDraftTest.execute({
      workspaceId: context.workspaceId,
      principalId: context.principalId,
      sessionId: context.sessionId,
      repositoryId: command.repositoryId,
      candidateVersionId: command.candidateVersionId,
    });
    return Object.freeze({
      confirmationId: preview.confirmationId,
      confirmation: preview.confirmation,
      impact: preview.impact,
      expiresAt: preview.expiresAt,
    });
  }

  public async executeRepositoryDraftTest(
    input: unknown,
    context: RepositoryAnalysisApiSessionContext,
  ): Promise<RepositoryDraftTestExecutionDto> {
    const command = this.parse("draftTestExecution", input);
    await this.authorizeMutation(
      context,
      "admin.codeRepository.draftTest.execute",
      "code-repository",
      command.repositoryId,
    );
    const result = await this.dependencies.runDraftTest.execute({
      workspaceId: context.workspaceId,
      principalId: context.principalId,
      sessionId: context.sessionId,
      repositoryId: command.repositoryId,
      candidateVersionId: command.candidateVersionId,
      confirmationId: command.confirmationId,
      idempotencyKeyDigest: idempotencyDigest(context),
      signal: new AbortController().signal,
    });
    if (result.kind === "inProgress") {
      return Object.freeze({
        kind: "inProgress",
        id: result.result.id,
        outcome: "accepted",
        status: "inProgress",
        acceptedAt: result.result.acceptedAt,
      });
    }
    return Object.freeze({
      kind: "terminal",
      id: result.result.id,
      outcome: result.result.outcome,
      completedAt: result.result.completedAt,
    });
  }

  private async authorizeMutation(
    context: RepositoryAnalysisApiSessionContext,
    action: string,
    targetType: string,
    targetId: string,
  ): Promise<void> {
    idempotencyDigest(context);
    await this.dependencies.authorizer.require({
      context,
      permission: "configuration.manage",
      action,
      targetType,
      targetId,
      mutation: true,
    });
  }

  private async create(
    command:
      | RepositoryAnalysisCreateDraftInput
      | RepositoryAnalysisCreateDraftRevisionInput,
    configurationId: string,
    context: RepositoryAnalysisApiSessionContext,
    operation: "createDraft" | "createDraftRevision",
  ): Promise<ConfigurationTransitionResult> {
    const trusted = trustedContext(context, this.dependencies.now);
    const identity = mutation(
      context,
      `admin.repositoryAnalysis.${resourceAction(command.resource)}.${operation}`,
      command,
    );
    const expected =
      "expectedRevision" in command ? command.expectedRevision : undefined;
    switch (command.resource) {
      case "code-repositories": {
        const base = codeRepositoryCommand(command, configurationId, identity);
        return expected === undefined
          ? this.dependencies.manager.createCodeRepository(base, trusted)
          : this.dependencies.manager.createCodeRepositoryDraftRevision(
              { ...base, expectedRevision: expected },
              trusted,
            );
      }
      case "repository-execution-policies": {
        const base = executionPolicyCommand(command, configurationId, identity);
        return expected === undefined
          ? this.dependencies.manager.createRepositoryExecutionPolicy(
              base,
              trusted,
            )
          : this.dependencies.manager.createRepositoryExecutionPolicyDraftRevision(
              { ...base, expectedRevision: expected },
              trusted,
            );
      }
      case "attachment-policies": {
        const base = attachmentPolicyCommand(
          command,
          configurationId,
          identity,
        );
        return expected === undefined
          ? this.dependencies.manager.createAttachmentPolicy(base, trusted)
          : this.dependencies.manager.createAttachmentPolicyDraftRevision(
              { ...base, expectedRevision: expected },
              trusted,
            );
      }
      case "analysis-recipes": {
        const base = analysisRecipeCommand(command, configurationId, identity);
        return expected === undefined
          ? this.dependencies.manager.createAnalysisRecipe(base, trusted)
          : this.dependencies.manager.createAnalysisRecipeDraftRevision(
              { ...base, expectedRevision: expected },
              trusted,
            );
      }
      case "case-analysis-triggers": {
        const base = caseAnalysisTriggerCommand(
          command,
          configurationId,
          identity,
        );
        return expected === undefined
          ? this.dependencies.manager.createCaseAnalysisTrigger(base, trusted)
          : this.dependencies.manager.createCaseAnalysisTriggerDraftRevision(
              { ...base, expectedRevision: expected },
              trusted,
            );
      }
      case "case-analysis-schedules": {
        const base = caseAnalysisScheduleCommand(
          command,
          configurationId,
          identity,
          this.dependencies.scheduleTiming,
          (this.dependencies.now ?? (() => new Date()))(),
        );
        return expected === undefined
          ? this.dependencies.manager.createCaseAnalysisSchedule(base, trusted)
          : this.dependencies.manager.createCaseAnalysisScheduleDraftRevision(
              { ...base, expectedRevision: expected },
              trusted,
            );
      }
    }
  }
}

function codeRepositoryCommand(
  command: Extract<
    | RepositoryAnalysisCreateDraftInput
    | RepositoryAnalysisCreateDraftRevisionInput,
    { readonly resource: "code-repositories" }
  >,
  repositoryId: string,
  identity: ReturnType<typeof mutation>,
): CreateCodeRepositoryConfigurationCommand {
  const secretReferenceIds =
    command.location.mode === "remoteHttps" &&
    command.location.checkoutSecretReferenceId !== undefined
      ? [command.location.checkoutSecretReferenceId]
      : [];
  const projection = Object.freeze({
    repositoryId,
    mode: command.location.mode,
    allowedRefKinds: Object.freeze([...command.allowedRefKinds]),
    configuredCheckoutRef: Object.freeze({ ...command.checkoutRef }),
  });
  return Object.freeze({
    displayName: command.displayName,
    settings: Object.freeze({
      repository: Object.freeze(
        command.location.mode === "remoteHttps"
          ? {
              mode: "remoteHttps",
              remoteUrl: command.location.remoteUrl,
              checkoutRef: command.checkoutRef,
            }
          : {
              mode: "deploymentMounted",
              mountAlias: command.location.mountAlias,
              checkoutRef: command.checkoutRef,
            },
      ),
      repositoryAnalysisProjection: projection,
    }),
    secretReferenceIds: Object.freeze(secretReferenceIds),
    projection,
    mutation: identity,
  });
}

function executionPolicyCommand(
  command: Extract<
    | RepositoryAnalysisCreateDraftInput
    | RepositoryAnalysisCreateDraftRevisionInput,
    { readonly resource: "repository-execution-policies" }
  >,
  executionPolicyId: string,
  identity: ReturnType<typeof mutation>,
): CreateRepositoryExecutionPolicyConfigurationCommand {
  const projection = Object.freeze({
    executionPolicyId,
    repositoryAgentBindingVersionId: command.repositoryAgentBindingVersionId,
    sandboxPolicyVersionId: command.sandboxPolicyVersionId,
    allowedTools: Object.freeze([...command.allowedTools]),
    networkDisabled: true as const,
    maximumDurationMs: command.maximumDurationMs,
    maximumTurns: command.maximumTurns,
    maximumToolCalls: command.maximumToolCalls,
    maximumOutputTokens: command.maximumOutputTokens,
    maximumCpuMilliseconds: command.maximumCpuMilliseconds,
    maximumMemoryBytes: command.maximumMemoryBytes,
    maximumOutputBytes: command.maximumOutputBytes,
  });
  return Object.freeze({
    displayName: command.displayName,
    settings: Object.freeze({ repositoryAnalysisProjection: projection }),
    projection,
    mutation: identity,
  });
}

function attachmentPolicyCommand(
  command: Extract<
    | RepositoryAnalysisCreateDraftInput
    | RepositoryAnalysisCreateDraftRevisionInput,
    { readonly resource: "attachment-policies" }
  >,
  attachmentPolicyId: string,
  identity: ReturnType<typeof mutation>,
): CreateAttachmentPolicyConfigurationCommand {
  const projection = Object.freeze({
    attachmentPolicyId,
    processorSecurityPolicyVersionId: command.processorSecurityPolicyVersionId,
    visionBindingVersionId: command.visionBindingVersionId,
    maximumAttachmentCount: command.maximumAttachmentCount,
    maximumAttachmentBytes: command.maximumAttachmentBytes,
    maximumArchiveEntries: command.maximumArchiveEntries,
    maximumExpandedArchiveBytes: command.maximumExpandedArchiveBytes,
    maximumArchiveDepth: command.maximumArchiveDepth,
  });
  return Object.freeze({
    displayName: command.displayName,
    settings: Object.freeze({ repositoryAnalysisProjection: projection }),
    projection,
    mutation: identity,
  });
}

function analysisRecipeCommand(
  command: Extract<
    | RepositoryAnalysisCreateDraftInput
    | RepositoryAnalysisCreateDraftRevisionInput,
    { readonly resource: "analysis-recipes" }
  >,
  recipeId: string,
  identity: ReturnType<typeof mutation>,
): CreateAnalysisRecipeConfigurationCommand {
  const projection = Object.freeze({
    recipeId,
    analysisProfileId: command.analysisProfileId,
    analysisProfileVersionId: command.analysisProfileVersionId,
    analysisBindingVersionId: command.analysisBindingVersionId,
    retrievalProfileVersionId: command.retrievalProfileVersionId,
    promptProfileVersionId: command.promptProfileVersionId,
    publicationProfileVersionId: command.publicationProfileVersionId,
    repositoryStage: Object.freeze({ ...command.repositoryStage }),
    attachmentStage: Object.freeze({ ...command.attachmentStage }),
  });
  return Object.freeze({
    displayName: command.displayName,
    settings: Object.freeze({ repositoryAnalysisProjection: projection }),
    projection,
    mutation: identity,
  });
}

function caseAnalysisTriggerCommand(
  command: Extract<
    | RepositoryAnalysisCreateDraftInput
    | RepositoryAnalysisCreateDraftRevisionInput,
    { readonly resource: "case-analysis-triggers" }
  >,
  triggerId: string,
  identity: ReturnType<typeof mutation>,
): CreateCaseAnalysisTriggerConfigurationCommand {
  const projection = Object.freeze({
    triggerId,
    caseSourceId: command.caseSourceId,
    caseSourceConfigurationVersionId: command.caseSourceConfigurationVersionId,
    connectorRegistrationId: command.connectorRegistrationId,
    connectorConfigurationVersionId: command.connectorConfigurationVersionId,
    analysisRecipeId: command.analysisRecipeId,
    analysisRecipeConfigurationVersionId:
      command.analysisRecipeConfigurationVersionId,
    publicationProfileVersionId: command.publicationProfileVersionId,
    ingress: command.ingress.kind,
    ...(command.ingress.kind === "verifiedWebhook"
      ? {
          webhookEndpointId: command.ingress.webhookEndpointId,
          webhookEndpointConfigurationVersionId:
            command.ingress.webhookEndpointConfigurationVersionId,
        }
      : {}),
  });
  return Object.freeze({
    displayName: command.displayName,
    settings: Object.freeze({ repositoryAnalysisProjection: projection }),
    projection,
    mutation: identity,
  });
}

function caseAnalysisScheduleCommand(
  command: Extract<
    | RepositoryAnalysisCreateDraftInput
    | RepositoryAnalysisCreateDraftRevisionInput,
    { readonly resource: "case-analysis-schedules" }
  >,
  scheduleId: string,
  identity: ReturnType<typeof mutation>,
  timing: RepositoryAnalysisScheduleTiming,
  now: Date,
): CreateCaseAnalysisScheduleConfigurationCommand {
  const cadence = Object.freeze({ ...command.cadence });
  const projection = Object.freeze({
    scheduleId,
    triggerId: command.triggerId,
    triggerConfigurationVersionId: command.triggerConfigurationVersionId,
    cadence,
    nextRunAt: timing.nextRunAt({ scheduleId, cadence, now }),
  });
  return Object.freeze({
    displayName: command.displayName,
    settings: Object.freeze({ repositoryAnalysisProjection: projection }),
    projection,
    mutation: identity,
  });
}

async function transitionWithSnapshot(
  manager: RepositoryAnalysisManager,
  snapshot: RepositoryAnalysisTransitionSnapshot,
  expectedRevision_: number,
  lifecycle_: "active" | "disabled",
  mutation_: ReturnType<typeof mutation>,
  context: Parameters<
    ManageRepositoryAnalysisConfiguration["transitionCodeRepository"]
  >[1],
): Promise<ConfigurationTransitionResult> {
  switch (snapshot.resource) {
    case "code-repositories": {
      const command: TransitionCodeRepositoryConfigurationCommand = {
        ...snapshot.command,
        expectedRevision: expectedRevision_,
        lifecycle: lifecycle_,
        mutation: mutation_,
      };
      return manager.transitionCodeRepository(command, context);
    }
    case "repository-execution-policies": {
      const command: TransitionRepositoryExecutionPolicyConfigurationCommand = {
        ...snapshot.command,
        expectedRevision: expectedRevision_,
        lifecycle: lifecycle_,
        mutation: mutation_,
      };
      return manager.transitionRepositoryExecutionPolicy(command, context);
    }
    case "attachment-policies": {
      const command: TransitionAttachmentPolicyConfigurationCommand = {
        ...snapshot.command,
        expectedRevision: expectedRevision_,
        lifecycle: lifecycle_,
        mutation: mutation_,
      };
      return manager.transitionAttachmentPolicy(command, context);
    }
    case "analysis-recipes": {
      const command: TransitionAnalysisRecipeConfigurationCommand = {
        ...snapshot.command,
        expectedRevision: expectedRevision_,
        lifecycle: lifecycle_,
        mutation: mutation_,
      };
      return manager.transitionAnalysisRecipe(command, context);
    }
    case "case-analysis-triggers": {
      const command: TransitionCaseAnalysisTriggerConfigurationCommand = {
        ...snapshot.command,
        expectedRevision: expectedRevision_,
        lifecycle: lifecycle_,
        mutation: mutation_,
      };
      return manager.transitionCaseAnalysisTrigger(command, context);
    }
    case "case-analysis-schedules": {
      const command: TransitionCaseAnalysisScheduleConfigurationCommand = {
        ...snapshot.command,
        expectedRevision: expectedRevision_,
        lifecycle: lifecycle_,
        mutation: mutation_,
      };
      return manager.transitionCaseAnalysisSchedule(command, context);
    }
  }
}

function snapshotConfigurationId(
  snapshot: RepositoryAnalysisTransitionSnapshot,
): string {
  switch (snapshot.resource) {
    case "code-repositories":
      return snapshot.command.projection.repositoryId;
    case "repository-execution-policies":
      return snapshot.command.projection.executionPolicyId;
    case "attachment-policies":
      return snapshot.command.projection.attachmentPolicyId;
    case "analysis-recipes":
      return snapshot.command.projection.recipeId;
    case "case-analysis-triggers":
      return snapshot.command.projection.triggerId;
    case "case-analysis-schedules":
      return snapshot.command.projection.scheduleId;
  }
}

function trustedContext(
  context: RepositoryAnalysisApiSessionContext,
  now: (() => Date) | undefined,
) {
  return Object.freeze({
    workspaceId: context.workspaceId,
    actorPrincipalId: context.principalId,
    sessionId: context.sessionId,
    occurredAt: (now ?? (() => new Date()))().toISOString(),
    origin: "admin_ui" as const,
    requestId: context.requestId,
    correlationId: context.correlationId,
    ...(context.uiActionId === undefined
      ? {}
      : { uiActionId: context.uiActionId }),
  });
}

function mutation(
  context: RepositoryAnalysisApiSessionContext,
  operation: string,
  request: unknown,
) {
  return Object.freeze({
    operation,
    keyDigest: idempotencyDigest(context),
    requestDigest: sha256(canonicalizeConfiguration(request)),
  });
}

function idempotencyDigest(
  context: RepositoryAnalysisApiSessionContext,
): string {
  const key = context.idempotencyKey;
  if (typeof key !== "string" || key.trim().length === 0 || key.length > 512) {
    throw new AdministrationUnavailableError();
  }
  return sha256(key);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function resourceAction(resource: RepositoryAnalysisApiResource): string {
  switch (resource) {
    case "code-repositories":
      return "codeRepository";
    case "repository-execution-policies":
      return "repositoryExecutionPolicy";
    case "attachment-policies":
      return "attachmentPolicy";
    case "analysis-recipes":
      return "analysisRecipe";
    case "case-analysis-triggers":
      return "caseAnalysisTrigger";
    case "case-analysis-schedules":
      return "caseAnalysisSchedule";
  }
}

function configurationDto(
  result: ConfigurationTransitionResult,
): RepositoryAnalysisConfigurationDto {
  return Object.freeze({
    id: result.configuration.id,
    versionId: result.version.id,
    lifecycle: result.configuration.lifecycle,
    revision: result.configuration.revision,
    idempotency: result.idempotency,
  });
}

/** Explicitly copy every option field, so future private adapter fields cannot leak by spread. */
function optionsDto(
  value: RepositoryAnalysisAuthoringOptions,
): RepositoryAnalysisOptionsDto {
  const version = (
    values: RepositoryAnalysisAuthoringOptions["codeRepositories"],
  ) =>
    Object.freeze(
      values.map((option) =>
        Object.freeze({
          id: option.id,
          versionId: option.versionId,
          label: option.label,
          lifecycle: option.lifecycle,
          eligibleForDraft: option.eligibleForDraft,
          eligibleForActivation: option.eligibleForActivation,
        }),
      ),
    );
  const deployment = (
    values: RepositoryAnalysisAuthoringOptions["mountedRepositories"],
  ) =>
    Object.freeze(
      values.map((option) =>
        Object.freeze({
          id: option.id,
          label: option.label,
          eligibleForDraft: option.eligibleForDraft,
          eligibleForActivation: option.eligibleForActivation,
        }),
      ),
    );
  return Object.freeze({
    codeRepositories: version(value.codeRepositories),
    repositoryExecutionPolicies: version(value.repositoryExecutionPolicies),
    attachmentPolicies: version(value.attachmentPolicies),
    analysisProfiles: version(value.analysisProfiles),
    retrievalProfiles: version(value.retrievalProfiles),
    promptProfiles: version(value.promptProfiles),
    publicationProfiles: version(value.publicationProfiles),
    repositoryAgentBindings: version(value.repositoryAgentBindings),
    analysisBindings: version(value.analysisBindings),
    visionBindings: version(value.visionBindings),
    analysisRecipes: version(value.analysisRecipes),
    caseAnalysisTriggers: version(value.caseAnalysisTriggers),
    caseSources: Object.freeze(
      value.caseSources.map((option) =>
        Object.freeze({
          sourceId: option.sourceId,
          sourceConfigurationVersionId: option.sourceConfigurationVersionId,
          connectorRegistrationId: option.connectorRegistrationId,
          connectorConfigurationVersionId:
            option.connectorConfigurationVersionId,
          label: option.label,
          lifecycle: option.lifecycle,
          eligibleForDraft: option.eligibleForDraft,
          eligibleForActivation: option.eligibleForActivation,
        }),
      ),
    ),
    webhookEndpoints: version(value.webhookEndpoints),
    checkoutSecretReferences: Object.freeze(
      value.checkoutSecretReferences.map((option) =>
        Object.freeze({
          secretReferenceId: option.secretReferenceId,
          label: option.label,
          lifecycle: option.lifecycle,
          eligibleForDraft: option.eligibleForDraft,
          eligibleForActivation: option.eligibleForActivation,
        }),
      ),
    ),
    mountedRepositories: deployment(value.mountedRepositories),
    sandboxPolicies: deployment(value.sandboxPolicies),
    attachmentProcessorSecurityPolicies: deployment(
      value.attachmentProcessorSecurityPolicies,
    ),
  });
}
