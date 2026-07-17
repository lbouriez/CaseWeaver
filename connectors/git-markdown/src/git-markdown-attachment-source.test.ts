import {
  type AttachmentOccurrence,
  ConnectorCancelledError,
  ConnectorConfigurationError,
  ConnectorProtocolError,
  type ExternalReference,
} from "@caseweaver/connector-sdk";
import { describe, expect, it } from "vitest";

import {
  type GitMarkdownAttachmentLocatorCodec,
  gitMarkdownAttachmentReferenceId,
} from "./attachment-locator.js";
import {
  createGitMarkdownConfiguration,
  FakeGitMarkdownAttachmentLocatorCodec,
  FakeGitRepository,
  fixtureOid,
} from "./fakes.js";
import { GitMarkdownAttachmentSource } from "./git-markdown-attachment-source.js";
import { GitMarkdownKnowledgeSource } from "./git-markdown-source.js";

function documentReference(path = "docs/guides/install.md"): ExternalReference {
  return {
    connectorInstanceId: "git-docs",
    resourceType: "document",
    externalId: path,
  };
}

const installationMarkdown = `# Install
![Screen](../assets/install.png)
[Run log](logs/first-run.log)
![Public screen](https://images.example.test/install.png)
![Repeated screen](../assets/install.png)
\`\`\`md
![Ignored](../../private.png)
\`\`\`
`;

function createRepository(): FakeGitRepository {
  return new FakeGitRepository([
    {
      ref: "branch:main",
      commitSha: fixtureOid("a"),
      files: [
        {
          path: "docs/guides/install.md",
          blobOid: fixtureOid("b"),
          content: installationMarkdown,
        },
        {
          path: "docs/assets/install.png",
          blobOid: fixtureOid("c"),
          content: "unused text content",
          binaryContent: [new Uint8Array([1, 2]), new Uint8Array([3])],
          mediaType: "image/png",
        },
        {
          path: "docs/guides/logs/first-run.log",
          blobOid: fixtureOid("d"),
          content: "first run completed",
        },
      ],
    },
  ]);
}

async function readBytes(
  content: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of content) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function loadOccurrences(input: {
  readonly repository: FakeGitRepository;
  readonly codec: FakeGitMarkdownAttachmentLocatorCodec;
}): Promise<AttachmentOccurrence[]> {
  const source = new GitMarkdownKnowledgeSource({
    repository: input.repository,
    attachmentLocatorCodec: input.codec,
    configuration: createGitMarkdownConfiguration(),
  });
  const result = await source.load({
    reference: documentReference(),
    externalRevision: { version: "git-commit.v1", value: fixtureOid("a") },
    loadToken: { version: "git-commit.v1", value: fixtureOid("a") },
    signal: new AbortController().signal,
  });
  return result.attachmentOccurrences ?? [];
}

