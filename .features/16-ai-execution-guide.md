# AI configuration and execution implementation guide

## Purpose

Make all AI capabilities replaceable, metered, budgeted, and attributable.

## Roles and bindings

The core references model roles, never model names:

- embedding,
- vision,
- analysis,
- repository agent,
- optional reranker, keyword extraction, and chat.

An immutable binding version contains provider instance, endpoint/deployment, model,
wire protocol, parameters, capabilities, secret reference, and pricing selection.
Changing any effective field creates a new version.

## Provider adapter contract

Provider adapters:

- validate provider-specific configuration,
- translate normalized requests,
- return normalized results and usage,
- preserve provider request/effective-model identifiers,
- support cancellation and timeouts,
- and map errors accurately.

They do not resolve roles, reserve budgets, calculate prices, persist ledgers, or decide
fallback policy.

## Exclusive execution gateway

Every feature calls one gateway:

```ts
interface AiExecutionGateway {
  execute<TRequest, TResult>(
    request: MeteredAiRequest<TRequest>,
    context: AiExecutionContext
  ): Promise<MeteredAiResult<TResult>>;
}
```

Required sequence:

1. Resolve immutable binding and capability requirements.
2. Validate context/output limits.
3. Calculate a conservative upper-bound cost.
4. Transactionally reserve operation/analysis/day/workspace budgets.
5. Persist operation start.
6. Invoke provider with timeout/cancellation.
7. Normalize usage, including cache and reasoning tokens.
8. Calculate estimated cost from catalog/overrides.
9. Store provider-reported cost separately.
10. Reconcile reservation and finalize success/error.

No knowledge, attachment, retrieval, analysis, prompt, or chat module can import a
provider adapter.

## Pricing

- Import LiteLLM data as a pinned, hashed snapshot.
- Preserve unknown fields and source revision.
- Apply conditional price components and per-component override precedence.
- Unknown/incomplete price is not zero.
- Hard monetary budgets require applicable known pricing unless explicitly bypassed.
- Use decimal arithmetic and one configured budget currency initially.

## Fallback

Fallback is explicit model-binding policy, not a provider catch-all. A fallback attempt:

- receives its own operation record and reservation,
- occurs only for configured retryable errors,
- respects data/capability restrictions,
- and is visible in the final result.

## Repository agents

Agent runtimes implement `RepositoryAgentProvider`. Copilot SDK BYOK is initial, not
mandatory. Limit turns, tool calls, tokens, duration, and repository permissions. Meter
each model turn when available.

Opaque agent runs create one parent operation and reserve a conservative whole-run bound.
Observable turns create child operations. When turns are hidden, reconcile aggregate
usage against the parent reservation. If no safe aggregate bound can be enforced, reject
hard-budget execution for that binding.

## Minimum tests

- Binding immutability and capability validation.
- Budget reservation under concurrent calls.
- Usage/cost calculation including cache tokens.
- Unknown price behavior.
- Failure, timeout, retry, and fallback ledger finalization.
- Provider contract normalization with recorded fixtures.
- One integration test proving a feature cannot bypass the gateway.
