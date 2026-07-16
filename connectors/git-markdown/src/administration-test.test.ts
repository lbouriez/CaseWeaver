import { describe, expect, it } from "vitest";

import { testGitMarkdownAdministrationSettings } from "./administration-test.js";
import {
  createGitMarkdownConfiguration,
  FakeGitRepository,
  FakeGitSecretResolver,
  fixtureOid,
} from "./fakes.js";

describe("Git/Markdown administration test", () => {
  it("uses one server-side repository inspection and resolves only its configured opaque reference", async () => {
    const repository = new FakeGitRepository([
      {
        ref: "branch:main",
        commitSha: fixtureOid("a"),
        files: [],
      },
    ]);
    const secrets = new FakeGitSecretResolver("test-only-token");
    const settings = createGitMarkdownConfiguration({
      secrets: { repositoryToken: "env:GIT_TOKEN" },
      authentication: { kind: "token", secretName: "repositoryToken" },
    }).settings;

    await expect(
      testGitMarkdownAdministrationSettings({
        settings,
        repository,
        secrets,
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();

    expect(repository.inspectCalls).toEqual([
      { ref: "branch:main", authenticated: true },
    ]);
    expect(secrets.references).toEqual(["repositoryToken"]);
  });

  it("rejects malformed candidate settings before attempting repository access", async () => {
    const repository = new FakeGitRepository([]);

    await expect(
      testGitMarkdownAdministrationSettings({
        settings: { repository: { kind: "remote" } },
        repository,
        secrets: new FakeGitSecretResolver("test-only-token"),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(repository.inspectCalls).toEqual([]);
  });
});
