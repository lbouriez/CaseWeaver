# API application

**PBIs:** 001, 002, 012, 013

Authenticated control-plane HTTP API for configuration, synchronization requests,
analysis jobs, approvals, publications, evidence, budgets, and cost queries.

PBI-013 adds authenticated routes for dead-letter inspection/retry, job
cancellation/recovery, cost attribution, privacy snapshot purge, and retention reaping.
Mutation bodies include request and idempotency digests; principals are resolved by the
trusted execution-context adapter, not request input.

Depends on application use cases and composition modules. It must not execute background
work, implement connector logic, or duplicate domain authorization.
