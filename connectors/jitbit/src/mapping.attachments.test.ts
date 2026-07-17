import { normalizedCaseSchema } from "@caseweaver/connector-sdk";
import { describe, expect, it } from "vitest";

import { mapNormalizedCase, mapResolvedKnowledgeDocument } from "./mapping.js";
import { jitbitCommentsSchema, jitbitTicketSchema } from "./schemas.js";

const connectorInstanceId = "jitbit-helpdesk";

describe("Jitbit attachment occurrence mapping", () => {
  it("preserves each declared and inline occurrence while deduplicating binary metadata", () => {
    const mapped = mapNormalizedCase({
      connectorInstanceId,
      maximumCharacters: 10_000,
      ticket: jitbitTicketSchema.parse({
        IssueID: "42",
        Body: '<img src="/File/Get/7"><img src="/File/Get/7">',
        Attachments: [
          { FileID: "7", FileName: "screen.png", ContentType: "image/png" },
        ],
      }),
      comments: jitbitCommentsSchema.parse([
        {
          CommentID: "1",
          Body: '<img src="/File/Get/8">',
          Attachments: [{ FileID: "7", FileName: "screen.png" }],
        },
        {
          CommentID: "2",
          IsSystem: true,
          Body: '<img src="/File/Get/9">',
        },
        {
          CommentID: "3",
          Body: 'ignored <!-- caseweaver-publication:analysis-1 --> <img src="/File/Get/10">',
        },
      ]),
    });

    expect(normalizedCaseSchema.parse(mapped)).toMatchObject({
      messages: [
        {
          externalId: "ticket:42",
          attachmentOccurrences: [
            {
              ordinal: 0,
              relation: "declaredAttachment",
              reference: { externalId: "42:7" },
            },
            {
              ordinal: 1,
              relation: "inlineImage",
              reference: { externalId: "42:7" },
            },
            {
              ordinal: 2,
              relation: "inlineImage",
              reference: { externalId: "42:7" },
            },
          ],
        },
        {
          externalId: "1",
          attachmentOccurrences: [
            {
              ordinal: 0,
              relation: "declaredAttachment",
              reference: { externalId: "42:7" },
            },
            {
              ordinal: 1,
              relation: "inlineImage",
              reference: { externalId: "42:8" },
            },
          ],
        },
      ],
      attachments: [{ reference: { externalId: "42:7" } }],
    });
    const locators = mapped.messages.flatMap(
      (message) => message.attachmentOccurrences ?? [],
    );
    expect(JSON.stringify(locators)).not.toContain("/File/Get/");
    expect(JSON.stringify(locators)).not.toContain("https://");
  });

  it("uses a document owner for historical knowledge and ignores non-content comments", () => {
    const document = mapResolvedKnowledgeDocument({
      connectorInstanceId,
      baseUrl: "https://helpdesk.example.invalid",
      maximumCharacters: 10_000,
      ticket: jitbitTicketSchema.parse({
        IssueID: "42",
        Body: '<img src="/File/Get/7">',
        Attachments: [{ FileID: "7", FileName: "screen.png" }],
      }),
      comments: jitbitCommentsSchema.parse([
        { CommentID: "1", Body: '<img src="/File/Get/8">' },
        { CommentID: "2", IsSystem: true, Body: '<img src="/File/Get/9">' },
        {
          CommentID: "3",
          Body: 'published <!-- caseweaver-publication:analysis-1 --> <img src="/File/Get/10">',
        },
      ]),
    });

    expect(document.attachmentOccurrences).toHaveLength(3);
    expect(document.attachmentOccurrences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          owner: {
            kind: "knowledgeDocument",
            document: {
              connectorInstanceId,
              resourceType: "resolved-case",
              externalId: "42",
            },
          },
          ordinal: 0,
          relation: "declaredAttachment",
        }),
        expect.objectContaining({ ordinal: 1, relation: "inlineImage" }),
        expect.objectContaining({ ordinal: 2, relation: "inlineImage" }),
      ]),
    );
    expect(JSON.stringify(document.attachmentOccurrences)).not.toContain(
      "42:9",
    );
    expect(JSON.stringify(document.attachmentOccurrences)).not.toContain(
      "42:10",
    );
  });
});
