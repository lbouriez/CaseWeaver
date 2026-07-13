import { describe, expect, it } from "vitest";

import { ConnectorCapabilityRegistry } from "./capabilities.js";
import { createCapabilityLimitedFixture } from "./fakes.js";

describe("ConnectorCapabilityRegistry", () => {
  it("preserves absent capabilities rather than inventing implementations", () => {
    const registry = new ConnectorCapabilityRegistry();
    const fixture = createCapabilityLimitedFixture();

    registry.register(fixture);

    expect(registry.hasCapability(fixture.instanceId, "caseSource")).toBe(
      false,
    );
    expect(
      registry.getCapability(fixture.instanceId, "analysisDestination"),
    ).toBeUndefined();
  });
});
