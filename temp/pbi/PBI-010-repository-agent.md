# PBI-010: Repository-agent sandbox and Copilot BYOK adapter

## Outcome

Provide an optional isolated implementation of the repository-agent port.

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
