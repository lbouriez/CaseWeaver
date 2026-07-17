import { describe, expect, it, vi } from "vitest";

import { RepositoryAnalysisApiFacade } from "./repository-analysis-api.js";

const now = new Date("2026-07-17T12:00:00.000Z");
const context = Object.freeze({
  principalId: "administrator-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  permissions: ["configuration.read", "configuration.manage"] as const,
  requestId: "request-1",
  correlationId: "correlation-1",
  idempotencyKey: "idempotency-key-1",
});

function configurationResult(id: string) {
  return {
    configuration: {
      id,
      workspaceId: context.workspaceId,
      resourceType: "code-repositories",
      revision: 1,
      lifecycle: "draft" as const,
      currentVersionId: `${id}:v1`,
    },
    version: {
      id: `${id}:v1`,
      workspaceId: context.workspaceId,
      configurationId: id,
      version: 1,
      canonicalSettings: "{}",
      secretReferenceIds: [],
    },
    idempotency: "created" as const,
  };
}

function option(label: string) {
  return {
    id: `${label}-id`,
    versionId: `${label}-version`,
    label,
    lifecycle: "active" as const,
    eligibleForDraft: true,
    eligibleForActivation: true,
  };
}

function facade(input: { readonly transition?: unknown } = {}) {
  const manager = {
    createCodeRepository: vi.fn(async (command) =>
      configurationResult(command.projection.repositoryId),
    ),
    createCodeRepositoryDraftRevision: vi.fn(async (command) =>
      configurationResult(command.projection.repositoryId),
    ),
    transitionCodeRepository: vi.fn(async (command) =>
      configurationResult(command.projection.repositoryId),
    ),
    createRepositoryExecutionPolicy: vi.fn(async (command) =>
      configurationResult(command.projection.executionPolicyId),
    ),
    createRepositoryExecutionPolicyDraftRevision: vi.fn(async (command) =>
      configurationResult(command.projection.executionPolicyId),
    ),
    transitionRepositoryExecutionPolicy: vi.fn(async (command) =>
      configurationResult(command.projection.executionPolicyId),
    ),
    createAttachmentPolicy: vi.fn(async (command) =>
      configurationResult(command.projection.attachmentPolicyId),
    ),
    createAttachmentPolicyDraftRevision: vi.fn(async (command) =>
      configurationResult(command.projection.attachmentPolicyId),
    ),
    transitionAttachmentPolicy: vi.fn(async (command) =>
      configurationResult(command.projection.attachmentPolicyId),
    ),
    createAnalysisRecipe: vi.fn(async (command) =>
      configurationResult(command.projection.recipeId),
    ),
    createAnalysisRecipeDraftRevision: vi.fn(async (command) =>
      configurationResult(command.projection.recipeId),
    ),
    transitionAnalysisRecipe: vi.fn(async (command) =>
      configurationResult(command.projection.recipeId),
    ),
    createCaseAnalysisTrigger: vi.fn(async (command) =>
      configurationResult(command.projection.triggerId),
    ),
    createCaseAnalysisTriggerDraftRevision: vi.fn(async (command) =>
      configurationResult(command.projection.triggerId),
    ),
    transitionCaseAnalysisTrigger: vi.fn(async (command) =>
      configurationResult(command.projection.triggerId),
    ),
    createCaseAnalysisSchedule: vi.fn(async (command) =>
      configurationResult(command.projection.scheduleId),
    ),
    createCaseAnalysisScheduleDraftRevision: vi.fn(async (command) =>
      configurationResult(command.projection.scheduleId),
    ),
    transitionCaseAnalysisSchedule: vi.fn(async (command) =>
      configurationResult(command.projection.scheduleId),
    ),
  };
  const authorizer = { require: vi.fn(async () => undefined) };
  const options = {
    execute: vi.fn(async () => ({
      codeRepositories: [
        { ...option("Repository"), remoteUrl: "https://private.invalid/a.git" },
      ],
      repositoryExecutionPolicies: [option("Execution")],
      attachmentPolicies: [option("Attachment")],
      analysisProfiles: [option("Analysis")],
      retrievalProfiles: [option("Retrieval")],
      promptProfiles: [option("Prompt")],
      publicationProfiles: [option("Publication")],
      repositoryAgentBindings: [option("Agent")],
      analysisBindings: [option("Analysis binding")],
      visionBindings: [option("Vision binding")],
      analysisRecipes: [option("Analysis recipe")],
      caseAnalysisTriggers: [option("Case analysis trigger")],
      caseSources: [
        {
          sourceId: "source-1",
          sourceConfigurationVersionId: "source-1:v1",
          connectorRegistrationId: "connector-1",
          connectorConfigurationVersionId: "connector-1:v1",
          label: "Case source",
          lifecycle: "active" as const,
          eligibleForDraft: true,
          eligibleForActivation: true,
        },
      ],
      webhookEndpoints: [option("Webhook")],
      checkoutSecretReferences: [
        {
          secretReferenceId: "checkout-secret-1",
          label: "Remote checkout",
          lifecycle: "active" as const,
          eligibleForDraft: true,
          eligibleForActivation: true,
          locator: "vault:private/checkout",
        },
      ],
      mountedRepositories: [
        {
          id: "mounted-repository-1",
          label: "Support repository",
          eligibleForDraft: true,
          eligibleForActivation: true,
          path: "C:\\private\\support",
        },
      ],
      sandboxPolicies: [
        {
          id: "sandbox-1",
          label: "Read only sandbox",
          eligibleForDraft: true,
          eligibleForActivation: true,
        },
      ],
      attachmentProcessorSecurityPolicies: [
        {
          id: "attachment-security-1",
          label: "Attachment security",
          eligibleForDraft: true,
          eligibleForActivation: true,
        },
      ],
    })),
  };
  const previewDraftTest = {
    execute: vi.fn(async () => ({
      confirmationId: "confirmation-1",
      confirmation: "Run the bounded repository test?",
      impact: "The server resolves the configured reference.",
      expiresAt: "2026-07-17T12:05:00.000Z",
    })),
  };
  const runDraftTest = {
    execute: vi.fn(async () => ({
      kind: "terminal" as const,
      result: {
        id: "test-1",
        outcome: "completed" as const,
        completedAt: "2026-07-17T12:01:00.000Z",
      },
    })),
  };
  const transitions = {
    resolve: vi.fn(async () => input.transition),
  };
  return {
    api: new RepositoryAnalysisApiFacade({
      manager: manager as never,
      options: options as never,
      previewDraftTest: previewDraftTest as never,
      runDraftTest: runDraftTest as never,
      transitions: transitions as never,
      identifiers: { create: (resource) => `${resource}:generated` },
      scheduleTiming: {
        nextRunAt: () => "2026-07-17T12:15:00.000Z",
      },
      authorizer,
      now: () => now,
    }),
    manager,
    authorizer,
    options,
    previewDraftTest,
    runDraftTest,
    transitions,
  };
}

