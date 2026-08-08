# Repository-change persistence

This adapter owns durable, workspace-scoped automation requests created from immutable analysis results. It validates the opt-in setting from the selected immutable code-repository version, creates an idempotent execute outbox command, and retains only redacted workflow state. It never resolves a credential value, calls a model, runs tests, or calls Azure DevOps.
