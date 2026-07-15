import { describe, expect, it } from "vitest";
import {
  canonicalizeConfiguration,
  ConfigurationConflictError,
  requireExpectedRevision,
  resolveIdempotency,
} from "./configuration.js";

describe("administration configuration policy", () => {
  it("canonicalizes JSON settings before idempotency/audit hashing", () => {
    expect(
      canonicalizeConfiguration({ b: [true, null], a: { z: 2, y: 1 } }),
    ).toBe('{"a":{"y":1,"z":2},"b":[true,null]}');
  });

  it("distinguishes an idempotent replay from key reuse with another request", () => {
    expect(
      resolveIdempotency(
        { requestDigest: "same", resourceId: "resource" },
        {
          operation: "connector.activate",
          keyDigest: "key",
          requestDigest: "same",
        },
      ),
    ).toEqual({ kind: "replay", resourceId: "resource" });
    expect(
      resolveIdempotency(
        { requestDigest: "original", resourceId: "resource" },
        {
          operation: "connector.activate",
          keyDigest: "key",
          requestDigest: "different",
        },
      ),
    ).toEqual({ kind: "conflict" });
  });

  it("requires the client revision before a mutable draft transition", () => {
    const configuration = {
      id: "cfg",
      workspaceId: "workspace",
      resourceType: "connector-instance",
      revision: 2,
      lifecycle: "draft" as const,
    };
    expect(() => requireExpectedRevision(configuration, 1)).toThrow(
      ConfigurationConflictError,
    );
    expect(() => requireExpectedRevision(configuration, 2)).not.toThrow();
  });
});
