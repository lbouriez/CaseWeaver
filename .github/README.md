# GitHub Actions

This guide explains every CaseWeaver GitHub Actions workflow. It separates ordinary
code verification from actions that can publish or delete external resources, so an
operator can understand why a run occurred and which repository settings it needs.

## At a glance

| Workflow | Configuration | When it runs | What it may change |
| --- | --- | --- | --- |
| CI | [`workflows/ci.yml`](workflows/ci.yml) | Pull requests and pushes to `main` | Nothing outside the runner. |
| Container images | [`workflows/containers.yml`](workflows/containers.yml) | Pull requests, `main`, and `v*` tags | Only a `v*` tag can publish OCI images. |
| CodeQL | GitHub-managed default setup | Pushes to the default branch and GitHub's weekly schedule | Only GitHub code-scanning results. |
| Admin console Pages | [`workflows/admin-pages.yml`](workflows/admin-pages.yml) | Admin pull requests, protected `main`, or manual dispatch | Uploads a verified static artifact; only protected `main` may publish it to the dedicated Admin Pages project. |
| Documentation portal | [`workflows/docs-pages.yml`](workflows/docs-pages.yml) | Documentation pull requests, `main`, or manual dispatch | Cloudflare Pages preview/production deployments. |
| Documentation portal cleanup | [`workflows/docs-pages-cleanup.yml`](workflows/docs-pages-cleanup.yml) | Closed pull requests, daily schedule, or manual dispatch | Cloudflare Pages preview/old-production deployments. |

All six workflows are active once their delivery changes reach `main`.
The documentation workflow always performs its isolated site verification. Its
Cloudflare publication and cleanup steps remain safely skipped until the documented
repository variables and protected-environment secret are configured. Production
publication and production pruning additionally require GitHub to report that `main` is
protected; a workflow cannot create that branch protection itself.

## CI — source quality and integration verification

`CI` is the primary pull-request check. It runs on every pull request and every push
to `main`; it has only `contents: read` permission and cannot publish anything.

It performs these checks in order:

1. Checks out the revision and sets up Node 22.13.1.
2. Installs Corepack 0.31.0 and activates the repository-pinned pnpm 11.12.0.
3. Installs dependencies with the lockfile frozen.
4. Checks formatting, lint rules, and dependency-direction rules.
5. Builds all workspace packages, then type-checks them. The order is important:
   workspace package exports point at generated declaration files, so a new clone must
   build those declarations before no-emit type checking resolves cross-package types.
6. Runs unit/contract tests, starts the disposable PostgreSQL test service, runs
   integration tests, and always removes the test service afterwards.

The Corepack step is deliberately explicit. Node 22.13.1's bundled Corepack keyring is
too old to verify pnpm 11.12.0; relying on it makes a valid frozen install fail before
the project is evaluated.

## Container images — build, exercise, and release runtime images

`Container images` has five gated stages:

- **Image matrix:** builds the migration, API, Admin, worker, scheduler, webhook,
  standalone, and no-network attachment-processor final images. On pull requests and
  `main`, each image is loaded locally
  and inspected to verify its final process identity. These are smoke builds, not
  published artifacts.
- **Disposable local Compose smoke:** builds the real local topology, waits for
  health checks, checks the edge/API/Admin runtime configuration, and runs the browser
  operator journey against the Compose stack. The stack and its volume are removed even
  when a step fails.
- **Production TLS Compose acceptance:** runs on pull requests, `main`, and version
  tags after the image matrix. It builds the release targets locally, brings up the
  hardened TLS topology, exercises real OIDC through the edge in Chromium, proves the
  runtime database role cannot issue DDL, performs PostgreSQL + S3-compatible
  object-store backup/restore into a second isolated project, then starts the separate
  distributed profile. It generates every certificate, OIDC key, database password,
  and object-store identity at test time and removes the projects/volumes afterwards.
