import {
  ConnectorProtocolError,
  type DiscoveryPage,
  type DiscoveredCase,
  type DiscoveredKnowledgeItem,
} from "@caseweaver/connector-sdk";
import { describe, expect, it } from "vitest";

import { JitbitCaseSource } from "./jitbit-case-source.js";
import { JitbitClient } from "./client.js";
import {
  createJitbitConfiguration,
  createJitbitSecretResolver,
  jsonResponse,
} from "./fakes.js";
import { JitbitKnowledgeSource } from "./jitbit-knowledge-source.js";

function clientFor(
  responder: (url: URL, init: RequestInit) => Response | Promise<Response>,
): JitbitClient {
  return new JitbitClient({
    configuration: createJitbitConfiguration(),
    secrets: createJitbitSecretResolver(),
    fetch: async (url, init) => responder(new URL(String(url)), init),
  });
}

async function collect<T>(
  pages: AsyncIterable<DiscoveryPage<T>>,
): Promise<readonly DiscoveryPage<T>[]> {
  const result: DiscoveryPage<T>[] = [];
  for await (const page of pages) result.push(page);
  return result;
}

describe("Jitbit sources", () => {
  it("discovers resolved tickets as delta pages without loading ticket bodies", async () => {
    const urls: URL[] = [];
    const client = clientFor((url) => {
      urls.push(url);
      return jsonResponse([
        {
          IssueID: 7,
          Status: "Resolved",
          LastUpdated: "2026-07-13T12:00:00Z",
        },
        { IssueID: 8, Status: "Open", LastUpdated: "2026-07-13T12:01:00Z" },
      ]);
    });
    const source = new JitbitKnowledgeSource({
      client,
      configuration: createJitbitConfiguration(),
      now: () => new Date("2026-07-13T18:00:00.000Z"),
    });

    const pages = await collect<DiscoveredKnowledgeItem>(
      source.discover({ pageSize: 3, signal: new AbortController().signal }),
    );

    expect(pages).toEqual([
      {
        mode: "delta",
        events: [
          {
            kind: "upsert",
            item: expect.objectContaining({
              reference: {
                connectorInstanceId: "jitbit-helpdesk",
                resourceType: "resolved-case",
                externalId: "7",
              },
              fingerprint: {
                version: "jitbit.last-updated.v1",
                value: "2026-07-13T12:00:00.000Z",
              },
            }),
          },
        ],
        nextCursor: expect.objectContaining({
          version: "jitbit.discovery.v1",
        }),
        complete: true,
      },
    ]);
    expect(urls.map((url) => url.pathname)).toEqual(["/api/Tickets"]);
    expect(urls[0]?.searchParams.get("count")).toBe("3");
    expect(urls[0]?.searchParams.get("offset")).toBe("0");
  });

  it("continues opaque delta pagination and sends the conservative updated-from overlap", async () => {
    const requests: URL[] = [];
    const client = clientFor((url) => {
      requests.push(url);
      return jsonResponse(
        url.searchParams.get("offset") === "0"
          ? [{ IssueID: 7, Status: "Resolved" }]
          : [],
      );
    });
    const source = new JitbitKnowledgeSource({
      client,
      configuration: createJitbitConfiguration(),
      now: () => new Date("2026-07-13T18:00:00.000Z"),
    });
    const first = await collect(
      source.discover({ pageSize: 1, signal: new AbortController().signal }),
    );
    const cursor = first[1]?.nextCursor;
    expect(cursor).toBeDefined();
    const second = await collect(
      source.discover({
        pageSize: 1,
        cursor,
        signal: new AbortController().signal,
      }),
    );
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(first[0]).toMatchObject({ mode: "delta", complete: false });
    expect(first[1]).toMatchObject({ mode: "delta", complete: true });
    expect(second[0]).toMatchObject({ mode: "delta", complete: false });
    expect(second[1]).toMatchObject({ mode: "delta", complete: true });
    expect(requests.map((url) => url.searchParams.get("offset"))).toEqual([
      "0",
      "1",
      "0",
      "1",
    ]);
    expect(requests[2]?.searchParams.get("updatedFrom")).toBe("2026-07-12");
  });

  it("normalizes ordered case messages, actors, visibility, attachments, and marker exclusion", async () => {
    const client = clientFor((url) => {
      if (url.pathname === "/api/ticket") {
        return jsonResponse({
          IssueID: 7,
          Status: "Open",
          Subject: "Cannot save",
          Body: "<p>Save fails.</p>",
          IssueDate: "2026-07-13T10:00:00Z",
          UserID: 1,
          UserName: "Requester",
          TechID: 2,
          TechName: "Agent",
          Attachments: [{ FileID: 10, FileName: "screen.png", Size: 12 }],
        });
      }
      return jsonResponse([
        {
          CommentID: 3,
          CommentDate: "2026-07-13T12:00:00Z",
          UserID: 2,
          UserName: "Agent",
          ForTechsOnly: true,
          Body: "Later internal note",
          Attachments: [{ FileID: 11, FileName: "trace.log" }],
        },
        {
          CommentID: 2,
          CommentDate: "2026-07-13T11:00:00Z",
          UserID: 1,
          UserName: "Requester",
          Body: "Earlier public reply",
        },
        {
          CommentID: 4,
          IsSystem: true,
          Body: "System transition",
        },
        {
          CommentID: 5,
          Body: "Published <!-- caseweaver-publication:analysis-1 -->",
        },
      ]);
    });
    const source = new JitbitCaseSource({
      client,
      configuration: createJitbitConfiguration(),
    });

    const loaded = await source.loadCase({
      reference: {
        connectorInstanceId: "jitbit-helpdesk",
        resourceType: "case",
        externalId: "7",
      },
      signal: new AbortController().signal,
    });

    expect(loaded.actors).toMatchObject({
      requester: { externalId: "1", displayName: "Requester" },
      assignee: { externalId: "2", displayName: "Agent" },
    });
    expect(loaded.messages).toMatchObject([
      { externalId: "ticket:7", sequence: 0, visibility: "public" },
      { externalId: "2", sequence: 1, visibility: "public" },
      { externalId: "3", sequence: 2, visibility: "internal" },
    ]);
    expect(
      loaded.attachments.map((attachment) => attachment.reference.externalId),
    ).toEqual(["7:10", "7:11"]);
  });

  it("loads resolved knowledge with distinct problem, investigation, and resolution sections", async () => {
    const client = clientFor((url) =>
      url.pathname === "/api/ticket"
        ? jsonResponse({
            IssueID: 7,
            Status: "Resolved",
            Subject: "Cannot save",
            Body: "<p>Save fails.</p>",
            ResolutionText: "<p>Renew the configuration.</p>",
          })
        : jsonResponse([
            {
              CommentID: 2,
              CommentDate: "2026-07-13T11:00:00Z",
              Body: "Reproduced.",
            },
            {
              CommentID: 3,
              Body: "Ignore <!-- caseweaver-publication:analysis-1 -->",
            },
          ]),
    );
    const source = new JitbitKnowledgeSource({
      client,
      configuration: createJitbitConfiguration(),
    });

    await expect(
      source.load({
        reference: {
          connectorInstanceId: "jitbit-helpdesk",
          resourceType: "resolved-case",
          externalId: "7",
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      body: {
        format: "markdown",
        normalizedText:
          "## Problem\nSave fails.\n\n## Investigation\nReproduced.\n\n## Resolution\nRenew the configuration.",
      },
    });

    const activeSource = new JitbitKnowledgeSource({
      client: clientFor((url) =>
        url.pathname === "/api/ticket"
          ? jsonResponse({ IssueID: 8, Status: "Open" })
          : jsonResponse([]),
      ),
      configuration: createJitbitConfiguration(),
    });
    await expect(
      activeSource.load({
        reference: {
          connectorInstanceId: "jitbit-helpdesk",
          resourceType: "resolved-case",
          externalId: "8",
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ConnectorProtocolError);
  });

  it("discovers only live cases through the case capability", async () => {
    const source = new JitbitCaseSource({
      client: clientFor(() =>
        jsonResponse([
          { IssueID: 7, Status: "Resolved" },
          { IssueID: 8, Status: "Open" },
        ]),
      ),
      configuration: createJitbitConfiguration(),
    });
    const pages = await collect<DiscoveredCase>(
      source.discoverCases({
        pageSize: 3,
        signal: new AbortController().signal,
      }),
    );

    expect(pages[0]).toMatchObject({
      mode: "delta",
      events: [
        {
          kind: "upsert",
          item: {
            reference: { resourceType: "case", externalId: "8" },
          },
        },
      ],
    });
  });
});
