import { describe, expect, it } from "vitest";

import { descriptorLifecycleTransition } from "./configuration-lifecycle-action.js";

describe("descriptorLifecycleTransition", () => {
  it("turns only an inert draft into a terminal discard", () => {
    expect(
      descriptorLifecycleTransition("configuration.disable", "draft"),
    ).toEqual({ lifecycle: "discarded", discardDraft: true });
    expect(
      descriptorLifecycleTransition("configuration.disable", "active"),
    ).toEqual({ lifecycle: "disabled", discardDraft: false });
  });

  it("refuses to reactivate a discarded immutable configuration", () => {
    expect(
      descriptorLifecycleTransition("configuration.activate", "discarded"),
    ).toBeUndefined();
  });
});
