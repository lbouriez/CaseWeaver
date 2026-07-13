import { redactConnectorConfiguration } from "@caseweaver/connector-sdk";
import { dirname, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { gitMarkdownConfigurationSchema } from "./config.js";

describe("Git Markdown configuration", () => {
  it("stores only a token reference and redacts it for diagnostics", () => {
    const configuration = gitMarkdownConfigurationSchema.parse({
      schemaVersion: 1,
      connectorType: "git-markdown",
      secrets: { repositoryToken: "vault:git-docs-token" },
      settings: {
        connectorInstanceId: "documentation",
        repository: {
          kind: "remote",
          url: "https://github.example.invalid/acme/docs.git",
        },
        ref: { kind: "tag", name: "v1.2.0" },
        authentication: { kind: "token", secretName: "repositoryToken" },
        docusaurus: {
          enabled: true,
          siteUrl: "https://docs.example.invalid",
          baseUrl: "/",
          routeBasePath: "docs",
          docsPath: "docs",
        },
      },
    });

    expect(redactConnectorConfiguration(configuration).secrets).toEqual({
      repositoryToken: "[redacted]",
    });
    expect(configuration.settings.paths.include).toEqual([
      "**/*.md",
      "**/*.mdx",
    ]);
  });

  it("rejects URL credentials and undeclared token references", () => {
    expect(() =>
      gitMarkdownConfigurationSchema.parse({
        schemaVersion: 1,
        connectorType: "git-markdown",
        secrets: {},
        settings: {
          connectorInstanceId: "documentation",
          repository: {
            kind: "remote",
            url: "https://token@github.example.invalid/acme/docs.git",
          },
          ref: { kind: "branch", name: "main" },
        },
      }),
    ).toThrow(/must not contain credentials/);

    expect(() =>
      gitMarkdownConfigurationSchema.parse({
        schemaVersion: 1,
        connectorType: "git-markdown",
        secrets: {},
        settings: {
          connectorInstanceId: "documentation",
          repository: {
            kind: "local",
            path: "C:\\repositories\\docs",
          },
          ref: { kind: "branch", name: "main" },
          authentication: { kind: "token", secretName: "repositoryToken" },
        },
      }),
    ).toThrow(/token secret reference is required/);
  });

  it.each([
    "C:\\unallowlisted\\docs",
    "..\\repositories\\docs",
    "C:\\repositories\\docs\\..\\secrets",
  ])("rejects a non-allowlisted or traversing local repository path: %s", (path) => {
    expect(() =>
      gitMarkdownConfigurationSchema.parse({
        schemaVersion: 1,
        connectorType: "git-markdown",
        secrets: {},
        settings: {
          connectorInstanceId: "documentation",
          repository: { kind: "local", path },
          ref: { kind: "branch", name: "main" },
        },
      }),
    ).toThrow();
  });

  it("accepts a local repository resolved within a configured allowed root", () => {
    const repositoryPath = process.cwd();

    expect(
      gitMarkdownConfigurationSchema.parse({
        schemaVersion: 1,
        connectorType: "git-markdown",
        secrets: {},
        settings: {
          connectorInstanceId: "documentation",
          repository: { kind: "local", path: repositoryPath },
          allowedLocalRoots: [repositoryPath],
          ref: { kind: "branch", name: "main" },
        },
      }).settings.repository,
    ).toEqual({ kind: "local", path: repositoryPath });
  });

  it.each([
    {
      name: "a path outside the configured root",
      path: dirname(process.cwd()),
      expectedError: /allowed local repository root/,
    },
    {
      name: "a traversing path",
      path: `${process.cwd()}${sep}..${sep}outside`,
      expectedError: /without traversal segments/,
    },
    {
      name: "a relative path",
      path: "repositories/docs",
      expectedError: /must be absolute/,
    },
    {
      name: "a path containing a control character",
      path: `${process.cwd()}${sep}invalid\u0001`,
      expectedError: /must not contain control characters/,
    },
  ])("rejects $name", ({ path, expectedError }) => {
    expect(() =>
      gitMarkdownConfigurationSchema.parse({
        schemaVersion: 1,
        connectorType: "git-markdown",
        secrets: {},
        settings: {
          connectorInstanceId: "documentation",
          repository: { kind: "local", path },
          allowedLocalRoots: [process.cwd()],
          ref: { kind: "branch", name: "main" },
        },
      }),
    ).toThrow(expectedError);
  });

  it("rejects allowed local roots that do not resolve canonically", () => {
    expect(() =>
      gitMarkdownConfigurationSchema.parse({
        schemaVersion: 1,
        connectorType: "git-markdown",
        secrets: {},
        settings: {
          connectorInstanceId: "documentation",
          repository: {
            kind: "remote",
            url: "https://github.example.invalid/acme/docs.git",
          },
          allowedLocalRoots: ["repositories/docs"],
          ref: { kind: "branch", name: "main" },
        },
      }),
    ).toThrow(/must be absolute/);
  });

  it.each([
    "https://token@github.example.invalid/acme/docs.git",
    "https://%75ser:%70assword@github.example.invalid/acme/docs.git",
  ])("rejects remote repository URL credentials: %s", (url) => {
    expect(() =>
      gitMarkdownConfigurationSchema.parse({
        schemaVersion: 1,
        connectorType: "git-markdown",
        secrets: {},
        settings: {
          connectorInstanceId: "documentation",
          repository: { kind: "remote", url },
          ref: { kind: "branch", name: "main" },
        },
      }),
    ).toThrow(/must not contain credentials/);
  });
});
