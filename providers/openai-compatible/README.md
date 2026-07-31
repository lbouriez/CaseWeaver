# OpenAI-compatible provider

**PBIs:** 003, 021

Boundary-only embedding, vision, and generation adapter for configurable
OpenAI-compatible endpoints. It uses safe `fetch`, validates configuration and responses,
normalizes usage and provider identifiers, and propagates cancellation. It does not
choose bindings, resolve secrets, reserve budgets, calculate costs, or persist operations.

Its exported administration descriptor is safe metadata registered at API composition
for dynamic console discovery. It exposes secret references rather than API keys, and
all actual AI calls continue to flow through `packages/ai-execution`.
Descriptor revision `2` adds human-language operator guidance; an installation may
retain revision `1` only for immutable historical configuration references.

Descriptor revision `3` makes the immutable OpenAI-compatible protocol explicit:
`embeddings`, `chatCompletions`, or `responses`. One endpoint may therefore be
configured as distinct provider instances for distinct roles without a hidden runtime
choice. The descriptor retains an opaque external-secret reference only. PBI-021
registers a server-only standard `/models` discoverer at API composition, so provider
availability comes from the configured endpoint rather than a LiteLLM label. A
configured
`embeddings` instance receives an embedding capability probe; the chat/responses modes
receive a bounded generation probe. Both still run exclusively through the metered
AI-execution gateway.

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

The adapter also implements server-only standard OpenAI-compatible `/models` inventory
discovery. An immutable `embeddings` instance requests the provider's documented
embedding modality filter, so OpenRouter's text-only default listing cannot hide its
embedding models. It receives an already-resolved credential only in trusted runtime
composition, returns a bounded normalized model list, and retains neither raw provider
responses nor account metadata. Administration persists a workspace-scoped immutable
provider inventory and uses LiteLLM only to enrich exact matching prices. It does not
present LiteLLM's unrelated provider entries as endpoint availability.
