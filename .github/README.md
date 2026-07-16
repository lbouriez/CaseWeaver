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
| Documentation portal | [`workflows/docs-pages.yml`](workflows/docs-pages.yml) | Documentation pull requests, `main`, or manual dispatch | Cloudflare Pages preview/production deployments. |
| Documentation portal cleanup | [`workflows/docs-pages-cleanup.yml`](workflows/docs-pages-cleanup.yml) | Closed pull requests, daily schedule, or manual dispatch | Cloudflare Pages preview/old-production deployments. |

All five workflows are active once this documentation-portal delivery reaches `main`.
The documentation workflow always performs its isolated site verification. Its
Cloudflare publication and cleanup steps remain safely skipped until the documented
repository variables and protected-environment secret are configured.

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

`Container images` has three kinds of jobs:

- **Image matrix:** builds the migration, API, Admin, worker, scheduler, webhook, and
  standalone final images. On pull requests and `main`, each image is loaded locally
  and inspected to verify its final process identity. These are smoke builds, not
  published artifacts.
- **Disposable local Compose smoke:** builds the real local topology, waits for
  health checks, checks the edge/API/Admin runtime configuration, and runs the browser
  operator journey against the Compose stack. The stack and its volume are removed even
  when a step fails.
- **Tag-gated release:** only a push of a `v*` tag, after both prior jobs pass, logs in
  to the configured OCI registry, publishes each final image, attaches SBOM and
  provenance attestations, then pulls the published tags in a clean job to check the
  final runtime identity.

The image matrix intentionally sets `sbom: false` and `provenance: false`: Docker's
local `load` exporter cannot load an attested manifest list. This does not weaken a
release—the tag-gated publishing job pushes images with both attestations enabled.
Attestation *verification*, vulnerability scanning, signing policy, and release
acceptance remain PBI-017 delivery work.

Release publishing needs `packages: write` and uses these optional configuration values:

- `CASEWEAVER_CONTAINER_REGISTRY` — OCI registry; defaults to `ghcr.io`.
- `CASEWEAVER_CONTAINER_USERNAME` — registry account; defaults to the GitHub actor.
- `CASEWEAVER_CONTAINER_PASSWORD` — registry credential; defaults to GitHub's scoped
  token where that registry supports it.

Production operators deploy an immutable `image@sha256:...`, not a mutable release
tag. See [`../deploy/docker/README.md`](../deploy/docker/README.md) for the runtime
topology and image contract.

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

- On `main`, the protected `cloudflare-pages-production` environment deploys the
  verified artifact to Cloudflare Pages.
- On a non-draft pull request from this repository (never a fork), the protected
  `cloudflare-pages-preview` environment deploys a preview to branch `pr-<number>` and
  maintains one bot comment with its HTTPS URL.

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
jobs use only the artifact created by the verification job, not an unverified checkout.
The publishing action installs its isolated Wrangler CLI through npm: the repository
itself remains pnpm-managed, while this avoids modifying its protected workspace root
to bootstrap a deployment-only tool.

## Documentation portal cleanup — remove obsolete Cloudflare deployments

`Documentation portal cleanup` removes preview deployments when an in-repository pull
request closes. Its daily schedule and manual dispatch remove stale/duplicate previews
and retain only the selected number of newest production deployments. Manual dispatch
supports `dry_run` and `keep_production` inputs; use `dry_run: true` first when
operating it manually.

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
