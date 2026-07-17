import {
  type AttachmentOpenIdentity,
  ConnectorCancelledError,
} from "@caseweaver/connector-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  jitbitAttachmentLocator,
  jitbitAttachmentReference,
} from "./attachment-identity.js";
import { JitbitClient } from "./client.js";
import {
  createJitbitConfiguration,
  createJitbitSecretResolver,
  jsonResponse,
} from "./fakes.js";
import { JitbitAttachmentSource } from "./jitbit-attachment-source.js";

const connectorInstanceId = "jitbit-helpdesk";
const ticketId = "42";
const attachmentId = "7";
const reference = jitbitAttachmentReference(
  connectorInstanceId,
  ticketId,
  attachmentId,
);

function identity(): AttachmentOpenIdentity {
  return {
    owner: {
      kind: "caseMessage",
      case: {
        connectorInstanceId,
        resourceType: "case",
        externalId: ticketId,
      },
      messageExternalId: `ticket:${ticketId}`,
    },
    ordinal: 0,
    relation: "inlineImage",
    reference,
    locator: jitbitAttachmentLocator(attachmentId),
  };
}

function sourceFor(fetch: typeof globalThis.fetch): JitbitAttachmentSource {
  const configuration = createJitbitConfiguration();
  return new JitbitAttachmentSource({
    configuration,
    client: new JitbitClient({
      configuration,
      secrets: createJitbitSecretResolver(),
      fetch,
      sleep: async () => undefined,
    }),
  });
}

describe("JitbitAttachmentSource", () => {
  it("streams the authenticated attachment response without buffering bytes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const request = new URL(String(url));
      expect(request.pathname).toBe("/api/attachment");
      expect(request.searchParams.get("id")).toBe(attachmentId);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer test-token",
      );
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.enqueue(new Uint8Array([3]));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": "3",
          },
        },
      );
    });
    const source = sourceFor(fetch);

    const opened = await source.openAttachment({
      reference,
      identity: identity(),
      signal: new AbortController().signal,
    });

    expect(opened.mediaType).toBe("image/png");
    expect(opened.contentLength).toBe(3);
    await expect(Array.fromAsync(opened.content)).resolves.toEqual([
      new Uint8Array([1, 2]),
      new Uint8Array([3]),
    ]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("cancels a live stream and never accepts a foreign occurrence identity", async () => {
    let cancelled = false;
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    );
    const source = sourceFor(fetch);
    const controller = new AbortController();
    const opened = await source.openAttachment({
      reference,
      identity: identity(),
      signal: controller.signal,
    });
    const iterator = opened.content[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: new Uint8Array([1]),
    });
    controller.abort();
    await expect(iterator.next()).rejects.toBeInstanceOf(
      ConnectorCancelledError,
    );
    expect(cancelled).toBe(true);

    await expect(
      source.openAttachment({
        reference,
        identity: {
          ...identity(),
          reference: { ...reference, connectorInstanceId: "other" },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("does not belong to Jitbit");
    await expect(
      source.openAttachment({
        reference,
        identity: {
          ...identity(),
          owner: {
            kind: "caseMessage",
            case: {
              connectorInstanceId: "other",
              resourceType: "case",
              externalId: ticketId,
            },
            messageExternalId: `ticket:${ticketId}`,
          },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("does not belong to Jitbit");
    await expect(
      source.openAttachment({
        reference,
        identity: {
          ...identity(),
          owner: {
            kind: "caseMessage",
            case: {
              connectorInstanceId,
              resourceType: "resolved-case",
              externalId: ticketId,
            },
            messageExternalId: `ticket:${ticketId}`,
          },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("does not belong to Jitbit");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps remote attachment failures generic and supports legacy metadata references", async () => {
    const secret = "test-token";
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(
        { token: secret, url: "https://helpdesk.example.invalid/private/7" },
        { status: 500 },
      ),
    );
    const source = sourceFor(fetch);

    let failure: unknown;
    try {
      await source.openAttachment({
        reference,
        signal: new AbortController().signal,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "connector.remote",
      category: "remote",
      retryable: true,
    });
    expect(String(failure)).not.toContain(secret);
    expect(String(failure)).not.toContain("helpdesk.example.invalid");
    expect(String(failure)).not.toContain("private/7");
    expect((failure as Error).cause).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("opens a legacy metadata reference and rejects a malformed opaque locator before I/O", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      expect(new URL(String(url)).searchParams.get("id")).toBe(attachmentId);
      return new Response(new Uint8Array([9]), { status: 200 });
    });
    const source = sourceFor(fetch);

    const opened = await source.openAttachment({
      reference,
      signal: new AbortController().signal,
    });

    await expect(Array.fromAsync(opened.content)).resolves.toEqual([
      new Uint8Array([9]),
    ]);
    expect(fetch).toHaveBeenCalledOnce();

    await expect(
      source.openAttachment({
        reference,
        identity: {
          ...identity(),
          locator: {
            version: "jitbit.attachment.v1",
            value: "https://operator:secret@helpdesk.example.test/File/Get/7",
          },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("requested attachment is invalid");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
