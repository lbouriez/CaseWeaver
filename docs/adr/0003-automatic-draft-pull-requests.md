# ADR 0003: Create only reviewable Azure DevOps draft pull requests from verified code issues

## Status

Accepted.

## Context

Repository-assisted analysis can identify a code issue with evidence, but asking an
operator to copy the result into a coding tool loses the analysis/case trail and delays
the developer review. We need a narrow automation path without turning CaseWeaver into a
general-purpose coding agent or granting an AI runtime Git write access.

## Decision

- A completed analysis may schedule one repository-change request only when its immutable
  repository version opted in, it has high confidence, and it has validated repository
  findings.
- The worker resolves the latest configured target branch, runs a read-only Architect
  phase before a read-only Author phase, validates bounded replacement files, then asks
  an outer Azure DevOps adapter to create a deterministic branch and draft PR.
- Both AI phases reuse the existing repository-agent binding and `ai-execution`; the
  model receives no credential or write tool. The Azure DevOps adapter is the only write
  boundary and uses the existing registered repository credential.
- CaseWeaver does not run an unknown target test project. The draft PR explicitly says
  so. It never merges/completes a PR, alters policies, or creates a work item.
- Requests are durable and idempotent. A non-provable remote result is `outcome_unknown`,
  not a new branch retry.

## Consequences

- Developers remain the approvers and test owners.
- Azure DevOps is initially the only repository provider. GitHub support requires a new
  adapter, not a vendor condition in the application feature.
- An automatic draft PR needs a repository credential with Azure DevOps code-write
  permission; operators must scope and rotate it according to their identity policy.
