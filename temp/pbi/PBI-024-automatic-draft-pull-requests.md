# PBI-024: Automatic Azure DevOps draft pull requests from verified code issues

## Outcome

When an immutable repository-assisted analysis has a high-confidence, evidence-backed
code issue, CaseWeaver can automatically prepare a small correction and open **one Azure
DevOps draft pull request** for developer review. The feature is opt-in on the existing
code-repository version and reuses its registered repository credential; it does not add
a second repository setup screen or create a work item.

## State and dependencies

**Completed.** Depends on PBI-003 metered AI execution, PBI-010/PBI-020 pinned
repository runtime and analysis records, PBI-013 durable outbox/worker semantics, and
PBI-016 administration authoring.

## Product decisions

- Azure DevOps is the first outer repository provider. The application feature is
  provider-neutral; GitHub/Azure DevOps alternatives belong in separate adapters.
- Automation is eligible only when the structured analysis has `high` confidence and
  validated repository findings. It does not infer a human approval score.
- The configured target is a branch. The worker refreshes that branch before authoring,
  preserves the analyzed and refreshed commit identities separately, and never edits the
  historical analyzed commit.
- An Architect phase decides whether a narrow correction is safe before the Author phase
  returns bounded UTF-8 replacement files. Both model calls use the existing immutable
  repository-agent binding, hard budget, and read-only attested tools through
  `ai-execution`.
- CaseWeaver never runs an unknown target repository test suite, completes/merges a PR,
  changes branch policies, creates a work item, or bypasses developer review.
- The PR is always a draft. Its body names the analysis, any available case/work-item
  reference, architect/documentation impact, and that target-repository tests were not
  run.

## Delivered scope

- Immutable `automaticDraftPullRequest` repository configuration, limited to a remote
  HTTPS branch with one registered write-capable repository credential.
- A versioned `repository-change.execute.v1` command and idempotent workflow state:
  queued, planning, authoring, draft created, no change, failed, outcome unknown.
- Atomic scheduling from `analysis.completed.v1`; publication and repository-change
  scheduling remain independent idempotent consumers.
- A provider-neutral `@caseweaver/repository-changes` application feature, metered
  repository-change AI protocol, and Copilot SDK BYOK architect/author implementation
  with read-only repository tools.
- Azure DevOps Git REST adapter that resolves the target branch, creates a deterministic
  source branch with an optimistic ref creation push, and creates/reuses a draft PR.
- Durable PostgreSQL storage and a forward-only migration; no source content, credential
  value, locator, transcript, or remote URL enters its public state.
- Repository Analysis UI opt-in and bilingual operator/architecture documentation.

## Acceptance criteria

- [x] A remote HTTPS branch with one registered repository credential can opt in to
      automatic draft PRs; a mount, tag, commit, or credential-free repository cannot.
- [x] A high-confidence repository-backed analysis schedules one durable request; retry
      cannot duplicate the request, branch, or PR.
- [x] The worker plans before authoring and validates bounded text-only replacement
      files before the provider adapter receives them.
- [x] The Azure DevOps adapter refreshes the configured target branch, creates only a
      deterministic source branch and `isDraft: true` PR, and does not run tests/merge.
- [x] Every model invocation remains metered through `ai-execution`; source access stays
      read-only and credentials stay outside model/runtime outputs.
- [x] Unit, adapter, worker-routing, API/Admin, and deterministic end-to-end coverage
      cover the success path, validation failure, idempotency, and no-test/no-merge rule.

## Folder ownership

`packages/{domain,ai-sdk,ai-execution,repository-changes}`, `providers/copilot-sdk-agent`,
`connectors/azure-devops-repositories`, `infrastructure/postgres/src/repository-changes`,
`apps/{api,admin,worker}`, `tests/e2e`, relevant feature specifications and website docs.
