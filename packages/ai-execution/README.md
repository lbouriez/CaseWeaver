# Metered AI execution

**PBI:** 003

The exclusive gateway resolves immutable bindings, estimates and reserves budgets in one
transaction with operation creation, dispatches through injected SDK ports, and finalizes
the ledger/reconciliation in a separate transaction. It never imports an adapter. Timeout,
cancellation, missing usage, unknown pricing, provider overage, and foreign provider
costs remain explicit rather than becoming zero-cost successes.

For repository agents, the gateway reserves a conservative whole-run parent amount from
the maximum turn count and per-turn limits. Observable model turns are recorded as
non-reserving children; hidden turns reconcile the parent from aggregate usage.
