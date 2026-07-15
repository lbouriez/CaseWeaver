import { describe, expect, it } from "vitest";

import { policyForAction, policyForResource } from "./resource-policy.js";

describe("administration resource policy", () => {
  it("assigns permissions and server-owned action codes without vendor branches", () => {
    expect(policyForResource("audit-events")).toMatchObject({
      permission: "audit.read",
      sensitiveRead: true,
      readAction: "admin.auditEvent.list",
    });
    expect(policyForAction("provider.test")).toEqual({
      permission: "configuration.manage",
      actionCode: "admin.provider.test",
      target: "ai-provider-instances",
    });
  });
});
