import { describe, expect, it } from "vitest";

import { gitMarkdownAdministrationDescriptor } from "./administration-descriptor.js";

describe("Git/Markdown administration descriptor", () => {
  it("publishes a new immutable revision with operator-facing Git guidance", () => {
    const fields =
      gitMarkdownAdministrationDescriptor.settingsSchema.properties;

    expect(gitMarkdownAdministrationDescriptor.version).toBe("3");
    expect(fields.ref?.description).toContain("branch or tag");
    expect(fields.ref?.examples).toContain(
      '{"kind":"commit","sha":"0123456789abcdef0123456789abcdef01234567"}',
    );
    expect(fields.ref?.description).not.toContain("JSON");
    expect(fields.paths?.description).toContain("which repository files");
    expect(fields.docusaurus?.description).toContain("Docusaurus site");
    expect(gitMarkdownAdministrationDescriptor.connectorCapabilities).toEqual([
      "knowledgeSource",
      "attachmentSource",
    ]);
  });
});
