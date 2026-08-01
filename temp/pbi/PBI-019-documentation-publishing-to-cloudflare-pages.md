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

**Pending — separate repository-governance follow-up.** All PBI-owned workflow,
documentation, and automated-validation work is complete. The pre-provisioned Cloudflare
Pages project, all four required repository secrets, and both Pages environments exist.
GitHub Actions run `29528380369` published the portal successfully on 2026-07-16 and
scheduled cleanup run `30603295655` succeeded on 2026-07-31.

The workflow now fails closed through `github.ref_protected` and the production
environment. Read-only GitHub API inspection confirmed that `main` currently has no
branch-protection rule and `cloudflare-pages-production` has no protection rule or
deployment-branch policy. No deployment, cleanup, secret, environment, or branch policy
was changed by this delivery. Those are repository-governance choices that require the
owner to select the required reviewers and branch policy.

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
- [ ] Only a protected default-branch push and a deliberate manual dispatch from that
      protected branch can reach the protected production deployment environment. The
      workflow enforces this fail-closed condition, but the live GitHub protection
      settings are intentionally pending separate follow-up work.
- [x] The workflow is concurrency-safe, has minimum required GitHub permissions, and
      uses immutable-SHA-pinned actions.
- [x] A cleanup workflow removes closed-PR preview deployments, stale preview
      deployments, and older production deployments on a schedule or manual trigger.
- [x] The workflow cannot deploy an application container, call a CaseWeaver API, read
      a database, or access a connector/provider credential.

## Pending repository-governance follow-up

This work is intentionally queued separately from the CaseWeaver implementation:

1. Protect `main` with the branch policy selected by the repository owner. This makes
   GitHub expose `github.ref_protected` for the production ref.
2. Configure `cloudflare-pages-production` with the chosen required reviewers and a
   deployment-branch policy that permits only protected `main`. The preview environment
   remains unprotected for trusted same-repository pull-request previews.
3. After those policies are in place, inspect one protected-`main` publish and run
   cleanup once with `dry_run: true` before relying on nightly production pruning.

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
