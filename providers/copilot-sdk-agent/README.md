# Copilot SDK repository-agent provider

**PBI:** 010

Optional `RepositoryAgentProvider` implementation using an injected Copilot SDK client
in BYOK-only OpenAI-compatible mode. It accepts only HTTPS `completions`/`responses`
endpoints, derives and passes a safe aggregate token bound from configured per-turn
limits, enforces turn/tool/resource limits, and normalizes aggregate or observable-turn
usage. The adapter contains no GitHub authentication, subscription, or fallback
configuration.

It resolves an injected `PinnedRepositoryAgentRuntimeResolver` for every exact,
server-created runtime pin. The runtime, not this provider, owns checkout brokering,
isolation, and evidence-path validation. It has no fixed repository option and never
substitutes a current/default runtime version.

`RepositoryAgentRequest` carries the required server-created runtime pin. The normal
`runRepositoryAgent` method resolves exactly that pin and no other value; it cannot
infer a repository from a binding, case, prompt, or model-tool input.

The resolver returns an opaque bound runtime capability, not checkout material. Copilot
can use only its three injected read-only tools. Its bounded JSON findings carry untrusted
citations; the isolated runtime derives evidence IDs and excerpt hashes from the prepared
tree before returning the provider result. The SDK must report observable input and output
token usage, so incomplete metering fails closed rather than treating hard-budget work as
free.

The package also exports safe administration discovery metadata for API composition. It
does not expose BYOK values, runtime clients, repository paths, or provider calls to the
browser.
Descriptor revision `2` adds human-language operator guidance; an installation may
retain revision `1` only for immutable historical configuration references.
