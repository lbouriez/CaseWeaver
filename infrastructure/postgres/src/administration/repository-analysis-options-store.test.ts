import { describe, expect, it } from "vitest";

import { PostgresRepositoryAnalysisOptionsStore } from "./repository-analysis-options-store.js";

describe("PostgresRepositoryAnalysisOptionsStore", () => {
  it("returns only safe immutable choices with explicit draft and activation eligibility", async () => {
    const store = new PostgresRepositoryAnalysisOptionsStore({
      administrationConfiguration: {
        findMany: async (input: { where: { resourceType: string } }) =>
          input.where.resourceType === "code-repositories"
            ? [
                {
                  id: "repository-a",
                  lifecycle: "draft",
                  currentVersionId: "repository-v1",
                },
              ]
            : input.where.resourceType === "webhook-endpoints"
              ? [
                  {
                    id: "webhook-a",
                    lifecycle: "active",
                    currentVersionId: "webhook-v1",
                  },
                ]
              : [],
      },
      administrationConfigurationVersion: {
        findUnique: async (input: {
          where: { workspaceId_id: { id: string } };
        }) => {
          const id = input.where.workspaceId_id.id;
          const rows: Record<
            string,
            { configurationId: string; displayName: string }
          > = {
            "repository-v1": {
              configurationId: "repository-a",
              displayName: "Support repository",
            },
            "webhook-v1": {
              configurationId: "webhook-a",
              displayName: "Support webhook",
            },
          };
          return rows[id] ?? null;
        },
      },
      analysisProfile: { findMany: async () => [] },
      analysisProfileVersion: { findMany: async () => [] },
      publicationProfile: { findMany: async () => [] },
      publicationProfileVersion: { findMany: async () => [] },
      aiModelBinding: { findMany: async () => [] },
      knowledgeSource: { findMany: async () => [] },
      credentialRegistration: { findMany: async () => [] },
    } as never);

    const options = await store.listWorkspaceOptions({
      workspaceId: "workspace-a",
    });

    expect(options.codeRepositories).toEqual([
      {
        id: "repository-a",
        versionId: "repository-v1",
        label: "Support repository",
        lifecycle: "draft",
        eligibleForDraft: true,
        eligibleForActivation: false,
      },
    ]);
    expect(options.webhookEndpoints).toEqual([
      {
        id: "webhook-a",
        versionId: "webhook-v1",
        label: "Support webhook",
        lifecycle: "active",
        eligibleForDraft: true,
        eligibleForActivation: true,
      },
    ]);
    expect(JSON.stringify(options)).not.toContain("settings");
    expect(JSON.stringify(options)).not.toContain("secretReference");
    expect(JSON.stringify(options)).not.toContain("remoteUrl");
  });

  it("offers only current active repository-agent bindings with repository-agent and tools capabilities", async () => {
    const bindingQueries: unknown[] = [];
    const versionQueries: unknown[] = [];
    const store = new PostgresRepositoryAnalysisOptionsStore({
      administrationConfiguration: { findMany: async () => [] },
      administrationConfigurationVersion: { findUnique: async () => null },
      analysisProfile: { findMany: async () => [] },
      analysisProfileVersion: { findMany: async () => [] },
      publicationProfile: { findMany: async () => [] },
      publicationProfileVersion: { findMany: async () => [] },
      aiModelBinding: {
        findMany: async (input: unknown) => {
          bindingQueries.push(input);
          return [
            {
              id: "eligible",
              role: "repositoryAgent",
              lifecycle: "active",
              activeVersionId: "eligible-v1",
            },
            {
              id: "analysis-role",
              role: "analysis",
              lifecycle: "active",
              activeVersionId: "analysis-role-v1",
            },
            {
              id: "missing-tools",
              role: "repositoryAgent",
              lifecycle: "active",
              activeVersionId: "missing-tools-v1",
            },
            {
              id: "wrong-owner",
              role: "repositoryAgent",
              lifecycle: "active",
              activeVersionId: "wrong-owner-v1",
            },
          ];
        },
      },
      aiModelBindingVersion: {
        findMany: async (input: unknown) => {
          versionQueries.push(input);
          return [
            {
              id: "eligible-v1",
              modelBindingId: "eligible",
              capabilities: ["repositoryAgent", "tools"],
            },
            {
              id: "analysis-role-v1",
              modelBindingId: "analysis-role",
              capabilities: ["repositoryAgent", "tools"],
            },
            {
              id: "missing-tools-v1",
              modelBindingId: "missing-tools",
              capabilities: ["repositoryAgent"],
            },
            {
              id: "wrong-owner-v1",
              modelBindingId: "another-binding",
              capabilities: ["repositoryAgent", "tools"],
            },
          ];
        },
      },
      knowledgeSource: { findMany: async () => [] },
      credentialRegistration: { findMany: async () => [] },
    } as never);

    const options = await store.listWorkspaceOptions({
      workspaceId: "workspace-a",
    });

    expect(bindingQueries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          where: {
            workspaceId: "workspace-a",
            role: "repositoryAgent",
            lifecycle: "active",
            activeVersionId: { not: null },
          },
        }),
      ]),
    );
    expect(versionQueries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          where: {
            workspaceId: "workspace-a",
            id: {
              in: [
                "eligible-v1",
                "analysis-role-v1",
                "missing-tools-v1",
                "wrong-owner-v1",
              ],
            },
          },
        }),
      ]),
    );
    expect(options.repositoryAgentBindings).toEqual([
      {
        id: "eligible",
        versionId: "eligible-v1",
        label: "eligible",
        lifecycle: "active",
        eligibleForDraft: true,
        eligibleForActivation: true,
      },
    ]);
  });

  it("lists only capped active/current analysis bindings, recipes, and triggers with matching projections", async () => {
    const bindingQueries: unknown[] = [];
    const configurationQueries: unknown[] = [];
    const store = new PostgresRepositoryAnalysisOptionsStore({
      administrationConfiguration: {
        findMany: async (input: { where: { resourceType: string } }) => {
          configurationQueries.push(input);
          switch (input.where.resourceType) {
            case "analysis-recipes":
              return [
                {
                  id: "recipe-active",
                  lifecycle: "active",
                  currentVersionId: "recipe-active-v1",
                  privateSettings: { url: "https://private.invalid/recipe" },
                },
                {
                  id: "recipe-without-projection",
                  lifecycle: "active",
                  currentVersionId: "recipe-without-projection-v1",
                },
              ];
            case "case-analysis-triggers":
              return [
                {
                  id: "trigger-active",
                  lifecycle: "active",
                  currentVersionId: "trigger-active-v1",
                },
                {
                  id: "trigger-with-stale-aggregate",
                  lifecycle: "active",
                  currentVersionId: "trigger-with-stale-aggregate-v1",
                },
              ];
            default:
              return [];
          }
        },
      },
      administrationConfigurationVersion: {
        findUnique: async (input: {
          where: { workspaceId_id: { id: string } };
        }) => {
          const id = input.where.workspaceId_id.id;
          const values: Record<
            string,
            { readonly configurationId: string; readonly displayName: string }
          > = {
            "recipe-active-v1": {
              configurationId: "recipe-active",
              displayName: "Support recipe",
            },
            "recipe-without-projection-v1": {
              configurationId: "recipe-without-projection",
              displayName: "Invalid recipe",
            },
            "trigger-active-v1": {
              configurationId: "trigger-active",
              displayName: "Support trigger",
            },
            "trigger-with-stale-aggregate-v1": {
              configurationId: "trigger-with-stale-aggregate",
              displayName: "Invalid trigger",
            },
          };
          return values[id] ?? null;
        },
      },
      analysisProfile: { findMany: async () => [] },
      analysisProfileVersion: { findMany: async () => [] },
      publicationProfile: { findMany: async () => [] },
      publicationProfileVersion: { findMany: async () => [] },
      aiModelBinding: {
        findMany: async (input: unknown) => {
          bindingQueries.push(input);
          return [
            {
              id: "analysis-active",
              role: "analysis",
              lifecycle: "active",
              activeVersionId: "analysis-active-v1",
            },
            {
              id: "analysis-wrong-owner",
              role: "analysis",
              lifecycle: "active",
              activeVersionId: "analysis-wrong-owner-v1",
            },
          ];
        },
      },
      aiModelBindingVersion: {
        findMany: async () => [
          {
            id: "analysis-active-v1",
            modelBindingId: "analysis-active",
            providerEndpoint: "https://private.invalid/provider",
          },
          {
            id: "analysis-wrong-owner-v1",
            modelBindingId: "another-binding",
          },
        ],
      },
      analysisRecipeVersion: {
        findUnique: async (input: {
          where: {
            workspaceId_configurationVersionId: {
              configurationVersionId: string;
            };
          };
        }) =>
          input.where.workspaceId_configurationVersionId
            .configurationVersionId === "recipe-active-v1"
            ? {
                id: "recipe-active-v1",
                configurationVersionId: "recipe-active-v1",
              }
            : null,
      },
      analysisTrigger: {
        findUnique: async (input: {
          where: { workspaceId_id: { id: string } };
        }) =>
          input.where.workspaceId_id.id === "trigger-active"
            ? { lifecycle: "active", currentVersionId: "trigger-active-v1" }
            : {
                lifecycle: "active",
                currentVersionId: "different-trigger-version",
              },
      },
      analysisTriggerVersion: {
        findUnique: async (input: {
          where: { workspaceId_id: { id: string } };
        }) =>
          input.where.workspaceId_id.id === "trigger-active-v1"
            ? { id: "trigger-active-v1", analysisTriggerId: "trigger-active" }
            : {
                id: "trigger-with-stale-aggregate-v1",
                analysisTriggerId: "trigger-with-stale-aggregate",
              },
      },
      knowledgeSource: { findMany: async () => [] },
      credentialRegistration: { findMany: async () => [] },
    } as never);

    const options = await store.listWorkspaceOptions({
      workspaceId: "workspace-a",
    });

    expect(options.analysisBindings).toEqual([
      {
        id: "analysis-active",
        versionId: "analysis-active-v1",
        label: "analysis-active",
        lifecycle: "active",
        eligibleForDraft: true,
        eligibleForActivation: true,
      },
    ]);
    expect(options.analysisRecipes).toEqual([
      {
        id: "recipe-active",
        versionId: "recipe-active-v1",
        label: "Support recipe",
        lifecycle: "active",
        eligibleForDraft: true,
        eligibleForActivation: true,
      },
    ]);
    expect(options.caseAnalysisTriggers).toEqual([
      {
        id: "trigger-active",
        versionId: "trigger-active-v1",
        label: "Support trigger",
        lifecycle: "active",
        eligibleForDraft: true,
        eligibleForActivation: true,
      },
    ]);
    expect(configurationQueries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          where: expect.objectContaining({
            resourceType: "analysis-recipes",
            lifecycle: "active",
            currentVersionId: { not: null },
          }),
          take: 200,
        }),
        expect.objectContaining({
          where: expect.objectContaining({
            resourceType: "case-analysis-triggers",
            lifecycle: "active",
            currentVersionId: { not: null },
          }),
          take: 200,
        }),
      ]),
    );
    expect(bindingQueries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          where: {
            workspaceId: "workspace-a",
            role: "analysis",
            lifecycle: "active",
            activeVersionId: { not: null },
          },
          take: 200,
        }),
      ]),
    );
    const serialized = JSON.stringify(options);
    expect(serialized).not.toContain("private.invalid");
    expect(serialized).not.toContain("privateSettings");
  });
});
