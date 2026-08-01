---
sidebar_position: 5
title: Git / Markdown knowledge source
---

# Git / Markdown knowledge source

**Availability:** Git / Markdown is a knowledge and attachment source. It is not a
case source or an analysis-publication destination.

## Remote HTTPS repository

In **Integrations**, choose **Git / Markdown**. A remote clone location is distinct from
the optional browser URL that makes provenance links convenient for people.

```json
{
  "repository": { "kind": "remote", "url": "https://github.com/example/support-docs.git" },
  "allowedLocalRoots": [],
  "ref": { "kind": "branch", "name": "main" },
  "browserUrl": "https://docs.example.test",
  "paths": { "include": ["docs/**/*.md", "docs/**/*.mdx"], "exclude": ["docs/drafts/**"] },
  "maximumMarkdownCharacters": 250000
}
```

The clone URL must be HTTPS-only and contain no username, password, query, or fragment.
For a private remote repository, select a previously registered external Git-token
reference; never put a token in the URL. A branch/tag name must be safe, while an exact
commit creates a reproducible pin. Each synchronization records the immutable commit it
actually read.

Run the descriptor's bounded **Test** action, review its server-generated preview, then
activate the connector. Create or select a workspace collection, create an enabled
knowledge source and schedule, then use **Synchronize**. Selected Markdown/MDX becomes
indexed with repository, commit, relative path, and heading provenance. Unchanged blobs
avoid repeat processing.

## Read-only local worktree for local evaluation

The accepted local overlay is deliberately separate from the base stack. The source
directory must be a complete Git worktree containing `.git`; it is mounted read-only
only into the standalone backend. It never reaches Admin.

```powershell
$env:CASEWEAVER_DOCUMENTATION_REPOSITORY = "<absolute path to a Git worktree>"
docker compose -f deploy\docker\compose.local.yml -f deploy\docker\compose.local.documentation.yml up --build --wait
```

Configure the runtime paths, not a browser-computer path:

```json
{
  "repository": { "kind": "local", "path": "/mnt/caseweaver/repositories/documentation" },
  "allowedLocalRoots": ["/mnt/caseweaver/repositories"],
  "ref": { "kind": "branch", "name": "main" }
}
```

Both paths must exist, resolve canonically, and remain inside the allowed root after
symlink resolution. A local repository cannot use a Git-token reference. This is an
accepted **local evaluation** overlay only. A production repository mount needs a
reviewed deployment override for the selected runtime mode; do not copy this example
into production Compose.

## Docusaurus mapping and recovery

Enable Docusaurus settings only for a Docusaurus repository. `siteUrl` is the public
HTTPS origin, `baseUrl` is its leading/trailing-slash path prefix, `routeBasePath` is
the relative documentation route, and `docsPath` is the relative repository directory.
None is a Git clone URL.

If test fails, correct the HTTPS URL, registered reference, safe ref/path filter, or
reviewed deployment mount, then rerun the bounded test. Do not broaden local roots,
disable path checks, or put credentials in a configuration field.
