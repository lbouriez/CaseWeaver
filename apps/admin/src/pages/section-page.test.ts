import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AdminListItem, ConfigurationSurface } from "../api/contracts.js";
import { ApiClientProvider } from "../api/context.js";
import { ResourcePanel, itemActions } from "./section-page.js";

vi.mock("react-admin", () => ({
  useGetList: vi.fn(() => ({
    data: [],
    error: undefined,
    isLoading: false,
    refetch: vi.fn(),
  })),
}));

const item = (status: string): AdminListItem => ({
  id: "item-1",
  label: "Item",
  status,
});

function surface(
  input: Partial<ConfigurationSurface> &
    Pick<ConfigurationSurface, "surface" | "mode">,
): ConfigurationSurface {
  return {
    workflows: [],
    operationalActions: [],
    ...(input.mode === "managed"
      ? {}
      : {
          reasonCode: "workflow_not_composed",
          reason: "Feature workflow is not composed.",
        }),
    ...input,
  };
}

describe("configuration surface actions", () => {
  it("renders source synchronization only as an explicitly advertised operational action", () => {
    expect(
      itemActions(
        "knowledge-sources",
        item("enabled"),
        surface({
          surface: "knowledge-sources",
          mode: "read_only",
          operationalActions: ["source.synchronize", "source.fullRescan"],
        }),
      ).map((action) => action.action),
    ).toEqual(["source.synchronize", "source.fullRescan"]);
    expect(
      itemActions(
        "knowledge-sources",
        item("enabled"),
        surface({ surface: "knowledge-sources", mode: "unavailable" }),
      ),
    ).toEqual([]);
  });

  it("fails closed for connector/provider forms and lifecycle actions unless managed", () => {
    expect(itemActions("connector-instances", item("active"))).toEqual([]);
    expect(
      itemActions(
        "connector-instances",
        item("active"),
        surface({
          surface: "connector-instances",
          mode: "read_only",
        }),
      ),
    ).toEqual([]);
    expect(
      itemActions(
        "connector-instances",
        item("active"),
        surface({
          surface: "connector-instances",
          mode: "managed",
          workflows: ["disable", "inspect_history"],
        }),
      ).map((action) => action.action),
    ).toEqual(["connector.disable"]);
    expect(
      itemActions("connector-instances", item("active"), {
        surface: "connector-instances",
        mode: "malformed" as never,
        workflows: ["disable"],
        operationalActions: [],
      }),
    ).toEqual([]);
  });

  it("allows publication approval only when the surface advertises the existing guarded use case", () => {
    expect(
      itemActions(
        "publications",
        item("awaitingApproval"),
        surface({
          surface: "publications",
          mode: "read_only",
          operationalActions: ["publication.approve"],
        }),
      ).map((action) => action.action),
    ).toEqual(["publication.approve"]);
    expect(
      itemActions(
        "publications",
        item("awaitingApproval"),
        surface({ surface: "publications", mode: "read_only" }),
      ),
    ).toEqual([]);
  });

  it("renders the server-provided safe read-only reason without a configuration action", () => {
    const providerProperties = {
      client: {} as never,
    } as unknown as Parameters<typeof ApiClientProvider>[0];
    render(
      createElement(
        ApiClientProvider,
        providerProperties,
        createElement(ResourcePanel, {
          resource: "schedules",
          title: "Schedules",
          description: "Due work.",
          configurationSurface: surface({
            surface: "schedules",
            mode: "read_only",
            reason: "Schedule authoring is not available.",
          }),
        }),
      ),
    );

    expect(
      screen.getByText("Schedule authoring is not available."),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: /create|activate|disable/i }),
    ).toBeNull();
  });
});
