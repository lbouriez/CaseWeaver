import { principalId, workspaceId } from "@caseweaver/domain";
import { describe, expect, it } from "vitest";

import {
  can,
  requirePermission,
  type WorkspaceRoleAssignment,
} from "./index.js";

const assignments: readonly WorkspaceRoleAssignment[] = [
  {
    workspaceId: workspaceId("workspace-a"),
    principalId: principalId("operator-a"),
    role: "operator",
  },
  {
    workspaceId: workspaceId("workspace-b"),
    principalId: principalId("viewer-b"),
    role: "viewer",
  },
];

describe("workspace authorization", () => {
  it("enforces the role permission matrix", () => {
    expect(
      can(
        assignments,
        workspaceId("workspace-a"),
        principalId("operator-a"),
        "analysis.forceRerun",
      ).allowed,
    ).toBe(true);
    expect(
      can(
        assignments,
        workspaceId("workspace-b"),
        principalId("viewer-b"),
        "analysis.request",
      ).allowed,
    ).toBe(false);
  });

  it("does not allow a role from another workspace", () => {
    expect(() =>
      requirePermission(
        assignments,
        workspaceId("workspace-b"),
        principalId("operator-a"),
        "analysis.cancel",
      ),
    ).toThrow("not authorized");
  });
});
