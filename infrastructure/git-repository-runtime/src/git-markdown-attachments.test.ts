import { gitMarkdownAttachmentReferenceId } from "@caseweaver/connector-git-markdown";
import {
  type AttachmentSource,
  ConnectorProtocolError,
} from "@caseweaver/connector-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  AesGcmGitMarkdownAttachmentLocatorCodec,
  GitMarkdownAttachmentDispatcher,
  type PublicHttpsImageAttachmentOpener,
  type PublicHttpsImageDnsResolver,
  type PublicHttpsImageTransport,
  type PublicHttpsImageTransportResponse,
  SecurePublicHttpsImageAttachmentOpener,
} from "./index.js";

const commit = "a".repeat(40);
const sourcePath = "docs/guides/attachments.md";

function key(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

function publicAddress() {
  return {
    kind: "publicHttpsImage" as const,
    connectorInstanceId: "git-docs",
    commitSha: commit,
    sourcePath,
    ordinal: 0,
    relation: "inlineImage" as const,
    url: "https://images.example.test/capture.png?version=1",
  };
}

function repositoryAddress() {
  return {
    kind: "repositoryFile" as const,
    connectorInstanceId: "git-docs",
    commitSha: commit,
    sourcePath,
    path: "docs/assets/capture.png",
    ordinal: 0,
    relation: "inlineImage" as const,
  };
}

function occurrence(locator: { version: string; value: string }) {
  return {
    owner: {
      kind: "knowledgeDocument" as const,
      document: {
        connectorInstanceId: "git-docs",
        resourceType: "document",
        externalId: sourcePath,
      },
    },
    ordinal: 0,
    relation: "inlineImage" as const,
    reference: {
      connectorInstanceId: "git-docs",
      resourceType: "attachment",
      externalId: gitMarkdownAttachmentReferenceId(locator),
    },
    locator,
  };
}

async function readBytes(
  content: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of content) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function* bytes(...values: readonly number[]): AsyncIterable<Uint8Array> {
  yield new Uint8Array(values);
}

function response(
  statusCode: number,
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  content: AsyncIterable<Uint8Array> = bytes(),
): PublicHttpsImageTransportResponse {
  return Object.freeze({
    statusCode,
    headers,
    body: content,
    dispose: vi.fn(),
  });
}

describe("AesGcmGitMarkdownAttachmentLocatorCodec", () => {
  it("uses the active key for new locators and decrypt-only rotated keys for retained locators", async () => {
    const original = new AesGcmGitMarkdownAttachmentLocatorCodec({
      activeKeyId: "old",
      keys: [{ id: "old", material: key(1) }],
    });
    const locator = await original.seal(
      publicAddress(),
      new AbortController().signal,
    );
    const rotated = new AesGcmGitMarkdownAttachmentLocatorCodec({
      activeKeyId: "new",
      keys: [
        { id: "new", material: key(2) },
        { id: "old", material: key(1) },
      ],
    });

    await expect(
      rotated.open(locator, new AbortController().signal),
    ).resolves.toEqual(publicAddress());
    expect(locator.value).not.toContain("images.example.test");
    expect(locator.value).not.toContain("capture.png");

    const replacement = await rotated.seal(
      repositoryAddress(),
      new AbortController().signal,
    );
    await expect(
      original.open(replacement, new AbortController().signal),
    ).rejects.toMatchObject({ code: "connector.protocol" });
  });

  it("fails closed without disclosing a sealed public URL when a locator is forged", async () => {
    const codec = new AesGcmGitMarkdownAttachmentLocatorCodec({
      activeKeyId: "active",
      keys: [{ id: "active", material: key(4) }],
    });
    const locator = await codec.seal(
      publicAddress(),
      new AbortController().signal,
    );
    const forged = {
      ...locator,
      value: `${locator.value.slice(0, -1)}${locator.value.endsWith("A") ? "B" : "A"}`,
    };

    let failure: unknown;
    try {
      await codec.open(forged, new AbortController().signal);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ConnectorProtocolError);
    expect(String(failure)).not.toContain("images.example.test");
    expect(String(failure)).not.toContain("capture.png");
  });
});

describe("GitMarkdownAttachmentDispatcher", () => {
  it("routes an identity-bound sealed public image without giving its URL to the repository source", async () => {
    const codec = new AesGcmGitMarkdownAttachmentLocatorCodec({
      activeKeyId: "active",
      keys: [{ id: "active", material: key(5) }],
    });
    const locator = await codec.seal(
      publicAddress(),
      new AbortController().signal,
    );
    const identity = occurrence(locator);
    const repositoryAttachmentSource: AttachmentSource = {
      openAttachment: vi.fn(),
    };
    const publicImageAttachmentOpener: PublicHttpsImageAttachmentOpener = {
      open: vi.fn(async () => ({
        content: bytes(1, 2, 3),
        mediaType: "image/png",
      })),
    };
    const dispatcher = new GitMarkdownAttachmentDispatcher({
      connectorInstanceId: "git-docs",
      locatorCodec: codec,
      repositoryAttachmentSource,
      publicImageAttachmentOpener,
    });

    const opened = await dispatcher.openAttachment({
      reference: identity.reference,
      identity,
      signal: new AbortController().signal,
    });

    await expect(readBytes(opened.content)).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(repositoryAttachmentSource.openAttachment).not.toHaveBeenCalled();
    expect(publicImageAttachmentOpener.open).toHaveBeenCalledWith(
      publicAddress(),
      expect.any(AbortSignal),
    );
  });

  it("rejects a locator that is valid cryptography but bound to another document before any opener runs", async () => {
    const codec = new AesGcmGitMarkdownAttachmentLocatorCodec({
      activeKeyId: "active",
      keys: [{ id: "active", material: key(6) }],
    });
    const locator = await codec.seal(
      publicAddress(),
      new AbortController().signal,
    );
    const identity = occurrence(locator);
    const repositoryAttachmentSource: AttachmentSource = {
      openAttachment: vi.fn(),
    };
    const publicImageAttachmentOpener: PublicHttpsImageAttachmentOpener = {
      open: vi.fn(),
    };
    const dispatcher = new GitMarkdownAttachmentDispatcher({
      connectorInstanceId: "git-docs",
      locatorCodec: codec,
      repositoryAttachmentSource,
      publicImageAttachmentOpener,
    });

    await expect(
      dispatcher.openAttachment({
        reference: identity.reference,
        identity: {
          ...identity,
          owner: {
            kind: "knowledgeDocument",
            document: {
              ...identity.owner.document,
              externalId: "docs/other.md",
            },
          },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "connector.protocol" });
    expect(repositoryAttachmentSource.openAttachment).not.toHaveBeenCalled();
    expect(publicImageAttachmentOpener.open).not.toHaveBeenCalled();
  });
});

describe("SecurePublicHttpsImageAttachmentOpener", () => {
  it("pins every redirect connection to a freshly screened public address and streams bounded image bytes", async () => {
    const resolved: string[] = [];
    const dnsResolver: PublicHttpsImageDnsResolver = {
      resolve: vi.fn(async (hostname: string) => {
        resolved.push(hostname);
        return hostname === "images.example.test" ? ["8.8.8.8"] : ["1.1.1.1"];
      }),
    };
    const first = response(302, {
      location: "https://cdn.example.test/final.png",
    });
    const second = response(
      200,
      { "content-length": "3", "content-type": "image/png" },
      bytes(1, 2, 3),
    );
    const transport: PublicHttpsImageTransport = {
      open: vi.fn(async () => (resolved.length === 1 ? first : second)),
    };
    const opener = new SecurePublicHttpsImageAttachmentOpener({
      dnsResolver,
      transport,
      limits: { maximumBytes: 3, maximumRedirects: 1 },
    });

    const opened = await opener.open(
      publicAddress(),
      new AbortController().signal,
    );

    expect(await readBytes(opened.content)).toEqual(new Uint8Array([1, 2, 3]));
    expect(transport.open).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ address: "8.8.8.8" }),
    );
    expect(transport.open).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ address: "1.1.1.1" }),
    );
    expect(resolved).toEqual(["images.example.test", "cdn.example.test"]);
  });

  it("fails before a network request for an unsafe DNS result and rejects compressed or oversized responses", async () => {
    const privateDns: PublicHttpsImageDnsResolver = {
      resolve: vi.fn(async () => ["127.0.0.1"]),
    };
    const transport: PublicHttpsImageTransport = { open: vi.fn() };
    const privateOpener = new SecurePublicHttpsImageAttachmentOpener({
      dnsResolver: privateDns,
      transport,
    });
    await expect(
      privateOpener.open(publicAddress(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "connector.protocol" });
    expect(transport.open).not.toHaveBeenCalled();

    // The deprecated 6to4 IPv4 relay-anycast range is not a public-image
    // destination even though it is not RFC1918. The runtime's stated SSRF
    // boundary rejects both native 6to4 and this IPv4 relay form.
    for (const relayAddress of [
      "192.88.99.0",
      "192.88.99.1",
      "192.88.99.255",
    ]) {
      const relayTransport: PublicHttpsImageTransport = { open: vi.fn() };
      const relayOpener = new SecurePublicHttpsImageAttachmentOpener({
        dnsResolver: { resolve: vi.fn(async () => [relayAddress]) },
        transport: relayTransport,
      });
      await expect(
        relayOpener.open(publicAddress(), new AbortController().signal),
      ).rejects.toMatchObject({ code: "connector.protocol" });
      expect(relayTransport.open).not.toHaveBeenCalled();
    }

    const publicDns: PublicHttpsImageDnsResolver = {
      resolve: vi.fn(async () => ["8.8.8.8"]),
    };
    const encodedTransport: PublicHttpsImageTransport = {
      open: vi.fn(async () =>
        response(200, {
          "content-encoding": "gzip",
          "content-type": "image/png",
        }),
      ),
    };
    const encodedOpener = new SecurePublicHttpsImageAttachmentOpener({
      dnsResolver: publicDns,
      transport: encodedTransport,
    });
    await expect(
      encodedOpener.open(publicAddress(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "connector.protocol" });

    const oversizedTransport: PublicHttpsImageTransport = {
      open: vi.fn(async () =>
        response(200, { "content-type": "image/png" }, bytes(1, 2, 3)),
      ),
    };
    const oversizedOpener = new SecurePublicHttpsImageAttachmentOpener({
      dnsResolver: publicDns,
      transport: oversizedTransport,
      limits: { maximumBytes: 2 },
    });
    const opened = await oversizedOpener.open(
      publicAddress(),
      new AbortController().signal,
    );
    await expect(readBytes(opened.content)).rejects.toMatchObject({
      code: "connector.protocol",
    });
  });
});
