import { describe, expect, it, vi } from "vitest";

import { PostgresRepositoryAnalysisConfigurationStore } from "./repository-analysis-configuration-store.js";

const executionPolicy = {
  executionPolicyId: "execution-policy-a",
  repositoryAgentBindingVersionId: "repository-agent-v1",
  sandboxPolicyVersionId: "sandbox-policy-v1",
  allowedTools: ["listFiles", "readFile", "searchFiles"] as const,
  networkDisabled: true as const,
  maximumDurationMs: 60_000,
  maximumTurns: 12,
  maximumToolCalls: 50,
  maximumOutputTokens: 8_000,
  maximumCpuMilliseconds: 60_000,
  maximumMemoryBytes: 512 * 1024 * 1024,
  maximumOutputBytes: 2 * 1024 * 1024,
};

describe("PostgresRepositoryAnalysisConfigurationStore", () => {
  it("uses only the generated secret-reference count for repository credential metadata", async () => {
    const versionFind = vi.fn(async () => ({
      configurationId: "repository-a",
      version: 1,
      secretReferenceCount: 1,
    }));
    const codeRepositoryCreate = vi.fn(async () => undefined);
    const store = configurationStore({
      administrationConfiguration: {
        findUnique: async () => ({
          resourceType: "code-repositories",
          lifecycle: "active",
          currentVersionId: "repository-v1",
        }),
      },
      administrationConfigurationVersion: { findUnique: versionFind },
      codeRepositoryVersion: {
        findUnique: async () => null,
        create: codeRepositoryCreate,
      },
    });

    await store.writeCodeRepository({
      workspaceId: "workspace-a",
      configurationVersionId: "repository-v1",
      lifecycle: "enabled",
      repository: {
        repositoryId: "repository-a",
        mode: "remoteHttps",
        allowedRefKinds: ["branch", "tag"],
      },
    });

    expect(versionFind).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: "workspace-a",
          id: "repository-v1",
        },
      },
      select: {
        configurationId: true,
        version: true,
        secretReferenceCount: true,
      },
    });
    expect(versionFind.mock.calls[0]?.[0]).not.toHaveProperty(
      "select.secretReferences",
    );
    expect(codeRepositoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ checkoutCredentialRequired: true }),
      }),
    );
  });

  it("requires the active current repository-agent binding with both capabilities before activating an execution policy", async () => {
    const bindingVersionFind = vi.fn(async () => ({
      modelBindingId: "repository-agent",
      capabilities: ["repositoryAgent", "tools"],
    }));
    const bindingFind = vi.fn(async () => ({
      role: "repositoryAgent",
      lifecycle: "active",
      activeVersionId: "repository-agent-v1",
    }));
    const policyCreate = vi.fn(async () => undefined);
    const store = configurationStore({
      ...activeExecutionPolicyConfiguration(),
      aiModelBindingVersion: { findUnique: bindingVersionFind },
      aiModelBinding: { findUnique: bindingFind },
      repositoryExecutionPolicyVersion: {
        findUnique: async () => null,
        create: policyCreate,
      },
    });

    await store.writeRepositoryExecutionPolicy({
      workspaceId: "workspace-a",
      configurationVersionId: "execution-policy-v1",
      lifecycle: "enabled",
      policy: executionPolicy,
    });

    expect(bindingVersionFind).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: "workspace-a",
          id: "repository-agent-v1",
        },
      },
      select: { modelBindingId: true, capabilities: true },
    });
    expect(bindingFind).toHaveBeenCalledWith({
      where: {
        workspaceId_id: {
          workspaceId: "workspace-a",
          id: "repository-agent",
        },
      },
      select: { role: true, lifecycle: true, activeVersionId: true },
    });
    expect(policyCreate).toHaveBeenCalledOnce();
  });

  it.each([
    ["is absent", null, undefined],
    ["belongs to another workspace", null, undefined],
    [
      "has a non-repository role",
      {
        modelBindingId: "repository-agent",
        capabilities: ["repositoryAgent", "tools"],
      },
      {
        role: "analysis",
        lifecycle: "active",
        activeVersionId: "repository-agent-v1",
      },
    ],
    [
      "does not declare tool support",
      { modelBindingId: "repository-agent", capabilities: ["repositoryAgent"] },
      {
        role: "repositoryAgent",
        lifecycle: "active",
        activeVersionId: "repository-agent-v1",
      },
    ],
    [
      "is not active",
      {
        modelBindingId: "repository-agent",
        capabilities: ["repositoryAgent", "tools"],
      },
      {
        role: "repositoryAgent",
        lifecycle: "draft",
        activeVersionId: "repository-agent-v1",
      },
    ],
    [
      "is not the aggregate current version",
      {
        modelBindingId: "repository-agent",
        capabilities: ["repositoryAgent", "tools"],
      },
      {
        role: "repositoryAgent",
        lifecycle: "active",
        activeVersionId: "repository-agent-v2",
      },
    ],
  ])("rejects an execution policy when the repository-agent binding %s", async (_reason, version, binding) => {
    const policyCreate = vi.fn(async () => undefined);
    const bindingVersionFind = vi.fn(async () => version);
    const store = configurationStore({
      ...activeExecutionPolicyConfiguration(),
      aiModelBindingVersion: { findUnique: bindingVersionFind },
      aiModelBinding: { findUnique: async () => binding ?? null },
      repositoryExecutionPolicyVersion: {
        findUnique: async () => null,
        create: policyCreate,
      },
    });

    await expect(
      store.writeRepositoryExecutionPolicy({
        workspaceId: "workspace-a",
        configurationVersionId: "execution-policy-v1",
        lifecycle: "enabled",
        policy: executionPolicy,
      }),
    ).rejects.toThrow();

    expect(bindingVersionFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId_id: {
            workspaceId: "workspace-a",
            id: "repository-agent-v1",
          },
        },
      }),
    );
    expect(policyCreate).not.toHaveBeenCalled();
  });

  it("rejects an active recipe that pins a repository binding without tool support", async () => {
    const recipeCreate = vi.fn(async () => undefined);
    const store = configurationStore({
      administrationConfiguration: {
        findUnique: async (input: {
          where: { workspaceId_id: { id: string } };
        }) => {
          const id = input.where.workspaceId_id.id;
          const resources: Record<string, string> = {
            "recipe-a": "analysis-recipes",
            "retrieval-a": "retrieval-profiles",
            "prompt-a": "prompt-profiles",
            "repository-a": "code-repositories",
            "execution-policy-a": "repository-execution-policies",
          };
          return {
            resourceType: resources[id],
            lifecycle: "active",
            currentVersionId: `${id}-v1`,
          };
        },
      },
      administrationConfigurationVersion: {
        findUnique: async (input: {
          where: { workspaceId_id: { id: string } };
        }) => {
          const id = input.where.workspaceId_id.id;
          const configurations: Record<string, string> = {
            "recipe-a-v1": "recipe-a",
            "retrieval-a-v1": "retrieval-a",
            "prompt-a-v1": "prompt-a",
            "repository-a-v1": "repository-a",
            "execution-policy-a-v1": "execution-policy-a",
          };
          return {
            configurationId: configurations[id],
            version: 1,
            secretReferenceCount: 0,
          };
        },
      },
      analysisProfileVersion: {
        findUnique: async () => ({ analysisProfileId: "analysis-profile-a" }),
      },
      aiModelBindingVersion: {
        findUnique: async (input: {
          where: { workspaceId_id: { id: string } };
        }) =>
          input.where.workspaceId_id.id === "repository-agent-v1"
            ? {
                modelBindingId: "repository-agent",
                capabilities: ["repositoryAgent"],
              }
            : { id: "analysis-binding-v1", modelBindingId: "analysis-binding" },
      },
      publicationProfileVersion: {
        findUnique: async () => ({
          id: "publication-profile-v1",
          publicationProfileId: "publication-profile-a",
        }),
      },
      analysisProfile: { findUnique: async () => ({ lifecycle: "active" }) },
      aiModelBinding: {
        findUnique: async (input: {
          where: { workspaceId_id: { id: string } };
        }) =>
          input.where.workspaceId_id.id === "analysis-binding"
            ? {
                lifecycle: "active",
                activeVersionId: "analysis-binding-v1",
              }
            : {
                role: "repositoryAgent",
                lifecycle: "active",
                activeVersionId: "repository-agent-v1",
              },
      },
      publicationProfile: { findUnique: async () => ({ lifecycle: "active" }) },
      analysisRecipeVersion: {
        findUnique: async () => null,
        create: recipeCreate,
      },
    });

    await expect(
      store.writeAnalysisRecipe({
        workspaceId: "workspace-a",
        configurationVersionId: "recipe-a-v1",
        lifecycle: "enabled",
        recipe: {
          recipeId: "recipe-a",
          analysisProfileId: "analysis-profile-a",
          analysisProfileVersionId: "analysis-profile-v1",
          analysisBindingVersionId: "analysis-binding-v1",
          retrievalProfileVersionId: "retrieval-a-v1",
          promptProfileVersionId: "prompt-a-v1",
          publicationProfileVersionId: "publication-profile-v1",
          repositoryStage: {
            mode: "optional",
            repositoryId: "repository-a",
            repositoryConfigurationVersionId: "repository-a-v1",
            executionPolicyId: "execution-policy-a",
            executionPolicyConfigurationVersionId: "execution-policy-a-v1",
            repositoryAgentBindingVersionId: "repository-agent-v1",
          },
          attachmentStage: { mode: "disabled" },
        },
      }),
    ).rejects.toThrow();

    expect(recipeCreate).not.toHaveBeenCalled();
  });
});

function activeExecutionPolicyConfiguration() {
  return {
    administrationConfiguration: {
      findUnique: async () => ({
        resourceType: "repository-execution-policies",
        lifecycle: "active",
        currentVersionId: "execution-policy-v1",
      }),
    },
    administrationConfigurationVersion: {
      findUnique: async () => ({
        configurationId: "execution-policy-a",
        version: 1,
        secretReferenceCount: 0,
      }),
    },
  };
}

function configurationStore(database: object) {
  return new PostgresRepositoryAnalysisConfigurationStore(
    { get: () => database } as never,
    {} as never,
  );
}
