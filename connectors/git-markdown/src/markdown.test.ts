import { describe, expect, it } from "vitest";

import {
  docusaurusDocumentUrl,
  gitBlobSourceUrl,
  parseMarkdownDocument,
} from "./markdown.js";

describe("Markdown and Docusaurus parsing", () => {
  it("strips front matter and finds headings without treating fenced code as headings", () => {
    const parsed = parseMarkdownDocument(`---
title: Installation
draft: true
tags: [setup, "first run"]
---
# Install

## Requirements

\`\`\`md
## This is code, not a heading
\`\`\`

## Requirements
`);

    expect(parsed.markdown).toBe(`# Install

## Requirements

\`\`\`md
## This is code, not a heading
\`\`\`

## Requirements
`);
    expect(parsed.title).toBe("Installation");
    expect(parsed.draft).toBe(true);
    expect(parsed.frontMatter.tags).toEqual(["setup", "first run"]);
    expect(parsed.headings).toEqual([
      { level: 1, text: "Install", anchor: "install", line: 1 },
      {
        level: 2,
        text: "Requirements",
        anchor: "requirements",
        line: 3,
      },
      {
        level: 2,
        text: "Requirements",
        anchor: "requirements-1",
        line: 9,
      },
    ]);
  });

  it("maps Docusaurus slugs and Git blobs to stable pinned URLs", () => {
    const parsed = parseMarkdownDocument(`---
slug: setup
---
# Setup
`);
    const settings = {
      enabled: true,
      siteUrl: "https://docs.example.invalid",
      baseUrl: "/product/",
      routeBasePath: "docs",
      docsPath: "docs",
    };

    expect(
      docusaurusDocumentUrl({
        path: "docs/guides/install.md",
        parsed,
        settings,
      }),
    ).toBe("https://docs.example.invalid/product/docs/guides/setup");
    expect(
      gitBlobSourceUrl({
        repository: {
          kind: "remote",
          url: "https://github.example.invalid/acme/docs.git",
        },
        commitSha: "a".repeat(40),
        path: "docs/guides/install.md",
      }),
    ).toBe(
      `https://github.example.invalid/acme/docs/blob/${"a".repeat(40)}/docs/guides/install.md`,
    );
  });
});
