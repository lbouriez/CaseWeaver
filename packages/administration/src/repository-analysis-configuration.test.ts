import { describe, expect, it, vi } from "vitest";

import type { ConfigurationLifecycleStore } from "./configuration-lifecycle.js";
import type {
  RepositoryAnalysisConfigurationAuditPort,
  RepositoryAnalysisConfigurationProjectionStore,
  RepositoryConfigurationTestPort,
  TrustedRepositoryAnalysisConfigurationContext,
} from "./repository-analysis-configuration.js";
import { ManageRepositoryAnalysisConfiguration } from "./repository-analysis-configuration.js";
import {
  type RepositoryConfigurationActivationGuard,
  repositoryDraftCandidateDigest,
} from "./repository-draft-test.js";

const digest = (character: string): string => character.repeat(64);

const context: TrustedRepositoryAnalysisConfigurationContext = Object.freeze({
  workspaceId: "workspace-a",
  actorPrincipalId: "administrator-a",
  sessionId: "session-a",
  occurredAt: "2026-07-16T00:00:00.000Z",
  origin: "admin_ui",
  requestId: "request-a",
  correlationId: "correlation-a",
});

const repository = {
  repositoryId: "support-service",
  mode: "remoteHttps" as const,
  allowedRefKinds: ["branch", "tag"] as const,
  configuredCheckoutRef: { kind: "branch" as const, name: "main" },
};

const policy = {
  executionPolicyId: "repository-policy",
  repositoryAgentBindingVersionId: "repository-agent-binding-v1",
  sandboxPolicyVersionId: "sandbox-policy-v1",
  allowedTools: ["listFiles", "readFile", "searchFiles"] as const,
  networkDisabled: true as const,
  maximumDurationMs: 120_000,
  maximumTurns: 12,
  maximumToolCalls: 40,
  maximumOutputTokens: 8_000,
  maximumCpuMilliseconds: 60_000,
  maximumMemoryBytes: 512 * 1024 * 1024,
  maximumOutputBytes: 512 * 1024,
};

const attachmentPolicy = {
  attachmentPolicyId: "case-attachments",
  processorSecurityPolicyVersionId: "attachment-security-v1",
  visionBindingVersionId: "vision-binding-v1",
  maximumAttachmentCount: 100,
  maximumAttachmentBytes: 32 * 1024 * 1024,
  maximumArchiveEntries: 2_000,
  maximumExpandedArchiveBytes: 256 * 1024 * 1024,
  maximumArchiveDepth: 4,
};

const recipe = {
  recipeId: "repository-assisted-support-analysis",
  analysisProfileId: "support-analysis",
  analysisProfileVersionId: "support-analysis-version-v1",
  analysisBindingVersionId: "analysis-binding-v1",
  retrievalProfileVersionId: "retrieval-v1",
  promptProfileVersionId: "prompt-v1",
  publicationProfileVersionId: "publication-v1",
  repositoryStage: {
    mode: "required" as const,
    repositoryId: repository.repositoryId,
    repositoryConfigurationVersionId: "repository-version-v1",
    executionPolicyId: policy.executionPolicyId,
    executionPolicyConfigurationVersionId: "repository-policy-version-v1",
    repositoryAgentBindingVersionId: policy.repositoryAgentBindingVersionId,
  },
  attachmentStage: {
    mode: "optional" as const,
    attachmentPolicyId: attachmentPolicy.attachmentPolicyId,
    attachmentPolicyConfigurationVersionId: "case-attachments-version-v1",
  },
};

const trigger = {
  triggerId: "jitbit-support-trigger",
  ingress: "polling" as const,
  caseSourceId: "jitbit-cases",
  caseSourceConfigurationVersionId: "jitbit-cases-v1",
  connectorRegistrationId: "jitbit",
  connectorConfigurationVersionId: "jitbit-connector-v1",
  analysisRecipeId: recipe.recipeId,
  analysisRecipeConfigurationVersionId:
    "repository-assisted-support-analysis-version-v1",
  publicationProfileVersionId: recipe.publicationProfileVersionId,
};

const schedule = {
  scheduleId: "jitbit-case-poll",
  triggerId: trigger.triggerId,
  triggerConfigurationVersionId: "jitbit-support-trigger-v1",
  cadence: {
    kind: "interval" as const,
    intervalMs: 60_000,
    overlapPolicy: "skip" as const,
  },
  nextRunAt: "2026-07-16T01:00:00.000Z",
};

function mutation(key: string) {
  return {
    operation: "repositoryAnalysis.configuration",
    keyDigest: digest(key),
    requestDigest: digest(key.toUpperCase()),
  };
}