describe("repository analysis API facade", () => {
  it("turns a one-request credential-free remote into private settings and exposes only a safe draft DTO", async () => {
    const subject = facade();
    const remoteUrl = "https://code.example.test/support/service.git";

    const result = await subject.api.createDraft(
      {
        resource: "code-repositories",
        displayName: "Support service",
        location: {
          mode: "remoteHttps",
          remoteUrl,
          checkoutSecretReferenceId: "checkout-secret-1",
        },
        allowedRefKinds: ["branch", "tag"],
        checkoutRef: { kind: "branch", name: "main" },
      },
      context,
    );

    expect(subject.manager.createCodeRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        secretReferenceIds: ["checkout-secret-1"],
        settings: expect.objectContaining({
          repository: {
            mode: "remoteHttps",
            remoteUrl,
            checkoutRef: { kind: "branch", name: "main" },
          },
          repositoryAnalysisProjection: expect.objectContaining({
            configuredCheckoutRef: { kind: "branch", name: "main" },
          }),
        }),
        projection: expect.objectContaining({
          mode: "remoteHttps",
          repositoryId: "code-repositories:generated",
        }),
      }),
      expect.objectContaining({
        workspaceId: "workspace-1",
        actorPrincipalId: "administrator-1",
        sessionId: "session-1",
      }),
    );
    expect(result).toEqual({
      id: "code-repositories:generated",
      versionId: "code-repositories:generated:v1",
      lifecycle: "draft",
      revision: 1,
      idempotency: "created",
    });
    expect(JSON.stringify(result)).not.toContain(remoteUrl);
    expect(subject.authorizer.require).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: "configuration.manage",
        mutation: true,
        targetId: "code-repositories:generated",
      }),
    );
  });

  it("rejects generic settings, browser workspace authority, credentialed URLs, and invalid lifecycle payloads", () => {
    const subject = facade();
    const codeRepository = {
      resource: "code-repositories",
      displayName: "Support service",
      location: {
        mode: "remoteHttps",
        remoteUrl: "https://code.example.test/support/service.git",
      },
      allowedRefKinds: ["branch"],
      checkoutRef: { kind: "branch", name: "main" },
    };

    expect(() =>
      subject.api.parse("createDraft", { ...codeRepository, settings: {} }),
    ).toThrow();
    expect(() =>
      subject.api.parse("createDraft", {
        ...codeRepository,
        workspaceId: "another-workspace",
      }),
    ).toThrow();
    expect(() =>
      subject.api.parse("createDraft", {
        ...codeRepository,
        location: {
          mode: "remoteHttps",
          remoteUrl: "https://token@code.example.test/support.git",
        },
      }),
    ).toThrow();
    expect(() =>
      subject.api.parse("createDraft", {
        ...codeRepository,
        checkoutRef: { kind: "branch", name: "refs/heads/main" },
      }),
    ).toThrow();
    expect(() =>
      subject.api.parse("createDraft", {
        ...codeRepository,
        allowedRefKinds: ["tag"],
      }),
    ).toThrow();
    expect(() =>
      subject.api.parse("transition", {
        resource: "code-repositories",
        configurationId: "repository-1",
        expectedRevision: 1,
        lifecycle: "active",
        settings: {},
      }),
    ).toThrow();
  });

  it("maps every resource draft through a strict dedicated command without a generic settings document", async () => {
    const subject = facade();
    const commands = [
      {
        resource: "repository-execution-policies",
        displayName: "Investigation",
        repositoryAgentBindingVersionId: "agent:v1",
        sandboxPolicyVersionId: "sandbox:v1",
        allowedTools: ["listFiles", "readFile"],
        maximumDurationMs: 10_000,
        maximumTurns: 10,
        maximumToolCalls: 20,
        maximumOutputTokens: 1_000,
        maximumCpuMilliseconds: 5_000,
        maximumMemoryBytes: 64 * 1024 * 1024,
        maximumOutputBytes: 10_000,
      },
      {
        resource: "attachment-policies",
        displayName: "Attachments",
        processorSecurityPolicyVersionId: "attachment-security:v1",
        visionBindingVersionId: "vision:v1",
        maximumAttachmentCount: 10,
        maximumAttachmentBytes: 4_096,
        maximumArchiveEntries: 100,
        maximumExpandedArchiveBytes: 4_096,
        maximumArchiveDepth: 2,
      },
      {
        resource: "analysis-recipes",
        displayName: "Support recipe",
        analysisProfileId: "analysis-profile-1",
        analysisProfileVersionId: "analysis-profile:v1",
        analysisBindingVersionId: "analysis:v1",
        retrievalProfileVersionId: "retrieval:v1",
        promptProfileVersionId: "prompt:v1",
        publicationProfileVersionId: "publication:v1",
        repositoryStage: { mode: "disabled" },
        attachmentStage: {
          mode: "required",
          attachmentPolicyId: "attachment-policy-1",
          attachmentPolicyConfigurationVersionId: "attachment-policy:v1",
        },
      },
      {
        resource: "case-analysis-triggers",
        displayName: "Cases",
        caseSourceId: "source-1",
        caseSourceConfigurationVersionId: "source:v1",
        connectorRegistrationId: "connector-1",
        connectorConfigurationVersionId: "connector:v1",
        analysisRecipeId: "recipe-1",
        analysisRecipeConfigurationVersionId: "recipe:v1",
        publicationProfileVersionId: "publication:v1",
        ingress: { kind: "polling" },
      },
      {
        resource: "case-analysis-schedules",
        displayName: "Poll cases",
        triggerId: "trigger-1",
        triggerConfigurationVersionId: "trigger:v1",
        cadence: {
          kind: "interval",
          intervalMs: 60_000,
          overlapPolicy: "skip",
        },
      },
    ] as const;

    for (const command of commands) {
      await subject.api.createDraft(command, context);
    }

    expect(
      subject.manager.createRepositoryExecutionPolicy,
    ).toHaveBeenCalledOnce();
    expect(subject.manager.createAttachmentPolicy).toHaveBeenCalledOnce();
    expect(subject.manager.createAnalysisRecipe).toHaveBeenCalledOnce();
    expect(subject.manager.createCaseAnalysisTrigger).toHaveBeenCalledOnce();
    expect(subject.manager.createCaseAnalysisSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        projection: expect.objectContaining({
          nextRunAt: "2026-07-17T12:15:00.000Z",
        }),
      }),
      expect.anything(),
    );
  });

  it("uses a workspace-scoped private snapshot for lifecycle transitions and never accepts lifecycle settings", async () => {
    const privateRemoteUrl = "https://code.example.test/private.git";
    const snapshot = {
      resource: "code-repositories" as const,
      command: {
        displayName: "Support service",
        settings: {
          repository: { mode: "remoteHttps", remoteUrl: privateRemoteUrl },
        },
        secretReferenceIds: ["checkout-secret-1"],
        projection: {
          repositoryId: "repository-1",
          mode: "remoteHttps" as const,
          allowedRefKinds: ["branch" as const],
          configuredCheckoutRef: { kind: "branch" as const, name: "main" },
        },
      },
    };
    const subject = facade({ transition: snapshot });

    const result = await subject.api.transition(
      {
        resource: "code-repositories",
        configurationId: "repository-1",
        expectedRevision: 2,
        lifecycle: "active",
      },
      context,
    );

    expect(subject.transitions.resolve).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      resource: "code-repositories",
      configurationId: "repository-1",
    });
    expect(subject.manager.transitionCodeRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 2,
        lifecycle: "active",
        settings: snapshot.command.settings,
      }),
      expect.anything(),
    );
    expect(JSON.stringify(result)).not.toContain(privateRemoteUrl);
  });

  it("returns only allowlisted options and redacted repository test DTOs", async () => {
    const subject = facade();
    const options = await subject.api.listOptions(context);
    const preview = await subject.api.previewRepositoryDraftTest(
      { repositoryId: "repository-1", candidateVersionId: "repository:v1" },
      context,
    );
    const execution = await subject.api.executeRepositoryDraftTest(
      {
        repositoryId: "repository-1",
        candidateVersionId: "repository:v1",
        confirmationId: "confirmation-1",
      },
      context,
    );

    expect(JSON.stringify(options)).not.toContain("private.invalid");
    expect(JSON.stringify(options)).not.toContain("vault:private");
    expect(JSON.stringify(options)).not.toContain("C:\\private");
    expect(preview).toEqual({
      confirmationId: "confirmation-1",
      confirmation: "Run the bounded repository test?",
      impact: "The server resolves the configured reference.",
      expiresAt: "2026-07-17T12:05:00.000Z",
    });
    expect(execution).toEqual({
      kind: "terminal",
      id: "test-1",
      outcome: "completed",
      completedAt: "2026-07-17T12:01:00.000Z",
    });
    expect(subject.runDraftTest.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        principalId: "administrator-1",
        sessionId: "session-1",
        confirmationId: "confirmation-1",
        idempotencyKeyDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
  });
});
