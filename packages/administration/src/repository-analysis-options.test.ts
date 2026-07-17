import { describe, expect, it } from "vitest";

import {
  ListRepositoryAnalysisOptions,
  type RepositoryAnalysisDeploymentRegistry,
  type RepositoryAnalysisOptionsCatalog,
  type RepositoryAnalysisVersionOption,
} from "./repository-analysis-options.js";

const activeOption: RepositoryAnalysisVersionOption = Object.freeze({
  id: "repository-a",
  versionId: "repository-a-v1",
  label: "Support service",
  lifecycle: "active",
  eligibleForDraft: true,
  eligibleForActivation: true,
});

function catalog(): RepositoryAnalysisOptionsCatalog {
  const privateOption = {
    ...activeOption,
    remoteUrl: "https://git.example.invalid/private/support-service.git",
    localPath: "/srv/private/support-service",
  } as unknown as RepositoryAnalysisVersionOption;
  return {
    listWorkspaceOptions: async () => ({
      codeRepositories: [privateOption],
      repositoryExecutionPolicies: [activeOption],
      attachmentPolicies: [activeOption],
      analysisProfiles: [activeOption],
      retrievalProfiles: [activeOption],
      promptProfiles: [activeOption],
      publicationProfiles: [activeOption],
      repositoryAgentBindings: [activeOption],
      analysisBindings: [
        {
          ...activeOption,
          id: "analysis-binding-a",
          versionId: "analysis-binding-a-v1",
          providerModel: "private-analysis-model",
        },
      ],
      visionBindings: [
        {
          ...activeOption,
          id: "vision-binding-a",
          versionId: "vision-binding-a-v1",
          providerModel: "private-vision-model",
        },
      ],
      analysisRecipes: [
        {
          ...activeOption,
          id: "analysis-recipe-a",
          versionId: "analysis-recipe-a-v1",
          rawSettings: { private: true },
        },
      ],
      caseAnalysisTriggers: [
        {
          ...activeOption,
          id: "case-trigger-a",
          versionId: "case-trigger-a-v1",
          targetUrl: "https://support.example.invalid/private-trigger",
        },
      ],
      caseSources: [
        {
          sourceId: "source-a",
          sourceConfigurationVersionId: "source-a-v1",
          connectorRegistrationId: "connector-a",
          connectorConfigurationVersionId: "connector-a-v1",
          label: "Support cases",
          lifecycle: "active",
          eligibleForDraft: true,
          eligibleForActivation: true,
          connectorUrl: "https://support.example.invalid",
        },
      ],
      webhookEndpoints: [
        {
          ...activeOption,
          id: "webhook-a",
          versionId: "webhook-a-v1",
          lifecycle: "draft",
          eligibleForDraft: true,
          eligibleForActivation: false,
          endpointUrl: "https://api.example.invalid/secret-endpoint",
        },
      ],
      checkoutSecretReferences: [
        {
          secretReferenceId: "checkout-secret-a",
          label: "Git checkout credential",
          lifecycle: "active",
          eligibleForDraft: true,
          eligibleForActivation: true,
          locator: "vault://checkout/private",
        },
      ],
    }),
  };
}

function deployment(): RepositoryAnalysisDeploymentRegistry {
  return {
    listMountedRepositories: async () => [
      {
        id: "mounted-support-service",
        label: "Mounted support service",
        eligibleForDraft: true,
        eligibleForActivation: true,
        path: "/srv/private/support-service",
      },
    ],
    listSandboxPolicies: async () => [
      {
        id: "sandbox-policy-a",
        label: "Restricted sandbox",
        eligibleForDraft: true,
        eligibleForActivation: true,
        image: "registry.example.invalid/private@sha256:secret",
      },
    ],
    listAttachmentProcessorSecurityPolicies: async () => [
      {
        id: "attachment-policy-a",
        label: "Strict attachment processor",
        eligibleForDraft: true,
        eligibleForActivation: true,
        filesystemRoot: "/srv/private/attachments",
      },
    ],
  };
}

describe("repository analysis safe authoring options", () => {
  it("returns opaque immutable choices and strips all adapter-private details", async () => {
    const options = await new ListRepositoryAnalysisOptions(
      catalog(),
      deployment(),
    ).execute({ workspaceId: "workspace-a" });

    expect(options.webhookEndpoints).toEqual([
      expect.objectContaining({
        id: "webhook-a",
        eligibleForDraft: true,
        eligibleForActivation: false,
      }),
    ]);
    expect(options.caseSources[0]).toEqual({
      sourceId: "source-a",
      sourceConfigurationVersionId: "source-a-v1",
      connectorRegistrationId: "connector-a",
      connectorConfigurationVersionId: "connector-a-v1",
      label: "Support cases",
      lifecycle: "active",
      eligibleForDraft: true,
      eligibleForActivation: true,
    });
    expect(options.analysisBindings).toEqual([
      {
        ...activeOption,
        id: "analysis-binding-a",
        versionId: "analysis-binding-a-v1",
      },
    ]);
    expect(options.visionBindings).toEqual([
      {
        ...activeOption,
        id: "vision-binding-a",
        versionId: "vision-binding-a-v1",
      },
    ]);
    expect(options.analysisRecipes).toEqual([
      {
        ...activeOption,
        id: "analysis-recipe-a",
        versionId: "analysis-recipe-a-v1",
      },
    ]);
    expect(options.caseAnalysisTriggers).toEqual([
      {
        ...activeOption,
        id: "case-trigger-a",
        versionId: "case-trigger-a-v1",
      },
    ]);
    const serialized = JSON.stringify(options);
    for (const privateValue of [
      "git.example.invalid",
      "/srv/private",
      "vault://",
      "secret-endpoint",
      "registry.example.invalid",
      "private-analysis-model",
      "private-vision-model",
      "private-trigger",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("rejects an activation-eligible non-active version instead of inventing eligibility", async () => {
    const invalidCatalog = catalog();
    invalidCatalog.listWorkspaceOptions = async () => ({
      codeRepositories: [
        {
          ...activeOption,
          lifecycle: "disabled",
          eligibleForActivation: true,
        },
      ],
      repositoryExecutionPolicies: [],
      attachmentPolicies: [],
      analysisProfiles: [],
      retrievalProfiles: [],
      promptProfiles: [],
      publicationProfiles: [],
      repositoryAgentBindings: [],
      analysisBindings: [],
      visionBindings: [],
      analysisRecipes: [],
      caseAnalysisTriggers: [],
      caseSources: [],
      webhookEndpoints: [],
      checkoutSecretReferences: [],
    });

    await expect(
      new ListRepositoryAnalysisOptions(invalidCatalog, deployment()).execute({
        workspaceId: "workspace-a",
      }),
    ).rejects.toMatchObject({ code: "administration.invalid" });
  });
});
