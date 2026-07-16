import { describe, expect, it } from "vitest";

import { gitMarkdownAdministrationDescriptor } from "./administration-descriptor.js";

describe("Git/Markdown administration descriptor", () => {
  it("publishes a new immutable revision with operator-facing Git guidance", () => {
    const fields =
      gitMarkdownAdministrationDescriptor.settingsSchema.properties;

    expect(gitMarkdownAdministrationDescriptor.version).toBe("2");
    expect(fields.ref?.description).toContain("branch or tag to pin");
    expect(fields.ref?.description).not.toContain("JSON");
    expect(fields.paths?.description).toContain("which repository files");
    expect(fields.docusaurus?.description).toContain("Docusaurus site");
  });
});
