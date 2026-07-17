import { describe, expect, it } from "vitest";

import { discoverMarkdownAttachmentCandidates } from "./markdown-attachments.js";

describe("Markdown attachment discovery", () => {
  it("finds ordered repository files and public HTTPS images outside fenced code", () => {
    const candidates = discoverMarkdownAttachmentCandidates({
      documentPath: "docs/guides/install.md",
      markdown: `# Install

![Screen](../assets/install.png)
[Run log](logs/first-run.log)
<img src="https://images.example.test/product.png?width=800#caption" />

\`\`\`md
![Do not fetch](../../private.png)
[Do not fetch](archive.zip)
\`\`\`

[Duplicate image](../assets/install.png)
`,
    });

    expect(candidates).toEqual([
      {
        kind: "repositoryFile",
        relation: "inlineImage",
        path: "docs/assets/install.png",
      },
      {
        kind: "repositoryFile",
        relation: "inlineFile",
        path: "docs/guides/logs/first-run.log",
      },
      {
        kind: "publicHttpsImage",
        relation: "inlineImage",
        url: "https://images.example.test/product.png?width=800",
      },
      {
        kind: "repositoryFile",
        relation: "inlineImage",
        path: "docs/assets/install.png",
      },
    ]);
  });

  it("rejects traversal, absolute paths, non-HTTPS URLs, credentials, and unsupported links", () => {
    const candidates = discoverMarkdownAttachmentCandidates({
      documentPath: "docs/guides/install.md",
      markdown: `
![Traversal](../../../private.png)
![Absolute](/etc/passwd)
![Backslash](..\\private.png)
![Data](data:image/png;base64,AAAA)
![Script](javascript:alert(1))
![Credential](https://token:secret@images.example.test/private.png)
[Remote file](https://files.example.test/notes.txt)
[Unsupported](reference.pdf)
[Allowed](reference.yaml)
`,
    });

    expect(candidates).toEqual([
      {
        kind: "repositoryFile",
        relation: "inlineFile",
        path: "docs/guides/reference.yaml",
      },
    ]);
  });
});