function store(): RepositoryAnalysisConfigurationProjectionStore {
  const lifecycle: ConfigurationLifecycleStore = {
    createDraft: vi.fn(async (input) => ({
      configuration: {
        id: input.configurationId,
        workspaceId: input.workspaceId,
        resourceType: input.resourceType,
        revision: 1,
        lifecycle: "draft" as const,
        currentVersionId: `${input.configurationId}-version-1`,
      },
      version: {
        id: `${input.configurationId}-version-1`,
        workspaceId: input.workspaceId,
        configurationId: input.configurationId,
        version: 1,
        canonicalSettings: input.canonicalSettings,
        secretReferenceIds: input.secretReferenceIds,
      },
    })),
    findMutation: vi.fn(async () => undefined),
    loadVersion: vi.fn(async () => undefined),
    transition: vi.fn(async (input) => ({
      configuration: {
        id: input.configurationId,
        workspaceId: input.workspaceId,
        resourceType: input.resourceType,
        revision: input.expectedRevision + 1,
        lifecycle: input.lifecycle ?? "active",
        currentVersionId: `${input.configurationId}-version-2`,
      },
      version: {
        id: `${input.configurationId}-version-2`,
        workspaceId: input.workspaceId,
        configurationId: input.configurationId,
        version: input.expectedRevision + 1,
        canonicalSettings: input.canonicalSettings,
        secretReferenceIds: input.secretReferenceIds,
      },
    })),
    createDraftRevision: vi.fn(async (input) => ({
      configuration: {
        id: input.configurationId,
        workspaceId: input.workspaceId,
        resourceType: input.resourceType,
        revision: input.expectedRevision + 1,
        lifecycle: "draft" as const,
        currentVersionId: `${input.configurationId}-version-2`,
      },
      version: {
        id: `${input.configurationId}-version-2`,
        workspaceId: input.workspaceId,
        configurationId: input.configurationId,
        version: input.expectedRevision + 1,
        canonicalSettings: input.canonicalSettings,
        secretReferenceIds: input.secretReferenceIds,
      },
    })),
    recordMutation: vi.fn(async () => undefined),
  };
  return {
    ...lifecycle,
    writeCodeRepository: vi.fn(async () => undefined),
    writeRepositoryExecutionPolicy: vi.fn(async () => undefined),
    writeAttachmentPolicy: vi.fn(async () => undefined),
    writeAnalysisRecipe: vi.fn(async () => undefined),
    writeCaseAnalysisTrigger: vi.fn(async () => undefined),
    writeCaseAnalysisSchedule: vi.fn(async () => undefined),
  };
}

function audit(): RepositoryAnalysisConfigurationAuditPort {
  return { append: vi.fn(async () => undefined) };
}

function guard(): RepositoryConfigurationActivationGuard {
  return { requireSuccessfulCandidate: vi.fn(async () => undefined) };
}

const transactions = {
  transaction: async <T>(operation: () => Promise<T>): Promise<T> =>
    operation(),
};

