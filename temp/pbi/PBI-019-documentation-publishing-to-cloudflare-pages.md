# PBI-019: Documentation publishing to Cloudflare Pages

## Outcome

Publish the standalone CaseWeaver documentation artifact from `website/build` to a
pre-provisioned Cloudflare Pages project through a constrained GitHub Actions workflow.
The workflow verifies the site before upload, deploys preview builds for pull requests,
deploys production only from the protected default branch or a manual dispatch, and
includes a cleanup job to prune stale preview and old production deployments. It does
not host CaseWeaver applications, proxy API traffic, expose runtime configuration, or
receive application secrets.

## State and dependencies

**In progress.** The isolated verification/publishing workflow is implemented. A
repository owner must still create the Cloudflare Pages project, the GitHub deployment
environments, and the required repository or environment variables before real
deployments and cleanup can occur. Operational setup details live in the website's
internal documentation, not in the public docs portal.

Depends on:

- **PBI-018 Phase 1** for the self-contained Docusaurus artifact and its lockfile.
- **PBI-017 coordination** because it owns the repository's release/delivery policy and
  adjacent GitHub workflow conventions.
- **PBI-001/integration-owner coordination** before changing any root quality or CI
  registry; this PBI intentionally adds a separate workflow instead.

## Scope

- Add an isolated `docs-pages.yml` workflow that runs on documentation pull requests
  and default-branch pushes, with a manual production trigger.
- Build, typecheck, and test `website/` with the repository's pinned Node/pnpm baseline
  and its own frozen lockfile before any upload.
- Upload only `website/build` through the maintained Cloudflare Wrangler GitHub Action.
- Use a protected `cloudflare-pages-production` GitHub environment for production
  deployment, an unprotected `cloudflare-pages-preview` environment for previews and
  cleanup, and separate concurrency groups for preview and production deploys.
- Build pull requests into preview deployments for same-repository branches only, so an
  untrusted fork does not receive deployment authority.
- Add a cleanup workflow that deletes preview deployments when a PR closes, removes
  stale preview deployments on a schedule, and keeps only the most recent production
  deployments.

## Acceptance criteria

- [x] The website's independent install, typecheck, test, and production build succeed
      in the documentation workflow before deployment is attempted.
- [x] Pull requests receive the same verification but never receive Cloudflare tokens or
      trigger a production deployment.
- [x] Pull requests from the same repository can deploy preview builds and comment the
      preview URL back on the PR.
- [x] Only default-branch pushes and a deliberate manual dispatch from that branch can
      reach the protected production deployment environment.
- [x] The workflow is concurrency-safe, has minimum required GitHub permissions, and
      uses immutable-SHA-pinned actions.
- [x] A cleanup workflow removes closed-PR preview deployments, stale preview
      deployments, and older production deployments on a schedule or manual trigger.
- [x] The workflow cannot deploy an application container, call a CaseWeaver API, read
      a database, or access a connector/provider credential.

## Excluded

- Creating a Cloudflare account, Pages project, domain, DNS record, access policy, or
  API token in the repository or through this automation.
- Cloudflare Workers, server-side rendering, analytics, access-control products, API
  proxying, runtime configuration, or application/OCI deployment.
- Preview deployments from forked pull requests, until separately authorized with a
  threat model and a credential design that can safely expose secrets to untrusted code.

## References

- `AGENTS.md`
- `.features/11-engineering-standards.md`
- `.features/22-testing-strategy.md`
- `.features/23-implementation-workflow.md`
- `temp/pbi/PBI-017-docker-first-self-hosting-and-delivery.md`
- `temp/pbi/PBI-018-documentation-portal-and-operator-guide.md`
- `.github/workflows/ci.yml`
- Cloudflare Pages Direct Upload and Wrangler GitHub Action documentation
