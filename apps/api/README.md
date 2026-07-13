# API application

**PBIs:** 001, 002, 012, 013

Authenticated control-plane HTTP API for configuration, synchronization requests,
analysis jobs, approvals, publications, evidence, budgets, and cost queries.

Depends on application use cases and composition modules. It must not execute background
work, implement connector logic, or duplicate domain authorization.
