# Git/Markdown connector

**PBI:** 005

Knowledge source for local/remote Git repositories, Markdown and Docusaurus
conventions, blob-OID fingerprints, secret-reference authentication, path filters, and
stable source URLs.

The package exports safe administration discovery metadata for API composition. Runtime
validation remains in this package's configuration schema; descriptors never contain
configured secret values, clients, filesystem state, or repository runtime state.

`GitMarkdownKnowledgeSource` accepts an injected `GitRepository`; it does not invoke a
shell, Git executable, filesystem, or network client. The injected boundary must safely
resolve configured local/remote repositories and return validated tree and blob data.
Local repository paths must be contained by an `allowedLocalRoots` entry in the trusted
connector configuration. Both the repository and root are resolved to canonical existing
filesystem paths before containment is checked.

The connector discovers Markdown files as snapshots using Git blob OIDs and uses an
optional injected Git diff capability for added, changed, moved, and removed files. It
parses Docusaurus front matter and headings, derives a source URL at a commit, and
returns generic external revision, provenance, and heading-anchor metadata from
`KnowledgeSource.load`. Discovery carries a Git-commit load token, so loading reads that
exact commit rather than a mutable branch or tag. Chunking and embedding remain in
`packages/knowledge`.
