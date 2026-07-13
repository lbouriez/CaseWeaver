import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createJitbitShapedCaseFixture } from "./fakes.js";
import { normalizedCaseRevision } from "./hash.js";
import { createNormalizedCaseSchema, normalizedCaseSchema } from "./schemas.js";

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
});
