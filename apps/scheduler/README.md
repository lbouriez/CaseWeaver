# Scheduler application

**PBIs:** 004, 012, 013

Evaluates due knowledge-source schedules and case-analysis polling schedules, acquires a
schedule lease, and enqueues commands with deterministic idempotency keys.

It does not call connectors or AI providers. Multiple replicas must be safe.

PBI-004 exposes `createSchedulerRuntime` for knowledge schedules. PBI-012 exposes
`createCaseAnalysisSchedulerRuntime`, which persists `analysis.trigger.v1` commands
with the same deterministic occurrence and lease rules. Command delivery is
intentionally left to the integration owner that owns shared envelopes and the worker
registry.
