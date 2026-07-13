# PBI-005: Git/Markdown and Docusaurus source

## Outcome

Ingest documentation from public or authenticated Git repositories.

## Scope

- Local and remote Git repository configuration.
- Branch, tag, and path filters.
- PAT/secret-reference authentication.
- Markdown discovery, parsing, heading-aware chunking, and source anchors.
- Docusaurus front matter and documentation URL mapping.
- Commit SHA and relative path provenance.
- Incremental synchronization through Git diff and blob OIDs where possible, with
  persisted content-hash fallback.

## Acceptance criteria

- Added, changed, moved, and removed Markdown files synchronize correctly.
- An unchanged Git blob is not loaded, normalized, chunked, or embedded.
- Code blocks and headings are not split incorrectly by default chunking.
- Each retrieval chunk links to repository, commit, path, and heading.
- Credentials never appear in stored URLs or logs.
- A full rescan produces the same active content as incremental synchronization.

## Excluded

Non-Markdown Docusaurus assets and website crawling.
