# AI configuration and cost

**PBI:** 003

Immutable provider/model bindings, model roles, explicit LiteLLM catalog imports,
conditional component pricing, and exact-decimal cost estimation. Configuration never
imports a provider adapter or refreshes upstream data during an AI call. It emits value
types consumed by `ai-execution`; persistence and budget transactions remain ports.

LiteLLM models with a price that cannot be represented exactly by the durable
`numeric(38,18)` cost contract are retained with that price component absent. They are
therefore **unknown-priced**, never rounded or treated as zero; a hard budget blocks
their execution until an explicit compatible override is configured.

LiteLLM's canonical model key is retained as a provider-facing display and
runtime value. The imported catalog model ID is instead a bounded SHA-256
identity derived from its immutable snapshot and canonical key. This keeps
control-plane list/detail URLs safe even for normal names such as
`provider/model`; it does not alter model selection or pricing semantics.
