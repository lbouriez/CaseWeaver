# PBI-003: AI providers, model catalog, and cost

## Outcome

Provide configurable model roles, provider-neutral AI contracts, pricing, usage, and
budgets.

## Scope

- Embedding, vision, generation, reranker, and repository-agent ports.
- OpenAI-compatible embedding, vision, and generation adapter.
- Provider/model/model-binding persistence.
- Immutable binding versions including endpoint/deployment, wire API, parameters,
  capabilities, and secret-reference identity.
- LiteLLM pricing importer with pinned source revision and content hash.
- Installation and workspace price overrides.
- Normalized token and cache usage.
- AI operation ledger and estimated/provider-reported costs.
- Conditional pricing components and one configured budget currency.
- Transactional budget reservations for operation, analysis, day, and workspace scopes.
- Deterministic fake providers for tests.
- Workspace defaults plus knowledge-collection and analysis-profile binding selection.

## Acceptance criteria

- Embedding, vision, analysis, and repository-agent roles configure independently.
- Import recognizes input, output, cache-read, and cache-creation pricing.
- Unknown fields are preserved and malformed prices are rejected.
- Applicable unsupported or ambiguous pricing conditions result in unknown/incomplete
  cost rather than a partial estimate.
- Override precedence follows `.features/05-ai-models-and-pricing.md`.
- Unknown price is never reported as zero.
- Concurrent hard-budget checks cannot reserve the same allowance.
- Retry, timeout, cancellation, missing usage, and over-reservation reconciliation are
  covered by integration tests.
- Every successful or failed provider call creates an operation record.
- Binding role, capability, and context/output limits are validated.
- Core services select providers and models only through binding IDs and interfaces.

## Excluded

Copilot SDK implementation and real analysis orchestration.
