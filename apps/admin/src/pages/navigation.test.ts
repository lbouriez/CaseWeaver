import { describe, expect, it } from "vitest";

import { visibleNavigation } from "./navigation.js";

describe("permission-aware navigation", () => {
  it("keeps the pulse view but hides configuration and access routes without permissions", () => {
    expect(visibleNavigation([]).map((section) => section.label)).toEqual([
      "Overview",
    ]);
  });

  it("uses server-effective permissions rather than role names", () => {
    expect(
      visibleNavigation(["configuration.read", "identity.manage"]).map(
        (section) => section.label,
      ),
    ).toEqual(["Overview", "Integrations", "AI", "Access", "Platform"]);
  });
});
