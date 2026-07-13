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
- Per-turn AI operations and budget authorization where SDK usage permits.
- Aggregate estimation and capability declaration when per-turn usage is unavailable.
- Malicious-prompt and credential-isolation tests.

## Acceptance criteria

- No Copilot subscription or GitHub authentication is required in BYOK mode.
- Case content cannot select repositories, provider URLs, egress, or secret references.
- The tool sandbox contains no checkout/provider credentials and cannot use the network.
- Returned file paths and line ranges are validated against the pinned commit.
- Timeout and cancellation terminate the isolated process.
- The adapter declares whether strict monetary budget enforcement is supported.

## Excluded

Core analysis dependency on this provider, code modification, and repository write tools.