- **Tag-gated immutable release:** only a push of a `v*` tag, after all prior jobs pass,
  logs in to the configured OCI registry and publishes each final linux/amd64 image.
  It generates an SPDX SBOM from the published digest, scans both the digest and the
  SBOM, and blocks any HIGH or CRITICAL vulnerability. The first policy has no ignored
  findings: an exception must be added through a reviewed delivery change rather than
  silently bypassing this job.
- **Clean verification and release record:** a fresh matrix job downloads the exact
  digest record, pulls it (not the release tag), verifies the GitHub SLSA provenance and
  SPDX SBOM attestations from the OCI registry with the expected workflow and source
  revision, then creates/updates a GitHub Release only after all eight targets verify.
  Its 365-day machine-readable artifact contains image references, platform, source
  revision, schema target/policy, and the Actions-run verification link.

The image matrix intentionally sets `sbom: false` and `provenance: false`: Docker's
local `load` exporter cannot load an attested manifest list. This does not weaken a
release—the digest-publishing job creates registry attestations and the following clean
job verifies them. Deployment must use a verified `image@sha256:...`, never a mutable
release tag or `latest`.

Release publishing needs `packages: write` and uses these optional configuration values:

- `CASEWEAVER_CONTAINER_REGISTRY` — OCI registry; defaults to `ghcr.io`.
- `CASEWEAVER_CONTAINER_USERNAME` — registry account; defaults to the GitHub actor.
- `CASEWEAVER_CONTAINER_PASSWORD` — registry credential; defaults to GitHub's scoped
  token where that registry supports it.

The publishing job additionally rejects a version tag whose commit is not in `main`
history. Repository administrators should protect the `v*` tag namespace so only the
release maintainers can create or move version tags; workflow code can verify ancestry
and the source digest, but cannot configure that repository-level protection itself.

Production operators deploy an immutable `image@sha256:...`, not a mutable release
tag. See [`../deploy/docker/README.md`](../deploy/docker/README.md) for the runtime
topology, migrations, backups, recovery, and operator verification commands; its
[threat model](../deploy/docker/THREAT_MODEL.md) explains the network, secret, and
database-role boundaries.

## CodeQL — GitHub-managed security analysis

CodeQL uses GitHub's default setup rather than a checked-in YAML file. It is configured
in the repository's **Settings → Code security and analysis** area, currently analyzes
Actions and JavaScript/TypeScript, uses the default query suite and remote threat model,
and runs on GitHub's weekly schedule as well as default-branch activity. It publishes
code-scanning findings only; it does not deploy, publish packages, or use project
secrets.

Because it is GitHub-managed, its Actions path is shown as
`dynamic/github-code-scanning/codeql`, not `.github/workflows/codeql.yml`.

## Documentation portal — verify and publish the public docs

`Documentation portal` is path-filtered to `website/**` and its own workflow file.
It installs the documentation package with pnpm 11.12.0, type-checks, tests, builds,
and keeps the verified build artifact for seven days.

- On protected `main`, the protected `cloudflare-pages-production` environment deploys
  the verified artifact to Cloudflare Pages. A manual dispatch is also accepted only
  from protected `main`.
- On a non-draft pull request from this repository (never a fork), the intentionally
  unprotected `cloudflare-pages-preview` environment deploys a preview to branch
  `pr-<number>` and maintains one bot comment with its HTTPS URL. The preview
  environment must stay unprotected for normal same-repository pull requests, while the
  production environment must be protected.

Cloudflare publishing accepts these as **repository variables** (preferred) or as
**repository secrets** (supported for existing installations):

- `CASEWEAVER_DOCS_SITE_URL` — the production HTTPS origin;
- `CLOUDFLARE_ACCOUNT_ID`;
- `CLOUDFLARE_PAGES_PROJECT`.

`CLOUDFLARE_API_TOKEN` is always a secret. Scope it to both
`cloudflare-pages-preview` and `cloudflare-pages-production` when those environments
are configured, and protect production. The legacy repository-secret arrangement is
also accepted so existing values never need to be recovered or re-entered. Without all
four values, verification still succeeds but deployment jobs are skipped.

