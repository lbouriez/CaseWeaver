import {
  ConnectorCancelledError,
  ConnectorProtocolError,
  type DiscoveryPage,
  type ExternalReference,
  InMemoryConnectorSecretResolver,
  versionedOpaqueValue,
} from "@caseweaver/connector-sdk";
import { describe, expect, it } from "vitest";
import {
  createGitMarkdownConfiguration,
  FakeGitRepository,
  fixtureOid,
} from "./fakes.js";
import { GitMarkdownKnowledgeSource } from "./git-markdown-source.js";

function createRepository(): FakeGitRepository {
  return new FakeGitRepository([
    {
      ref: "branch:main",
      commitSha: fixtureOid("a"),
      files: [
        {
          path: "README.md",
          blobOid: fixtureOid("b"),
          content: "# Root guide\n",
        },
        {
          path: "docs/install.md",
          blobOid: fixtureOid("c"),
          content: `---
title: Install
slug: installation
---
# Install
`,
        },
        {
          path: "docs/ignored.md",
          blobOid: fixtureOid("d"),
          content: "# Ignored\n",
        },
        {
          path: "docs/image.png",
          blobOid: fixtureOid("e"),
          content: "not markdown",
        },
      ],
    },
  ]);
}

function reference(path: string): ExternalReference {
  return {
    connectorInstanceId: "git-docs",
    resourceType: "document",
    externalId: path,
  };
}

function loadRequest(
  path: string,
  commitSha = fixtureOid("a"),
): Parameters<GitMarkdownKnowledgeSource["load"]>[0] {
  return {
    reference: reference(path),
    externalRevision: versionedOpaqueValue("git-commit.v1", commitSha),
    loadToken: versionedOpaqueValue("git-commit.v1", commitSha),
    signal: new AbortController().signal,
  };
}

async function collectPages(
  source: GitMarkdownKnowledgeSource,
  cursor?: { readonly version: string; readonly value: string },
): Promise<readonly DiscoveryPage<unknown>[]> {
  const pages: DiscoveryPage<unknown>[] = [];
  for await (const page of source.discover({
    signal: new AbortController().signal,
    pageSize: 1,
    cursor,
  })) {
    pages.push(page);
  }
  return pages;
}