describe("GitMarkdown attachment occurrences and binary source", () => {
  it("emits stable owner ordinals and opaque locators without changing Markdown text", async () => {
    const repository = createRepository();
    const codec = new FakeGitMarkdownAttachmentLocatorCodec();
    const source = new GitMarkdownKnowledgeSource({
      repository,
      attachmentLocatorCodec: codec,
      configuration: createGitMarkdownConfiguration(),
    });

    const document = await source.load({
      reference: documentReference(),
      externalRevision: { version: "git-commit.v1", value: fixtureOid("a") },
      loadToken: { version: "git-commit.v1", value: fixtureOid("a") },
      signal: new AbortController().signal,
    });

    expect(document.body.normalizedText).toBe(installationMarkdown);
    expect(document.attachmentOccurrences).toHaveLength(4);
    expect(
      document.attachmentOccurrences?.map((occurrence) => ({
        ordinal: occurrence.ordinal,
        relation: occurrence.relation,
        owner: occurrence.owner,
      })),
    ).toEqual([
      {
        ordinal: 0,
        relation: "inlineImage",
        owner: { kind: "knowledgeDocument", document: documentReference() },
      },
      {
        ordinal: 1,
        relation: "inlineFile",
        owner: { kind: "knowledgeDocument", document: documentReference() },
      },
      {
        ordinal: 2,
        relation: "inlineImage",
        owner: { kind: "knowledgeDocument", document: documentReference() },
      },
      {
        ordinal: 3,
        relation: "inlineImage",
        owner: { kind: "knowledgeDocument", document: documentReference() },
      },
    ]);
    for (const occurrence of document.attachmentOccurrences ?? []) {
      expect(occurrence.reference).toMatchObject({
        connectorInstanceId: "git-docs",
        resourceType: "attachment",
        externalId: gitMarkdownAttachmentReferenceId(occurrence.locator),
      });
      expect(occurrence.reference.externalId).not.toContain(
        occurrence.locator.value,
      );
      expect(occurrence.reference.externalId).toHaveLength(72);
    }
    expect(JSON.stringify(document.attachmentOccurrences)).not.toContain(
      "https://images.example.test",
    );
    expect(
      document.attachmentOccurrences?.every(
        (occurrence) => !occurrence.locator.value.includes("docs/"),
      ),
    ).toBe(true);
  });

  it("streams a repository attachment from the sealed exact commit without direct public fetches", async () => {
    const repository = createRepository();
    const codec = new FakeGitMarkdownAttachmentLocatorCodec();
    const occurrences = await loadOccurrences({ repository, codec });
    const attachmentSource = new GitMarkdownAttachmentSource({
      repository,
      locatorCodec: codec,
      configuration: createGitMarkdownConfiguration(),
    });
    const repositoryOccurrence = occurrences[0];
    const publicOccurrence = occurrences[2];
    if (repositoryOccurrence === undefined || publicOccurrence === undefined) {
      throw new Error(
        "The fixture must provide repository and public occurrences.",
      );
    }

    repository.setSnapshot({
      ref: "branch:main",
      commitSha: fixtureOid("e"),
      files: [],
    });
    const opened = await attachmentSource.openAttachment({
      reference: repositoryOccurrence.reference,
      identity: repositoryOccurrence,
      signal: new AbortController().signal,
    });

    await expect(readBytes(opened.content)).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(opened.mediaType).toBe("image/png");
    expect(repository.binaryReadCalls).toEqual([
      {
        ref: "branch:main",
        path: "docs/assets/install.png",
        commitSha: fixtureOid("a"),
        authenticated: false,
      },
    ]);

    await expect(
      attachmentSource.openAttachment({
        reference: publicOccurrence.reference,
        identity: publicOccurrence,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ConnectorProtocolError);
    expect(repository.binaryReadCalls).toHaveLength(1);
  });

  it("fails closed when a caller changes the occurrence owner or reference", async () => {
    const repository = createRepository();
    const codec = new FakeGitMarkdownAttachmentLocatorCodec();
    const [occurrence] = await loadOccurrences({ repository, codec });
    if (occurrence === undefined)
      throw new Error("The fixture must provide an occurrence.");
    const attachmentSource = new GitMarkdownAttachmentSource({
      repository,
      locatorCodec: codec,
      configuration: createGitMarkdownConfiguration(),
    });
    const forged: AttachmentOccurrence = {
      ...occurrence,
      owner: {
        kind: "knowledgeDocument",
        document: documentReference("docs/other.md"),
      },
    };

    await expect(
      attachmentSource.openAttachment({
        reference: forged.reference,
        identity: forged,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ConnectorProtocolError);
    await expect(
      attachmentSource.openAttachment({
        reference: {
          ...occurrence.reference,
          externalId: "another_opaque_reference",
        },
        identity: occurrence,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ConnectorProtocolError);
    expect(repository.binaryReadCalls).toHaveLength(0);
  });

  it("fails closed before a binary read when a decoded locator is not bound to its occurrence", async () => {
    const repository = createRepository();
    const originalCodec = new FakeGitMarkdownAttachmentLocatorCodec();
    const [occurrence] = await loadOccurrences({
      repository,
      codec: originalCodec,
    });
    if (occurrence === undefined)
      throw new Error("The fixture must provide an occurrence.");

    const tamperedAddresses = [
      {
        sourcePath: "docs/guides/unrelated.md",
        ordinal: occurrence.ordinal,
        relation: occurrence.relation,
      },
      {
        sourcePath: "docs/guides/install.md",
        ordinal: occurrence.ordinal + 1,
        relation: occurrence.relation,
      },
      {
        sourcePath: "docs/guides/install.md",
        ordinal: occurrence.ordinal,
        relation: "inlineFile" as const,
      },
    ];

    for (const mismatch of tamperedAddresses) {
      const locatorCodec: GitMarkdownAttachmentLocatorCodec = {
        async seal() {
          throw new Error("The attachment source does not seal locators.");
        },
        async open() {
          return {
            kind: "repositoryFile" as const,
            connectorInstanceId: "git-docs",
            commitSha: fixtureOid("a"),
            path: "docs/assets/install.png",
            ...mismatch,
          };
        },
      };
      const attachmentSource = new GitMarkdownAttachmentSource({
        repository,
        locatorCodec,
        configuration: createGitMarkdownConfiguration(),
      });

      await expect(
        attachmentSource.openAttachment({
          reference: occurrence.reference,
          identity: occurrence,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(ConnectorProtocolError);
    }

    expect(repository.binaryReadCalls).toHaveLength(0);
  });

  it("propagates cancellation to a repository attachment stream", async () => {
    const repository = createRepository();
    const codec = new FakeGitMarkdownAttachmentLocatorCodec();
    const [occurrence] = await loadOccurrences({ repository, codec });
    if (occurrence === undefined)
      throw new Error("The fixture must provide an occurrence.");
    const attachmentSource = new GitMarkdownAttachmentSource({
      repository,
      locatorCodec: codec,
      configuration: createGitMarkdownConfiguration(),
    });
    const controller = new AbortController();

    const opened = await attachmentSource.openAttachment({
      reference: occurrence.reference,
      identity: occurrence,
      signal: controller.signal,
    });
    controller.abort();

    await expect(readBytes(opened.content)).rejects.toBeInstanceOf(
      ConnectorCancelledError,
    );
    expect(repository.binaryReadCalls).toHaveLength(1);
  });

  it("fails closed when a legacy Git runtime cannot stream attachment bytes", async () => {
    const repository = createRepository();
    const codec = new FakeGitMarkdownAttachmentLocatorCodec();
    const [occurrence] = await loadOccurrences({ repository, codec });
    if (occurrence === undefined)
      throw new Error("The fixture must provide an occurrence.");
    const legacyRepository = {
      inspect: repository.inspect.bind(repository),
      readFile: repository.readFile.bind(repository),
    };
    const attachmentSource = new GitMarkdownAttachmentSource({
      repository: legacyRepository,
      locatorCodec: codec,
      configuration: createGitMarkdownConfiguration(),
    });

    await expect(
      attachmentSource.openAttachment({
        reference: occurrence.reference,
        identity: occurrence,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ConnectorConfigurationError);
    expect(repository.binaryReadCalls).toHaveLength(0);
  });

  it("does not disclose a public URL or codec failure while sealing an occurrence", async () => {
    const repository = createRepository();
    const codec: GitMarkdownAttachmentLocatorCodec = {
      async seal() {
        throw new Error(
          "https://operator:untrusted-secret@images.example.test/private.png",
        );
      },
      async open() {
        throw new Error("not reached");
      },
    };
    const source = new GitMarkdownKnowledgeSource({
      repository,
      attachmentLocatorCodec: codec,
      configuration: createGitMarkdownConfiguration(),
    });

    let failure: unknown;
    try {
      await source.load({
        reference: documentReference(),
        externalRevision: {
          version: "git-commit.v1",
          value: fixtureOid("a"),
        },
        loadToken: { version: "git-commit.v1", value: fixtureOid("a") },
        signal: new AbortController().signal,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ConnectorProtocolError);
    expect(String(failure)).not.toContain("images.example.test");
    expect(String(failure)).not.toContain("untrusted-secret");
  });

  it("keeps a Markdown document usable when its optional public-image locator cannot be sealed", async () => {
    const repository = createRepository();
    const delegate = new FakeGitMarkdownAttachmentLocatorCodec();
    const codec: GitMarkdownAttachmentLocatorCodec = {
      async seal(address, signal) {
        if (address.kind === "publicHttpsImage") {
          throw new Error("external image locator unavailable");
        }
        return delegate.seal(address, signal);
      },
      open: delegate.open.bind(delegate),
    };
    const source = new GitMarkdownKnowledgeSource({
      repository,
      attachmentLocatorCodec: codec,
      configuration: createGitMarkdownConfiguration(),
    });

    const document = await source.load({
      reference: documentReference(),
      externalRevision: { version: "git-commit.v1", value: fixtureOid("a") },
      loadToken: { version: "git-commit.v1", value: fixtureOid("a") },
      signal: new AbortController().signal,
    });

    expect(document.body.normalizedText).toBe(installationMarkdown);
    expect(document.attachmentOccurrences).toHaveLength(3);
    expect(
      document.attachmentOccurrences?.some(
        (occurrence) => occurrence.ordinal === 2,
      ),
    ).toBe(false);
  });
});
