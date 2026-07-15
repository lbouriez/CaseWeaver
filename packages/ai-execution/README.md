# Metered AI execution

**PBI:** 003

The exclusive gateway resolves immutable bindings, estimates and reserves budgets in one
transaction with operation creation, dispatches through injected SDK ports, and finalizes
the ledger/reconciliation in a separate transaction. It never imports an adapter. Timeout,
cancellation, missing usage, unknown pricing, provider overage, and foreign provider
costs remain explicit rather than becoming zero-cost successes.

`DefaultAiExecutionGateway.preflight` is the corresponding read-only capability. It
resolves the same immutable binding, limits, pricing, and conservative reservation as an
execution, but does not resolve a secret, contact a provider, create an operation, or use
ledger/budget ports. Capability-test confirmation flows use it to display a server-derived
known-price estimate. `budget.requireBudgetPolicy` is an opt-in execution guard: when set,
the gateway requires an injected read-only applicable-policy port before it creates an
operation or reserves budget. Existing requests remain compatible because the guard is
off by default.

For repository agents, the gateway reserves a conservative whole-run parent amount from
the maximum turn count and per-turn limits. Observable model turns are recorded as
non-reserving children; hidden turns reconcile the parent from aggregate usage.
