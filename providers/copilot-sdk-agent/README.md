# Copilot SDK repository-agent provider

**PBI:** 010

Optional `RepositoryAgentProvider` implementation using an injected Copilot SDK client
in BYOK-only OpenAI-compatible mode. It accepts only HTTPS `completions`/`responses`
endpoints, derives and passes a safe aggregate token bound from configured per-turn
limits, enforces turn/tool/resource limits, and normalizes aggregate or observable-turn
usage. The adapter contains no GitHub authentication, subscription, or fallback
configuration.

It receives an injected repository runtime and administrator-selected pinned repository;
the runtime, not this provider, owns checkout brokering, isolation, and evidence-path
validation.
