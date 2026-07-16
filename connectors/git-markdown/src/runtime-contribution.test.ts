import { InMemoryConnectorSecretResolver } from "@caseweaver/connector-sdk";
import { describe, expect, it, vi } from "vitest";

import { FakeGitRepository, fixtureOid } from "./fakes.js";
import { createGitMarkdownRuntimeContribution } from "./runtime-contribution.js";

const locator = "env:GIT_DOCUMENTATION_TOKEN";
const token = "git-runtime-test-token";

function privateConfiguration(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const { descriptor, settings, secretReferences, ...rest } = overrides;
  return {
    workspaceId: "workspace-1",
    connectorRegistrationId: "connector-1",
    configurationVersionId: "connector-version-1",
    descriptor: {
      kind: "connector" as const,
      type: "git-markdown",
      version: "1",
      ...(descriptor as Record<string, unknown> | undefined),
    },
    settings: {
      connectorInstanceId: "connector-1",
      repository: {
        kind: "remote",
        url: "https://github.example.test/acme/documentation.git",
      },
      ref: { kind: "branch", name: "main" },
      authentication: { kind: "token", secretName: locator },
      ...(settings as Record<string, unknown> | undefined),
    },
    secretReferences: [
      { locator },
      ...((secretReferences as
        | readonly { readonly locator: string }[]
        | undefined) ?? []),
    ],
    ...rest,
  };
}

describe("Git/Markdown runtime contribution", () => {
  it("constructs only its declared source from an exact private configuration", async () => {
    const repository = new FakeGitRepository([
      {
        ref: "branch:main",
        commitSha: fixtureOid("a"),
        files: [],
      },
    ]);
    const create = vi.fn(() => repository);
    const contribution = createGitMarkdownRuntimeContribution({
      repositoryFactory: { create },
    });
    const secrets = new InMemoryConnectorSecretResolver({ [locator]: token });

    const capabilities = await contribution.create({
      configuration: privateConfiguration(),
      secrets,
    });

    expect(contribution.descriptor).toEqual({
      kind: "connector",
      type: "git-markdown",
      version: "1",
    });
    expect(capabilities.knowledgeSource).toBeDefined();
    expect(create).toHaveBeenCalledOnce();
    expect(secrets.calls).toEqual([]);
  });

  it("fails closed before repository construction or secret resolution", async () => {
    const create = vi.fn();
    const secrets = new InMemoryConnectorSecretResolver({ [locator]: token });
    const contribution = createGitMarkdownRuntimeContribution({
      repositoryFactory: { create },
    });

    let failure: unknown;
    try {
      await contribution.create({
        configuration: privateConfiguration({
          descriptor: { version: "unexpected" },
        }),
        secrets,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "connector.configuration",
      category: "configuration",
      retryable: false,
    });
    expect(String(failure)).not.toContain(locator);
    expect(String(failure)).not.toContain(token);
    expect(create).not.toHaveBeenCalled();
    expect(secrets.calls).toEqual([]);
  });

  it("requires the exact opaque token locator recorded with the immutable version", async () => {
    const create = vi.fn();
    const secrets = new InMemoryConnectorSecretResolver({ [locator]: token });
    const contribution = createGitMarkdownRuntimeContribution({
      repositoryFactory: { create },
    });

    await expect(
      contribution.create({
        configuration: privateConfiguration({
          secretReferences: [{ locator: "env:OTHER_GIT_TOKEN" }],
        }),
        secrets,
      }),
    ).rejects.toMatchObject({ code: "connector.configuration" });

    expect(create).not.toHaveBeenCalled();
    expect(secrets.calls).toEqual([]);
  });
});