The token is never given to fork pull requests. The production and preview deployment
jobs use only the artifact created by the verification job, not an unverified checkout;
they do not check out source code, request deployment permissions, or pass a GitHub token
to Wrangler. The publishing action installs its isolated Wrangler CLI through npm: the
repository itself remains pnpm-managed, while this avoids modifying its protected
workspace root to bootstrap a deployment-only tool.

Missing public Pages metadata means a publication job is intentionally skipped after
verification. If its protected environment is entered and the API token is absent or
metadata fails strict validation, that job fails closed instead; a green “skipped” job
must not be mistaken for a working Cloudflare deployment. Set a protected-branch rule
for `main` and protection rules on `cloudflare-pages-production` before considering
production publishing enabled.

## Admin console — verified Cloudflare Pages artifact

`Admin console Pages` is separate from the documentation portal workflow. Its
verification job runs on Console changes and creates a seven-day `apps/admin/dist`
artifact after testing the public runtime-config generator, type-checking, testing, and
building the existing Admin application. That job has only `contents: read` permission
and receives **no** Cloudflare deployment token.

The generated artifact contains a public `runtime-config.json` with the exact HTTPS API
origin and a restrictive `_headers` file. It has no OAuth client configuration, browser
token, secret, database, provider, connector, or backend value. Set this repository
variable before enabling publication:

- `CASEWEAVER_ADMIN_PAGES_API_ORIGIN` — exact public HTTPS API origin, for example
  `https://api.caseweaver.example`; it cannot include a path, user info, query, or
  fragment.
- `CASEWEAVER_ADMIN_PAGES_ACCOUNT_ID` — Cloudflare account ID for the Admin project.
- `CASEWEAVER_ADMIN_PAGES_PROJECT` — the distinct Admin Pages project slug.
- `CASEWEAVER_ADMIN_PAGES_UI_TITLE` — optional public Console title.

Create the protected GitHub environment `caseweaver-admin-pages-production` and put
`CASEWEAVER_ADMIN_PAGES_API_TOKEN` there. Only a push or manual dispatch on a protected
`main` branch can download and deploy the verified artifact. A missing variable causes
verification to build a non-deployable `https://caseweaver.invalid` artifact and skip
publication; missing protected-environment token/configuration fails closed after that
environment is entered.

There is deliberately no pull-request Pages preview job. Each preview receives a
different public origin, while the CaseWeaver API accepts only an explicit trusted
origin for credentialed CORS and OAuth return targets. A preview would either be unable
to sign in or would expand the production trust boundary. Use the verified workflow
artifact for review, then publish it only after the stable Pages origin is configured in
both GitHub and `ADMIN_ALLOWED_ORIGINS` on the API deployment.

## Documentation portal cleanup — remove obsolete Cloudflare deployments

`Documentation portal cleanup` removes preview deployments when an in-repository pull
request closes. Its daily schedule and manual dispatch remove stale/duplicate previews
in the unprotected preview environment and retain only the selected number of newest
production deployments in the protected production environment. Production pruning uses
the same serialization group as production publishing and requires protected `main`.
Manual dispatch supports `dry_run` and `keep_production` inputs; `keep_production` must
be a positive integer, and use `dry_run: true` first when operating it manually.

This workflow needs the same repository variables and environment secret as the
documentation publisher. It never runs cleanup for a fork pull request and safely
skips external deletion when that configuration is absent.

## Troubleshooting a run

Use the repository's **Actions** tab to open a workflow and the failed job step. From a
checked-out repository with GitHub CLI authentication, these commands are useful:

```powershell
gh run list --branch main
gh run view <run-id> --log-failed
```

For a Corepack signature error, verify that the workflow activates Corepack 0.31.0
before its first `pnpm` command. For an error mentioning Docker exporting a manifest
list, verify that only a publishing job enables SBOM/provenance attestations; a job that
uses `load: true` must build an unattested local smoke image.
