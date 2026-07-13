# PostgreSQL queue infrastructure

**PBIs:** 002, 013

Durable command queue, lease, heartbeat, retry, cancellation, dead-letter, and recovery
adapter, initially backed by PostgreSQL/pg-boss.

Command handlers live in applications/packages, not this adapter.

Owns queue-job leases only. An outbox relay publishes committed PostgreSQL outbox records
with deduplication; webhook and application transactions never rely on a non-atomic
persist-then-enqueue sequence.
