# CaseWeaver documentation site

This is a standalone Docusaurus site. It has no CaseWeaver runtime dependency, does not
connect to an API or database, and accepts no browser or deployment secret.

## Local authoring

From the repository root:

```powershell
pnpm --dir website install
pnpm --dir website start
```

Before proposing a documentation change, run:

```powershell
pnpm --dir website typecheck
pnpm --dir website test
pnpm --dir website build
```

## Reviewed translations

English and French are published locales. French pages live under
`website/i18n/fr/docusaurus-plugin-content-docs/current/`; they are authored and
reviewed as documentation, not generated in a browser or fetched at site runtime.

CaseWeaver intentionally does not copy Rekindle's direct-provider translation script:
it reads a local API key and calls a vendor directly, which is incompatible with this
repository's AI-execution and secret-handling boundaries. Until an approved, metered
translation binding exists, update translations through documented review. A repository
owner may authorize AI validation for a specific delivery; record that approval in the
delivery item before updating the manifest.

After changing an English page, check whether each reviewed translation is still tied to
the exact English revision:

```powershell
pnpm --dir website translations:status
```

When a reviewer has approved the corresponding locale pages, or a repository owner has
explicitly authorized AI validation for that delivery, record their English source
hashes:

```powershell
pnpm --dir website translations:manifest
```

The manifest is a review checkpoint, not an automatic translation mechanism. It never
sends documentation to an AI provider, stores API credentials, or replaces translated
content. Use `pnpm --dir website translations:plan -- --dry-run` to list English pages
that need French review. The deterministic planner protects front matter, technical code
fences, inline code, URLs/anchors, MDX/HTML tags, and admonition directives; it does not
write translation content. It accepts `--locale=fr`, `--file=<relative-doc-path>`,
`--force`, `--dry-run`, and `--verbose`. Unsupported locales fail safely. Use
`pnpm --dir website i18n:write -- --locale fr` only to refresh Docusaurus message
scaffolding, then translate those messages and review them before committing.

The locale suggestion is a CaseWeaver-owned, accessible browser convenience. It stores
only a selected locale or a dismissal under `caseweaver.docs.*` keys; it has no analytics,
identity, authentication, cookie-provider, or API call path. A privacy-restricted browser
can dismiss it or continue using the canonical locale.

## Guide map

Start with the **Operator knowledge map** when preparing an integration or a retrieval
knowledge base. It separates deployment-owned settings from Console configuration and
links to the source-verified **Operator-console reference** and **Deployment reference**.
Together with the task guides, they document the accepted local three-service evaluation
stack, password/OIDC and external-secret boundaries, connector capability matrix and
Git/Jitbit procedures, AI inventory/cost policy, collections/sources/schedules/analysis,
self-hosting, recovery, testing, troubleshooting, architecture, and current capability
status. The English pages are canonical. French counterparts are maintained alongside
them and are recorded in the manifest only after documented review; the manifest records
the exact English revision, not the identity of the reviewer or a translation provider.

The production artifact is `website/build/`. `CASEWEAVER_DOCS_SITE_URL` is optional for
local builds and must be an HTTPS origin when supplied. Cloudflare production builds set
it through a repository or protected-environment variable; it is public site metadata,
not a secret. Pull-request previews derive their own `pr-<number>.<project>.pages.dev`
origin in GitHub Actions.

## Cloudflare Pages publication

The `docs-pages.yml` GitHub workflow verifies pull requests but deploys only default
branch pushes or a deliberate manual dispatch. Before enabling a real deployment, a
repository owner must:

1. Create the Cloudflare Pages project and the GitHub environments
   `cloudflare-pages-preview` and `cloudflare-pages-production`. Keep preview
   intentionally unprotected so trusted same-repository pull requests can publish their
   preview; protect the production environment with the required reviewers or branch
   rules for your release process.
2. Add `CLOUDFLARE_API_TOKEN` to both environments with least-privilege Pages edit
   access for that project. Keep `cloudflare-pages-production` protected if you want to
   gate production deploys; keep `cloudflare-pages-preview` unprotected so previews and
   cleanup can run automatically.
3. Prefer `CASEWEAVER_DOCS_SITE_URL` as a repository variable. The production build
   embeds this public HTTPS origin into the static artifact, so it must be available
   before the protected deployment job begins. An existing repository secret with that
   name is also supported.
4. Add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_PAGES_PROJECT` as repository variables.
   The workflow uses them to decide whether publication is eligible and to create
   trusted same-repository preview URLs. Existing repository secrets with these names
   are also supported, so their values do not need to be recovered before publishing.

Protect `main` as well: production publication and production-pruning jobs require the
GitHub `github.ref_protected` signal in addition to the protected production environment.
Do not add an API token to this repository, a local `.env` file, website content, or a
GitHub Actions log. Fork pull requests never receive deployment credentials;
same-repository pull requests are trusted to use the deliberately unprotected preview
environment.
Until these variables (or existing repository secrets) and protected-environment
secrets exist, the workflow runs the same install/typecheck/test/build verification but
safely skips Cloudflare publication and cleanup. A skipped publication means metadata is
absent; a job that reaches its protected environment but lacks a token or has invalid
metadata fails closed instead.

## Content status

The current site is the portal foundation. It intentionally avoids unfinished operator
instructions. Task-oriented installation, authentication, configuration, operations,
and recovery guides are written only after their source delivery contracts are accepted.
