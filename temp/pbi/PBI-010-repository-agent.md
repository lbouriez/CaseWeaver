# PBI-010: Repository-agent sandbox and Copilot BYOK adapter

## Outcome

Provide an optional isolated implementation of the repository-agent port.

## Delivery state

**Completed through PBI-020.** The previously missing immutable runtime resolver,
exact pinned-checkout broker, credential-free isolated sandbox, registered BYOK provider,
and repository-evidence validation are delivered and fail closed when their deployment
requirements are unavailable.

PBI-020 owns the end-to-end operator-facing repository-analysis delivery and validated
the checkout, sandbox, provider, and repository-evidence acceptance criteria.

## Existing implementation reference

Before implementing, inspect
`C:\GIT\Nectari\Scripts\Tools\AITinyBootstrap`, particularly its provider wiring,
configuration loading, MCP injection, skill resolution, structured logging, artifact
output, cancellation behavior, and usage/cost capture. Its `README.md` documents the
expected operational flow.

This is behavioral reference material, not a runtime dependency. CaseWeaver must retain
provider neutrality, use its exclusive AI execution gateway, enforce the PBI sandbox and
budget requirements, and support Copilot SDK BYOK without requiring a Copilot
subscription or GitHub authentication.

## Scope

- Checkout broker using administrator-configured repository and secret reference.
- Sanitized pinned tree without credentials or authenticated remote configuration.
- Disposable read-only, networkless tool sandbox.
- Model traffic through the orchestrator or endpoint-restricted egress.
- GitHub Copilot SDK adapter configured through BYOK for OpenAI-compatible endpoints.
- Turn, tool-call, token, time, CPU, memory, and output limits.
- Parent operation and conservative whole-run budget reservation.
- Child operations for observable turns and aggregate reconciliation when turns are
  hidden.
- Malicious-prompt and credential-isolation tests.

## Acceptance criteria

- No Copilot subscription or GitHub authentication is required in BYOK mode.
- Case content cannot select repositories, provider URLs, egress, or secret references.
- The tool sandbox contains no checkout/provider credentials and cannot use the network.
- Returned file paths and line ranges are validated against the pinned commit.
- Timeout and cancellation terminate the isolated process.
- Hard-budget execution is rejected when neither per-turn metering nor a safe aggregate
  reservation can be enforced.

## Excluded

Core analysis dependency on this provider, code modification, and repository write tools.
