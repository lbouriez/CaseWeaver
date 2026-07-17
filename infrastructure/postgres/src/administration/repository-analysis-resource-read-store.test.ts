import { describe, expect, it } from "vitest";

import { PostgresRepositoryAnalysisResourceReadStore } from "./repository-analysis-resource-read-store.js";

describe("PostgresRepositoryAnalysisResourceReadStore", () => {
  it("lists and details code repositories from safe immutable projection columns only", async () => {
    const store = new PostgresRepositoryAnalysisResourceReadStore({
      administrationConfiguration: {
        findMany: async () => [
          {
            id: "repository-a",
            lifecycle: "draft",
            revision: 1,
            currentVersionId: "repository-v1",
            updatedAt: new Date("2026-07-16T12:00:00.000Z"),
          },
        ],
        findFirst: async () => ({
          id: "repository-a",
          lifecycle: "draft",
          revision: 1,
          currentVersionId: "repository-v1",
          updatedAt: new Date("2026-07-16T12:00:00.000Z"),
        }),
      },
      administrationConfigurationVersion: {
        findUnique: async () => ({
          configurationId: "repository-a",
          displayName: "Support repository",
        }),
      },
      codeRepositoryVersion: {
        findUnique: async () => ({
          mode: "remoteHttps",
          allowedRefKinds: ["branch", "tag"],
          checkoutCredentialRequired: true,
        }),
      },
    } as never);

    await expect(
      store.list({
        workspaceId: "workspace-a",
        resource: "code-repositories",
        limit: 20,
      }),
    ).resolves.toEqual({
      items: [
        {
          id: "repository-a",
          label: "Support repository",
          status: "draft",
          version: "1",
          updatedAt: "2026-07-16T12:00:00.000Z",
          summary:
            "Immutable configuration; sensitive settings remain server-private.",
        },
      ],
      page: { hasNextPage: false },
    });
    const detail = await store.detail({
      workspaceId: "workspace-a",
      resource: "code-repositories",
      id: "repository-a",
    });
    expect(detail?.fields).toEqual({
      lifecycle: "draft",
      revision: 1,
      currentVersionId: "repository-v1",
      mode: "remoteHttps",
      allowedRefKindCount: 2,
      checkoutCredentialRequired: true,
    });
    expect(JSON.stringify(detail)).not.toContain("remoteUrl");
    expect(JSON.stringify(detail)).not.toContain("locator");
  });
});
