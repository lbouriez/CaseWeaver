import { describe, expect, it } from "vitest";

import {
  attachmentOccurrenceIdentity,
  normalizedCaseRevision,
} from "./hash.js";
import type { AttachmentSource } from "./ports.js";
import {
  attachmentOccurrenceSchema,
  knowledgeDocumentSchema,
  normalizedCaseSchema,
} from "./schemas.js";

const caseReference = {
  connectorInstanceId: "helpdesk",
  resourceType: "case",
  externalId: "case-42",
};
const attachmentReference = {
  connectorInstanceId: "helpdesk",
  resourceType: "attachment",
  externalId: "attachment-3",
};

function caseOccurrence(overrides: Record<string, unknown> = {}) {
  return {
    owner: { kind: "case" as const, case: caseReference },
    ordinal: 0,
    relation: "declaredAttachment" as const,
    reference: attachmentReference,
    locator: { version: "jitbit-attachment.v1", value: "QXR0YWNobWVudC0z" },
    declared: {
      fileName: "capture.png",
      mediaType: "image/png",
      contentLength: 42,
      contentHash: "a".repeat(64),
    },
    ...overrides,
  };
}

describe("attachment occurrence schemas", () => {
  it("permits a bounded server-private sealed locator without exposing it in identity", () => {
    const locator = "a".repeat(16_384);
    const parsed = attachmentOccurrenceSchema.parse(
      caseOccurrence({ locator: { version: "sealed.v1", value: locator } }),
    );

    expect(parsed.locator.value).toHaveLength(16_384);
    expect(JSON.stringify(attachmentOccurrenceIdentity(parsed))).not.toContain(
      locator,
    );
    expect(
      attachmentOccurrenceSchema.safeParse(
        caseOccurrence({
          locator: { version: "sealed.v1", value: `${locator}a` },
        }),
      ).success,
    ).toBe(false);
  });

  it("retains a stable canonical identity without exposing the reopen locator", () => {
    const original = attachmentOccurrenceSchema.parse(caseOccurrence());
    const rotatedLocator = attachmentOccurrenceSchema.parse(
      caseOccurrence({
        locator: {
          version: "jitbit-attachment.v2",
          value: "cm90YXRlZC1hdHRhY2htZW50LTM",
        },
      }),
    );
    const changedContent = attachmentOccurrenceSchema.parse(
      caseOccurrence({
        declared: {
          fileName: "capture.png",
          mediaType: "image/png",
          contentLength: 43,
          contentHash: "b".repeat(64),
        },
      }),
    );

    expect(attachmentOccurrenceIdentity(rotatedLocator)).toBe(
      attachmentOccurrenceIdentity(original),
    );
    expect(attachmentOccurrenceIdentity(changedContent)).not.toBe(
      attachmentOccurrenceIdentity(original),
    );
    expect(
      JSON.stringify(attachmentOccurrenceIdentity(original)),
    ).not.toContain(original.locator.value);
  });

  it("normalizes safe declared metadata before deriving occurrence identity", () => {
    const sourceDeclared = attachmentOccurrenceSchema.parse(
      caseOccurrence({
        declared: {
          fileName: "capture.png",
          mediaType: "IMAGE/PNG",
          contentLength: 42,
          contentHash: "A".repeat(64),
        },
      }),
    );
    const normalizedDeclared = attachmentOccurrenceSchema.parse(
      caseOccurrence(),
    );

    expect(sourceDeclared.declared).toMatchObject({
      mediaType: "image/png",
      contentHash: "a".repeat(64),
    });
    expect(attachmentOccurrenceIdentity(sourceDeclared)).toBe(
      attachmentOccurrenceIdentity(normalizedDeclared),
    );
  });

  it("rejects URLs and host paths from server-private locators and declared metadata", () => {
    for (const locator of [
      "https://helpdesk.example.invalid/attachments/3",
      "C:\\CaseWeaver\\attachment-3",
      "/var/lib/caseweaver/attachment-3",
    ]) {
      expect(
        attachmentOccurrenceSchema.safeParse(
          caseOccurrence({
            locator: { version: "test.v1", value: locator },
          }),
        ).success,
      ).toBe(false);
    }

    expect(
      attachmentOccurrenceSchema.safeParse(
        caseOccurrence({
          declared: { fileName: "../../secrets.txt" },
        }),
      ).success,
    ).toBe(false);
    expect(
      attachmentOccurrenceSchema.safeParse(
        caseOccurrence({
          declared: { mediaType: "https://example.invalid/image" },
        }),
      ).success,
    ).toBe(false);
  });

  it("requires occurrences to remain with their actual case, message, or document owner", () => {
    const validCase = normalizedCaseSchema.parse({
      reference: caseReference,
      messages: [
        {
          externalId: "message-1",
          sequence: 0,
          visibility: "public",
          body: { format: "html", normalizedText: "See the screenshot." },
          attachments: [],
          attachmentOccurrences: [
            {
              ...caseOccurrence({
                owner: {
                  kind: "caseMessage",
                  case: caseReference,
                  messageExternalId: "message-1",
                },
                relation: "inlineImage",
                ordinal: 0,
              }),
            },
          ],
        },
      ],
      attachments: [],
      attachmentOccurrences: [caseOccurrence()],
    });
    expect(validCase.attachmentOccurrences).toHaveLength(1);
    expect(validCase.messages[0]?.attachmentOccurrences).toHaveLength(1);

    expect(
      normalizedCaseSchema.safeParse({
        ...validCase,
        messages: [
          ...validCase.messages,
          {
            ...validCase.messages[0],
            sequence: 1,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      normalizedCaseSchema.safeParse({
        ...validCase,
        messages: [
          {
            ...validCase.messages[0],
            attachmentOccurrences: [
              {
                ...caseOccurrence({
                  owner: {
                    kind: "caseMessage",
                    case: caseReference,
                    messageExternalId: "message-1",
                  },
                  ordinal: 0,
                }),
              },
              {
                ...caseOccurrence({
                  owner: {
                    kind: "caseMessage",
                    case: caseReference,
                    messageExternalId: "message-1",
                  },
                  ordinal: 0,
                }),
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      normalizedCaseSchema.safeParse({
        ...validCase,
        attachmentOccurrences: [
          caseOccurrence({
            owner: {
              kind: "case",
              case: { ...caseReference, externalId: "other-case" },
            },
          }),
        ],
      }).success,
    ).toBe(false);
    expect(
      attachmentOccurrenceSchema.safeParse(
        caseOccurrence({
          reference: {
            ...attachmentReference,
            connectorInstanceId: "foreign-connector",
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      normalizedCaseSchema.safeParse({
        ...validCase,
        messages: [
          {
            ...validCase.messages[0],
            attachmentOccurrences: [
              caseOccurrence({
                owner: {
                  kind: "caseMessage",
                  case: caseReference,
                  messageExternalId: "other-message",
                },
              }),
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      normalizedCaseSchema.safeParse({
        ...validCase,
        attachmentOccurrences: [caseOccurrence(), caseOccurrence()],
      }).success,
    ).toBe(false);
    expect(
      knowledgeDocumentSchema.safeParse({
        reference: {
          connectorInstanceId: "docs",
          resourceType: "document",
          externalId: "guide.md",
        },
        body: { format: "markdown", normalizedText: "# Guide" },
        attachments: [],
        attachmentOccurrences: [caseOccurrence()],
      }).success,
    ).toBe(false);
    expect(
      knowledgeDocumentSchema.parse({
        reference: {
          connectorInstanceId: "docs",
          resourceType: "document",
          externalId: "guide.md",
        },
        body: { format: "markdown", normalizedText: "# Guide" },
        attachments: [],
        attachmentOccurrences: [
          {
            owner: {
              kind: "knowledgeDocument",
              document: {
                connectorInstanceId: "docs",
                resourceType: "document",
                externalId: "guide.md",
              },
            },
            ordinal: 0,
            relation: "inlineImage",
            reference: {
              connectorInstanceId: "docs",
              resourceType: "attachment",
              externalId: "image-1",
            },
            locator: { version: "markdown-image.v1", value: "aW1hZ2UtMQ" },
          },
        ],
      }).attachmentOccurrences,
    ).toHaveLength(1);
    expect(
      knowledgeDocumentSchema.safeParse({
        reference: {
          connectorInstanceId: "docs",
          resourceType: "document",
          externalId: "guide.md",
        },
        body: { format: "markdown", normalizedText: "# Guide" },
        attachments: [],
        attachmentOccurrences: [
          {
            owner: {
              kind: "knowledgeDocument",
              document: {
                connectorInstanceId: "docs",
                resourceType: "document",
                externalId: "guide.md",
              },
            },
            ordinal: 0,
            relation: "inlineImage",
            reference: {
              connectorInstanceId: "docs",
              resourceType: "attachment",
              externalId: "image-1",
            },
            locator: { version: "markdown-image.v1", value: "aW1hZ2UtMQ" },
          },
          {
            owner: {
              kind: "knowledgeDocument",
              document: {
                connectorInstanceId: "docs",
                resourceType: "document",
                externalId: "guide.md",
              },
            },
            ordinal: 0,
            relation: "inlineFile",
            reference: {
              connectorInstanceId: "docs",
              resourceType: "attachment",
              externalId: "file-1",
            },
            locator: { version: "markdown-file.v1", value: "ZmlsZS0x" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps legacy attachment sources compatible when no occurrence identity exists", async () => {
    let observedIdentity: unknown;
    const source = {
      async openAttachment(request) {
        observedIdentity = request.identity;
        return {
          content: (async function* () {
            yield new Uint8Array([1, 2, 3]);
          })(),
        };
      },
    } satisfies AttachmentSource;

    const opened = await source.openAttachment({
      reference: attachmentReference,
      signal: AbortSignal.abort(),
    });

    expect(observedIdentity).toBeUndefined();
    await expect(Array.fromAsync(opened.content)).resolves.toEqual([
      new Uint8Array([1, 2, 3]),
    ]);
  });

  it("includes occurrence state but not an opaque locator in the normalized case revision", () => {
    const original = normalizedCaseSchema.parse({
      reference: caseReference,
      messages: [],
      attachments: [],
      attachmentOccurrences: [caseOccurrence()],
    });
    const rotatedLocator = normalizedCaseSchema.parse({
      ...original,
      attachmentOccurrences: [
        caseOccurrence({
          locator: { version: "test.v2", value: "bmV3LWxvY2F0b3I" },
        }),
      ],
    });
    const changedRelationship = normalizedCaseSchema.parse({
      ...original,
      attachmentOccurrences: [caseOccurrence({ relation: "inlineFile" })],
    });

    expect(normalizedCaseRevision(rotatedLocator)).toBe(
      normalizedCaseRevision(original),
    );
    expect(normalizedCaseRevision(changedRelationship)).not.toBe(
      normalizedCaseRevision(original),
    );
  });
});
