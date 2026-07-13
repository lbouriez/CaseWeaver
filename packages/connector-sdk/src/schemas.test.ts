import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createJitbitShapedCaseFixture } from "./fakes.js";
import { normalizedCaseRevision } from "./hash.js";
import {
  createNormalizedCaseSchema,
  discoveredKnowledgeItemSchema,
  knowledgeDocumentSchema,
  normalizedCaseSchema,
} from "./schemas.js";

describe("normalized case schema", () => {
  it("preserves public, internal, and system messages in sequence", () => {
    const caseSnapshot = createJitbitShapedCaseFixture();

    expect(caseSnapshot.messages.map((message) => message.visibility)).toEqual([
      "public",
      "internal",
      "system",
    ]);
    expect(
      normalizedCaseSchema.safeParse({
        ...caseSnapshot,
        messages: [...caseSnapshot.messages].reverse(),
      }).success,
    ).toBe(false);
  });

  it("requires a connector-owned metadata schema and excludes it from revisions", () => {
    const schema = createNormalizedCaseSchema(
      z.object({ transportCorrelation: z.string() }).strict(),
    );
    const caseSnapshot = schema.parse({
      ...createJitbitShapedCaseFixture(),
      connectorMetadata: { transportCorrelation: "first-observation" },
    });
    const differentMetadata = schema.parse({
      ...caseSnapshot,
      connectorMetadata: { transportCorrelation: "second-observation" },
    });

    expect(normalizedCaseRevision(differentMetadata)).toBe(
      normalizedCaseRevision(caseSnapshot),
    );
  });

  it("carries opaque load pins and source-neutral provenance for knowledge", () => {
    const reference = {
      connectorInstanceId: "docs",
      resourceType: "document",
      externalId: "guides/install.md",
    };
    const externalRevision = { version: "revision.v1", value: "commit-1" };

    expect(
      discoveredKnowledgeItemSchema.parse({
        reference,
        fingerprint: { version: "fingerprint.v1", value: "blob-1" },
        externalRevision,
        loadToken: { version: "load.v1", value: "pin-1" },
      }),
    ).toMatchObject({ externalRevision, loadToken: { value: "pin-1" } });
    expect(
      knowledgeDocumentSchema.parse({
        reference,
        externalRevision,
        body: { format: "markdown", normalizedText: "# Install" },
        attachments: [],
        provenance: {
          sourceUrl: "https://docs.example.invalid/guides/install",
          sourceLocator: "guides/install.md",
          contentIdentity: { version: "content.v1", value: "blob-1" },
        },
        sourceAnchors: [{ anchor: "install", label: "Install", position: 1 }],
      }),
    ).toMatchObject({
      provenance: { sourceLocator: "guides/install.md" },
      sourceAnchors: [{ anchor: "install" }],
    });
  });

  it("rejects unsafe and vendor-specific knowledge provenance fields", () => {
    const document = {
      reference: {
        connectorInstanceId: "docs",
        resourceType: "document",
        externalId: "guide.md",
      },
      body: { format: "markdown" as const, normalizedText: "# Guide" },
      attachments: [],
    };

    expect(
      knowledgeDocumentSchema.safeParse({
        ...document,
        provenance: {
          sourceUrl: "https://token@example.invalid/private",
        },
      }).success,
    ).toBe(false);
    expect(
      knowledgeDocumentSchema.safeParse({
        ...document,
        provenance: { repository: "example/docs" },
      }).success,
    ).toBe(false);
  });
});