describe("repository analysis administration configuration", () => {
  it("creates an inert remote repository projection without exposing private settings to the audit contract", async () => {
    const persistence = store();
    const recorder = audit();
    const manager = new ManageRepositoryAnalysisConfiguration(
      transactions,
      persistence,
      recorder,
      guard(),
    );

    await manager.createCodeRepository(
      {
        displayName: "Support service",
        settings: {
          remoteUrl: "https://git.example.invalid/private/support-service.git",
          requestedRef: "private-branch",
        },
        secretReferenceIds: ["checkout-credential-a"],
        projection: repository,
        mutation: mutation("a"),
      },
      context,
    );

    expect(persistence.writeCodeRepository).toHaveBeenCalledWith({
      workspaceId: context.workspaceId,
      configurationVersionId: "support-service-version-1",
      lifecycle: "disabled",
      repository,
    });
    expect(recorder.append).toHaveBeenCalledWith(
      expect.objectContaining({
        context,
        action: "admin.codeRepository.draft.created",
        record: expect.objectContaining({
          action: "admin.codeRepository.draft.created",
          targetType: "code-repositories",
          afterHash: expect.any(String),
        }),
      }),
    );
    expect(JSON.stringify(vi.mocked(recorder.append).mock.calls)).not.toContain(
      "git.example.invalid",
    );
    expect(JSON.stringify(vi.mocked(recorder.append).mock.calls)).not.toContain(
      "private-branch",
    );
  });

  it("requires a full safe checkout ref that is permitted by the immutable ref policy", async () => {
    const manager = new ManageRepositoryAnalysisConfiguration(
      transactions,
      store(),
      audit(),
      guard(),
    );
    const command = {
      displayName: "Support service",
      settings: {},
      secretReferenceIds: [],
      mutation: mutation("safe-ref"),
    };

    await expect(
      manager.createCodeRepository(
        {
          ...command,
          projection: {
            ...repository,
            configuredCheckoutRef: { kind: "branch", name: "../private" },
          },
        },
        context,
      ),
    ).rejects.toThrow("checkout reference");
    await expect(
      manager.createCodeRepository(
        {
          ...command,
          projection: {
            ...repository,
            allowedRefKinds: ["tag"] as const,
            configuredCheckoutRef: { kind: "branch", name: "main" },
          },
        },
        context,
      ),
    ).rejects.toThrow("not allowed");
    await expect(
      manager.createCodeRepository(
        {
          ...command,
          projection: {
            ...repository,
            allowedRefKinds: ["commit"] as const,
            configuredCheckoutRef: { kind: "commit", sha: "a".repeat(39) },
          },
        },
        context,
      ),
    ).rejects.toThrow("commit reference");
  });

  it("requires one pinned repository/policy pair and one attachment policy exactly when each stage is enabled", async () => {
    const persistence = store();
    const manager = new ManageRepositoryAnalysisConfiguration(
      transactions,
      persistence,
      audit(),
      guard(),
    );

    await manager.transitionAnalysisRecipe(
      {
        settings: { privatePromptTemplate: "write-only" },
        projection: recipe,
        expectedRevision: 1,
        lifecycle: "active",
        mutation: mutation("b"),
      },
      context,
    );

    expect(persistence.writeAnalysisRecipe).toHaveBeenCalledWith({
      workspaceId: context.workspaceId,
      configurationVersionId: "repository-assisted-support-analysis-version-2",
      lifecycle: "enabled",
      recipe,
    });

    await expect(
      manager.createAnalysisRecipe(
        {
          displayName: "Invalid repository pairing",
          settings: {},
          projection: {
            ...recipe,
            repositoryStage: {
              mode: "optional",
              repositoryId: repository.repositoryId,
            },
          },
          mutation: mutation("c"),
        },
        context,
      ),
    ).rejects.toThrow(/repository.*pair/i);
    await expect(
      manager.createAnalysisRecipe(
        {
          displayName: "Invalid attachment pairing",
          settings: {},
          projection: {
            ...recipe,
            attachmentStage: {
              mode: "disabled",
              attachmentPolicyId: attachmentPolicy.attachmentPolicyId,
            },
          },
          mutation: mutation("d"),
        },
        context,
      ),
    ).rejects.toThrow(/attachment.*policy/i);
  });

  it("keeps a recipe aggregate distinct from the analysis profile it selects", async () => {
    const persistence = store();
    const manager = new ManageRepositoryAnalysisConfiguration(
      transactions,
      persistence,
      audit(),
      guard(),
    );
    await manager.createAnalysisRecipe(
      {
        displayName: "Repository-assisted support analysis",
        settings: {},
        projection: recipe,
        mutation: mutation("9"),
      },
      context,
    );

    // A recipe selects an analysis profile; it is not that profile's aggregate.
    // Otherwise distinct retrieval/publication/repository combinations cannot
    // reuse a profile and trigger recipe pins have no independent target.
    expect(persistence.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        configurationId: "repository-assisted-support-analysis",
        resourceType: "analysis-recipes",
      }),
    );
  });

  it("allows only attested read-only, networkless execution policies with bounded limits", async () => {
    const persistence = store();
    const manager = new ManageRepositoryAnalysisConfiguration(
      transactions,
      persistence,
      audit(),
      guard(),
    );
    await manager.createRepositoryExecutionPolicy(
      {
        displayName: "Safe policy",
        settings: { deploymentImage: "write-only" },
        projection: policy,
        mutation: mutation("e"),
      },
      context,
    );
    expect(persistence.writeRepositoryExecutionPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: "disabled", policy }),
    );

    await expect(
      manager.createRepositoryExecutionPolicy(
        {
          displayName: "Unsafe policy",
          settings: {},
          projection: {
            ...policy,
            allowedTools: ["readFile", "readFile"],
            networkDisabled: false as true,
          },
          mutation: mutation("f"),
        },
        context,
      ),
    ).rejects.toThrow(/network/i);
  });

  it("creates a write-only draft revision without enabling it and never rewrites a projection on replay", async () => {
    const persistence = store();
    const manager = new ManageRepositoryAnalysisConfiguration(
      transactions,
      persistence,
      audit(),
      guard(),
    );
    await manager.createAttachmentPolicyDraftRevision(
      {
        settings: { trustedPublicImageDomains: ["write-only"] },
        projection: attachmentPolicy,
        expectedRevision: 1,
        mutation: mutation("1"),
      },
      context,
    );

    expect(persistence.createDraftRevision).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 1 }),
    );
    expect(persistence.writeAttachmentPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: "disabled" }),
    );

    const replayVersion = {
      id: "case-attachments-version-2",
      workspaceId: context.workspaceId,
      configurationId: attachmentPolicy.attachmentPolicyId,
      version: 2,
      canonicalSettings: "{}",
      secretReferenceIds: [],
    };
    vi.mocked(persistence.findMutation).mockResolvedValueOnce({
      requestDigest: digest("1"),
      resourceId: replayVersion.id,
    });
    vi.mocked(persistence.loadVersion).mockResolvedValueOnce(replayVersion);
    await manager.createAttachmentPolicyDraftRevision(
      {
        settings: { trustedPublicImageDomains: ["changed-write-only"] },
        projection: attachmentPolicy,
        expectedRevision: 2,
        mutation: mutation("1"),
      },
      context,
    );
    expect(persistence.writeAttachmentPolicy).toHaveBeenCalledTimes(1);
  });

  it("requires a successful exact private candidate only before a new code-repository activation projection", async () => {
    const persistence = store();
    const activation: RepositoryConfigurationActivationGuard = {
      requireSuccessfulCandidate: vi.fn(async () => undefined),
    };
    const manager = new ManageRepositoryAnalysisConfiguration(
      transactions,
      persistence,
      audit(),
      activation,
    );
    const command = {
      expectedRevision: 1,
      lifecycle: "active" as const,
      settings: {
        remoteUrl: "https://git.example.invalid/private/support-service.git",
        ref: { kind: "branch", name: "main" },
      },
      secretReferenceIds: ["checkout-credential-a"],
      projection: repository,
      mutation: mutation("a"),
    };

    await manager.transitionCodeRepository(command, context);

    const candidateDigest = repositoryDraftCandidateDigest({
      settings: command.settings,
      secretReferenceIds: command.secretReferenceIds,
      projection: command.projection,
    });
    expect(activation.requireSuccessfulCandidate).toHaveBeenCalledWith({
      workspaceId: context.workspaceId,
      repositoryId: repository.repositoryId,
      candidateDigest,
    });
    expect(persistence.writeCodeRepository).toHaveBeenCalledTimes(1);

    const replayVersion = {
      id: "support-service-version-2",
      workspaceId: context.workspaceId,
      configurationId: repository.repositoryId,
      version: 2,
      canonicalSettings: "{}",
      secretReferenceIds: [],
    };
    vi.mocked(persistence.findMutation).mockResolvedValueOnce({
      requestDigest: command.mutation.requestDigest,
      resourceId: replayVersion.id,
    });
    vi.mocked(persistence.loadVersion).mockResolvedValueOnce(replayVersion);
    await manager.transitionCodeRepository(command, context);
    expect(activation.requireSuccessfulCandidate).toHaveBeenCalledTimes(1);
    expect(persistence.writeCodeRepository).toHaveBeenCalledTimes(1);

    await manager.transitionRepositoryExecutionPolicy(
      {
        expectedRevision: 1,
        lifecycle: "active",
        settings: { image: "private" },
        projection: policy,
        mutation: mutation("b"),
      },
      context,
    );
    expect(activation.requireSuccessfulCandidate).toHaveBeenCalledTimes(1);
  });

  it("pins trigger/schedule inputs and records an activation principal only from trusted context", async () => {
    const persistence = store();
    const manager = new ManageRepositoryAnalysisConfiguration(
      transactions,
      persistence,
      audit(),
      guard(),
    );

    await manager.transitionCaseAnalysisTrigger(
      {
        settings: { connectorFilter: "write-only" },
        projection: trigger,
        expectedRevision: 1,
        lifecycle: "active",
        mutation: mutation("2"),
      },
      context,
    );
    await manager.transitionCaseAnalysisSchedule(
      {
        settings: { schedulerHint: "write-only" },
        projection: schedule,
        expectedRevision: 1,
        lifecycle: "active",
        mutation: mutation("3"),
      },
      context,
    );

    expect(persistence.writeCaseAnalysisTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        lifecycle: "enabled",
        automatedPrincipalId: context.actorPrincipalId,
        trigger,
      }),
    );
    expect(persistence.writeCaseAnalysisSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        lifecycle: "enabled",
        automatedPrincipalId: context.actorPrincipalId,
        schedule,
      }),
    );
  });

  it("separates redacted terminal test outcomes from a non-activating in-progress state", async () => {
    const testPort: RepositoryConfigurationTestPort = {
      preview: async () => ({
        confirmationId: "confirmation-a",
        expiresAt: "2026-07-16T01:00:00.000Z",
        canConfirm: true,
      }),
      execute: async () => ({
        kind: "terminal",
        operationId: "operation-a",
        outcome: "failed",
      }),
    };
    expect(
      await testPort.execute({
        context,
        candidateId: "candidate-a",
        candidateDigest: digest("4"),
        confirmationId: "confirmation-a",
        idempotencyKeyDigest: digest("5"),
      }),
    ).toEqual({
      kind: "terminal",
      operationId: "operation-a",
      outcome: "failed",
    });
  });
});
