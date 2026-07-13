import { describe, expect, it } from "vitest";

import { createJitbitShapedCaseFixture } from "./fakes.js";
import {
  assertIdempotencyRequest,
  canonicalJson,
  normalizedCaseRevision,
  normalizedCaseRevisionInput,
  sha256CanonicalJson,
} from "./hash.js";

describe("case revision hashing", () => {
  it("sorts object keys but retains array order", () => {
    expect(canonicalJson({ z: 1, a: [{ b: 2, a: 1 }, "second"] })).toBe(
      '{"a":[{"a":1,"b":2},"second"],"z":1}',
    );
    expect(sha256CanonicalJson({ b: 2, a: 1 })).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
  });

  it("is stable for equivalent neutral snapshots and excludes original bodies", () => {
    const original = createJitbitShapedCaseFixture();
    const equivalent = structuredClone(original);
    const firstMessage = equivalent.messages[0];
    if (firstMessage === undefined) {
      throw new Error("Fixture must contain an initial message.");
    }
    firstMessage.body.original = "<div>different source markup</div>";

    expect(normalizedCaseRevision(equivalent)).toBe(
      normalizedCaseRevision(original),
    );
  });

  it("changes for message ordering, visibility, and external revision", () => {
    const original = createJitbitShapedCaseFixture();
    const changedVisibility = structuredClone(original);
    const secondMessage = changedVisibility.messages[1];
    if (secondMessage === undefined) {
      throw new Error("Fixture must contain an internal message.");
    }
    secondMessage.visibility = "public";
    const changedRevision = structuredClone(original);
    changedRevision.externalRevision = {
      version: "api-revision.v1",
      value: "109",
    };

    expect(normalizedCaseRevision(changedVisibility)).not.toBe(
      normalizedCaseRevision(original),
    );
    expect(normalizedCaseRevision(changedRevision)).not.toBe(
      normalizedCaseRevision(original),
    );
    expect(normalizedCaseRevisionInput(original)).not.toEqual(
      normalizedCaseRevisionInput({
        ...original,
        messages: [...original.messages].reverse(),
      }),
    );
  });

  it("rejects an idempotency-key reuse with a different request hash", () => {
    expect(() =>
      assertIdempotencyRequest(
        "publication",
        {
          key: "publish-1",
          requestHash: sha256CanonicalJson({ body: "first" }),
        },
        {
          key: "publish-1",
          requestHash: sha256CanonicalJson({ body: "second" }),
        },
      ),
    ).toThrow("already used for a different request");
  });
});
