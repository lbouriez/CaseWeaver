# AI configuration and cost

**PBI:** 003

Immutable provider/model bindings, model roles, explicit LiteLLM catalog imports,
conditional component pricing, and exact-decimal cost estimation. Configuration never
imports a provider adapter or refreshes upstream data during an AI call. It emits value
types consumed by `ai-execution`; persistence and budget transactions remain ports.
