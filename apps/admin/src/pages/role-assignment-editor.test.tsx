import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiClientProvider } from "../api/context.js";
import { RoleAssignmentEditor } from "./role-assignment-editor.js";

describe("role assignment editor", () => {
  it("uses the server-provided workspace revision when replacing code-owned roles", async () => {
    const assignment = {
      principalId: "principal-1",
      roles: ["operator" as const],
      revision: 4,
    };
    const client = {
      list: vi.fn(async () => ({
        items: [{ id: "principal-1", label: "Operator" }],
        page: { hasNextPage: false },
      })),
      workspaceRoleAssignment: vi.fn(async () => assignment),
      replaceWorkspaceRoles: vi.fn(async () => ({
        id: "principal-1",
        label: "Roles for principal-1",
        status: "updated",
        version: "5",
        fields: { roles: "analyst, operator" },
      })),
    };
    render(
      <ApiClientProvider client={client as never}>
        <RoleAssignmentEditor />
      </ApiClientProvider>,
    );

    await screen.findByText("Current workspace role revision: 4");
    await userEvent.click(screen.getByRole("checkbox", { name: "analyst" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Replace roles" }),
    );

    await waitFor(() =>
      expect(client.replaceWorkspaceRoles).toHaveBeenCalledWith("principal-1", {
        roles: ["operator", "analyst"],
        expectedRevision: 4,
      }),
    );
    expect(JSON.stringify(client.replaceWorkspaceRoles.mock.calls)).not.toMatch(
      /secret|token|workspaceId|actor/iu,
    );
  });
});
