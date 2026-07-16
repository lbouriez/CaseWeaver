# OpenAI-compatible provider

**PBI:** 003

Boundary-only embedding, vision, and generation adapter for configurable
OpenAI-compatible endpoints. It uses safe `fetch`, validates configuration and responses,
normalizes usage and provider identifiers, and propagates cancellation. It does not
choose bindings, resolve secrets, reserve budgets, calculate costs, or persist operations.

Its exported administration descriptor is safe metadata registered at API composition
for dynamic console discovery. It exposes secret references rather than API keys, and
all actual AI calls continue to flow through `packages/ai-execution`.

The package also contributes exact local token counting for immutable bindings through
`tokenizerEncoding` (`gpt2`, `r50k_base`, `p50k_base`, `p50k_edit`, `cl100k_base`, or
`o200k_base`). OpenAI-compatible endpoints may use arbitrary model names, so missing or
unsupported encoding metadata is rejected rather than guessed. Token counting never
uses the endpoint or credential.

Repository-agent execution is deliberately unavailable here. Although the shared request
now carries CaseWeaver's required server-created immutable repository-runtime pin, the
OpenAI-compatible protocol in this package does not standardize a safe multi-turn
tool-calling dialect. Implementing a generic loop would let endpoint/model behavior
select tool semantics, which is not an acceptable isolation boundary. A
deployment-specific adapter may enable the stage only when it drives the attested
read-only runtime from that exact pin; until then this provider fails closed before
contacting an endpoint or resolving any repository configuration.
