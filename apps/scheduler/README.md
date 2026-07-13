# Scheduler application

**PBIs:** 004, 012, 013

Evaluates due knowledge-source schedules and case-analysis polling schedules, acquires a
schedule lease, and enqueues commands with deterministic idempotency keys.

It does not call connectors or AI providers. Multiple replicas must be safe.
