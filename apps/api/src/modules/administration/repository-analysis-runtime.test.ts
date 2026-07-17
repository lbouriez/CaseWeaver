import { describe, expect, it } from "vitest";

import {
  EnvironmentRepositoryAnalysisDeploymentRegistry,
  parseRepositoryAnalysisDeploymentConfiguration,
  RepositoryAnalysisDeploymentConfigurationError,
} from "./repository-analysis-runtime.js";

describe("repository analysis deployment configuration", () => {
  it("projects deployment aliases without leaking a mounted host directory", async () => {
    const configuration = parseRepositoryAnalysisDeploymentConfiguration({
      ADMIN_REPOSITORY_ANALYSIS_MOUNTS_JSON:
        '[{"id":"support-repository","label":"Support service","directory":"/srv/caseweaver/support"}]',
      ADMIN_REPOSITORY_ANALYSIS_SANDBOX_POLICIES_JSON:
        '[{"id":"sandbox-readonly","label":"Read-only analysis sandbox"}]',
      ADMIN_REPOSITORY_ANALYSIS_ATTACHMENT_PROCESSOR_POLICIES_JSON:
        '[{"id":"attachments-safe","label":"Safe attachment processor"}]',
      ADMIN_REPOSITORY_ANALYSIS_GIT_TEMPORARY_DIRECTORY: "/var/tmp/caseweaver",
      ADMIN_REPOSITORY_ANALYSIS_GIT_REMOTE_CACHE_DIRECTORY:
        "/var/cache/caseweaver/git",
    });
    const registry = new EnvironmentRepositoryAnalysisDeploymentRegistry(
      configuration,
    );

    await expect(registry.listMountedRepositories()).resolves.toEqual([
      {
        id: "support-repository",
        label: "Support service",
        eligibleForDraft: true,
        eligibleForActivation: true,
      },
    ]);
    expect(JSON.stringify(await registry.listMountedRepositories())).not.toContain(
      "/srv/caseweaver/support",
    );
    expect(configuration.gitRemoteCacheDirectory).toBe(
      "/var/cache/caseweaver/git",
    );
  });

  it("fails API startup for malformed paths, duplicate aliases, or unknown fields", () => {
    expect(() =>
      parseRepositoryAnalysisDeploymentConfiguration({
        ADMIN_REPOSITORY_ANALYSIS_MOUNTS_JSON:
          '[{"id":"a","label":"One","directory":"relative/path"}]',
      }),
    ).toThrow(RepositoryAnalysisDeploymentConfigurationError);
    expect(() =>
      parseRepositoryAnalysisDeploymentConfiguration({
        ADMIN_REPOSITORY_ANALYSIS_SANDBOX_POLICIES_JSON:
          '[{"id":"a","label":"One"},{"id":"a","label":"Two"}]',
      }),
    ).toThrow(RepositoryAnalysisDeploymentConfigurationError);
    expect(() =>
      parseRepositoryAnalysisDeploymentConfiguration({
        ADMIN_REPOSITORY_ANALYSIS_ATTACHMENT_PROCESSOR_POLICIES_JSON:
          '[{"id":"a","label":"One","image":"private"}]',
      }),
    ).toThrow(RepositoryAnalysisDeploymentConfigurationError);
  });
});
