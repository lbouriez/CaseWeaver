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
   `cloudflare-pages-preview` and `cloudflare-pages-production`.
2. Add `CLOUDFLARE_API_TOKEN` to both environments with least-privilege Pages edit
   access for that project. Keep `cloudflare-pages-production` protected if you want to
   gate production deploys; keep `cloudflare-pages-preview` unprotected so previews and
   cleanup can run automatically.
3. Add `CASEWEAVER_DOCS_SITE_URL` as a repository variable. The production build embeds
   this public HTTPS origin into the static artifact, so it must be available before the
   protected deployment job begins.
4. Add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_PAGES_PROJECT` as repository variables.
   The workflow uses them to decide whether publication is eligible and to create
   trusted same-repository preview URLs.

Do not add an API token to this repository, a local `.env` file, website content, or a
GitHub Actions log. Pull requests intentionally do not receive deployment credentials.
Until these variables and protected-environment secrets exist, the workflow runs the
same install/typecheck/test/build verification but safely skips Cloudflare publication
and cleanup.

## Content status

The current site is the portal foundation. It intentionally avoids unfinished operator
instructions. Task-oriented installation, authentication, configuration, operations,
and recovery guides are written only after their source delivery contracts are accepted.
