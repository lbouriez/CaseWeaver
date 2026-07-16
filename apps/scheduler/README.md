# Scheduler application

**PBIs:** 004, 012, 013

Evaluates due knowledge-source and case-analysis schedules, acquires schedule leases,
and enqueues commands with deterministic idempotency keys. Legacy case-analysis
schedules are ignored as unavailable; they cannot safely emit a mutable trigger command.

It does not call connectors or AI providers. Multiple replicas must be safe.

PBI-004 exposes `createSchedulerRuntime` for knowledge schedules and PBI-012 exposes
`createCaseAnalysisSchedulerRuntime` for the discovery-backed v2 producer. Its
PostgreSQL store selects only an active exact trigger version, retained connector
configuration version, target, and activation actor; it atomically records the trigger
request, idempotency record, audit event, and `analysis.trigger.v2` handoff. Command
delivery remains with the outbox relay and worker registry.

`caseweaver-scheduler start` composes both executable PostgreSQL schedule stores against
one owned pool. The case-analysis store deliberately excludes legacy rows, so they cannot
make the scheduler emit v1 work or rebind to mutable configuration. It accepts
`DATABASE_URL`, `SCHEDULER_POLL_INTERVAL_MS` (100–3,600,000),
`SCHEDULER_BATCH_LIMIT` (1–100), and `SCHEDULER_LEASE_MS` (1–3,600,000). Startup
performs a first durable poll before readiness; shutdown drains that poll and closes the
pool. It still never invokes connector, AI, or object-storage code.