describe("GitMarkdownKnowledgeSource", () => {
  it("discovers filtered Markdown files with blob fingerprints and commit load pins", async () => {
    const repository = createRepository();
    const source = new GitMarkdownKnowledgeSource({
      repository,
      configuration: createGitMarkdownConfiguration({
        paths: {
          include: ["docs/**/*.md"],
          exclude: ["docs/ignored.md"],
        },
      }),
    });

    const pages = await collectPages(source);

    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({
      mode: "snapshot",
      scanEpoch: { version: "git-commit.v1", value: fixtureOid("a") },
      nextCursor: {
        version: "git-markdown.cursor.v1",
        value: fixtureOid("a"),
      },
      complete: true,
      items: [
        {
          reference: reference("docs/install.md"),
          fingerprint: { version: "git-blob.v1", value: fixtureOid("c") },
          externalRevision: {
            version: "git-commit.v1",
            value: fixtureOid("a"),
          },
          loadToken: { version: "git-commit.v1", value: fixtureOid("a") },
        },
      ],
    });
    expect(repository.readCalls).toHaveLength(0);
  });

  it("uses an injected Git diff for additions, changes, moves, and removals", async () => {
    const repository = createRepository();
    const source = new GitMarkdownKnowledgeSource({
      repository,
      configuration: createGitMarkdownConfiguration(),
    });
    await collectPages(source);
    repository.setSnapshot({
      ref: "branch:main",
      commitSha: fixtureOid("f"),
      files: [
        {
          path: "README.md",
          blobOid: fixtureOid("b"),
          content: "# Root guide\n",
        },
        {
          path: "docs/install.md",
          blobOid: fixtureOid("9"),
          content: "# Updated install\n",
        },
        {
          path: "docs/moved.md",
          blobOid: fixtureOid("c"),
          content: "# Install\n",
        },
      ],
    });

    const pages = await collectPages(source, {
      version: "git-markdown.cursor.v1",
      value: fixtureOid("a"),
    });

    expect(pages).toHaveLength(3);
    expect(pages).toEqual([
      {
        mode: "delta",
        events: [
          { kind: "tombstone", reference: reference("docs/ignored.md") },
        ],
        nextCursor: {
          version: "git-markdown.cursor.v1",
          value: fixtureOid("f"),
        },
        complete: false,
      },
      {
        mode: "delta",
        events: [
          {
            kind: "upsert",
            item: {
              reference: reference("docs/install.md"),
              fingerprint: { version: "git-blob.v1", value: fixtureOid("9") },
              externalRevision: {
                version: "git-commit.v1",
                value: fixtureOid("f"),
              },
              loadToken: {
                version: "git-commit.v1",
                value: fixtureOid("f"),
              },
            },
          },
        ],
        nextCursor: {
          version: "git-markdown.cursor.v1",
          value: fixtureOid("f"),
        },
        complete: false,
      },
      {
        mode: "delta",
        events: [
          {
            kind: "upsert",
            item: {
              reference: reference("docs/moved.md"),
              fingerprint: { version: "git-blob.v1", value: fixtureOid("c") },
              externalRevision: {
                version: "git-commit.v1",
                value: fixtureOid("f"),
              },
              loadToken: {
                version: "git-commit.v1",
                value: fixtureOid("f"),
              },
            },
          },
        ],
        nextCursor: {
          version: "git-markdown.cursor.v1",
          value: fixtureOid("f"),
        },
        complete: true,
      },
    ]);
    expect(repository.readCalls).toHaveLength(0);
  });

  it("falls back to a complete snapshot when a forced non-ancestor cursor has no safe diff capability", async () => {
    const repository = createRepository();
    repository.setSnapshot({
      ref: "branch:main",
      commitSha: fixtureOid("f"),
      files: [
        {
          path: "docs/replaced-after-force-push.md",
          blobOid: fixtureOid("9"),
          content: "# Replacement\n",
        },
      ],
    });
    const snapshotOnlyRepository = {
      inspect: repository.inspect.bind(repository),
      readFile: repository.readFile.bind(repository),
    };
    const source = new GitMarkdownKnowledgeSource({
      repository: snapshotOnlyRepository,
      configuration: createGitMarkdownConfiguration(),
    });

    const pages = await collectPages(source, {
      version: "git-markdown.cursor.v1",
      value: fixtureOid("a"),
    });

    expect(pages).toEqual([
      {
        mode: "snapshot",
        scanEpoch: { version: "git-commit.v1", value: fixtureOid("f") },
        items: [
          expect.objectContaining({
            reference: reference("docs/replaced-after-force-push.md"),
            fingerprint: { version: "git-blob.v1", value: fixtureOid("9") },
          }),
        ],
        nextCursor: {
          version: "git-markdown.cursor.v1",
          value: fixtureOid("f"),
        },
        complete: true,
      },
    ]);
    expect(repository.inspectCalls).toHaveLength(1);
    expect(repository.readCalls).toHaveLength(0);
  });

  it("loads the discovered commit and returns generic provenance and anchors", async () => {
    const repository = createRepository();
    const source = new GitMarkdownKnowledgeSource({
      repository,
      configuration: createGitMarkdownConfiguration({
        docusaurus: {
          enabled: true,
          siteUrl: "https://docs.example.invalid",
          baseUrl: "/",
          routeBasePath: "docs",
          docsPath: "docs",
        },
      }),
    });

    const loaded = await source.load(loadRequest("docs/install.md"));

    expect(loaded).toMatchObject({
      reference: reference("docs/install.md"),
      externalRevision: { version: "git-commit.v1", value: fixtureOid("a") },
      title: "Install",
      body: { format: "markdown", normalizedText: "# Install\n" },
      provenance: {
        sourceUrl: "https://docs.example.invalid/docs/installation",
        sourceLocator: "docs/install.md",
        contentIdentity: { version: "git-blob.v1", value: fixtureOid("c") },
      },
      sourceAnchors: [{ anchor: "install", label: "Install", position: 1 }],
    });
    expect(repository.readCalls).toEqual([
      {
        ref: "branch:main",
        path: "docs/install.md",
        commitSha: fixtureOid("a"),
        authenticated: false,
      },
    ]);
  });

  it("uses the discovered commit after the configured branch moves", async () => {
    const repository = createRepository();
    const source = new GitMarkdownKnowledgeSource({
      repository,
      configuration: createGitMarkdownConfiguration(),
    });
    await collectPages(source);
    repository.setSnapshot({
      ref: "branch:main",
      commitSha: fixtureOid("f"),
      files: [
        {
          path: "docs/install.md",
          blobOid: fixtureOid("9"),
          content: "# Changed\n",
        },
      ],
    });

    const loaded = await source.load(loadRequest("docs/install.md"));

    expect(loaded.body.normalizedText).toBe("# Install\n");
    expect(loaded.externalRevision).toEqual({
      version: "git-commit.v1",
      value: fixtureOid("a"),
    });
    expect(repository.readCalls[0]).toMatchObject({
      commitSha: fixtureOid("a"),
    });
  });

  it("does not load references excluded by the configured path filters", async () => {
    const repository = createRepository();
    const source = new GitMarkdownKnowledgeSource({
      repository,
      configuration: createGitMarkdownConfiguration({
        paths: { include: ["docs/install.md"], exclude: [] },
      }),
    });

    await expect(
      source.load(loadRequest("docs/ignored.md")),
    ).rejects.toBeInstanceOf(ConnectorProtocolError);
    expect(repository.readCalls).toHaveLength(0);
  });

  it("requires a valid discovery load token and matching external revision", async () => {
    const source = new GitMarkdownKnowledgeSource({
      repository: createRepository(),
      configuration: createGitMarkdownConfiguration(),
    });

    await expect(
      source.load({
        reference: reference("docs/install.md"),
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ConnectorProtocolError);
    await expect(
      source.load({
        ...loadRequest("docs/install.md"),
        externalRevision: versionedOpaqueValue(
          "git-commit.v1",
          fixtureOid("f"),
        ),
      }),
    ).rejects.toBeInstanceOf(ConnectorProtocolError);
  });

  it("resolves a runtime token without storing it in configuration or repository calls", async () => {
    const repository = createRepository();
    const source = new GitMarkdownKnowledgeSource({
      repository,
      secrets: new InMemoryConnectorSecretResolver({
        "vault:git-docs-token": "never-persisted",
      }),
      configuration: createGitMarkdownConfiguration({
        authentication: { kind: "token", secretName: "repositoryToken" },
        secrets: { repositoryToken: "vault:git-docs-token" },
      }),
    });

    await source.load(loadRequest("docs/install.md"));

    expect(repository.readCalls).toEqual([
      {
        ref: "branch:main",
        path: "docs/install.md",
        commitSha: fixtureOid("a"),
        authenticated: true,
      },
    ]);
  });

  it("does not invoke the repository after cancellation", async () => {
    const repository = createRepository();
    const source = new GitMarkdownKnowledgeSource({
      repository,
      configuration: createGitMarkdownConfiguration(),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      source.load({
        reference: reference("docs/install.md"),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ConnectorCancelledError);
    expect(repository.readCalls).toHaveLength(0);
  });
});
