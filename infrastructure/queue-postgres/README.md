# PostgreSQL queue infrastructure

**PBIs:** 002, 013

Durable command queue, lease, heartbeat, retry, cancellation, dead-letter, and recovery
adapter, initially backed by PostgreSQL/pg-boss.

Command handlers live in applications/packages, not this adapter.

Owns queue-job leases and the `DurableMessageQueue` adapter only. The application-layer relay
uses this adapter with `OutboxStore`; infrastructure packages do not call each other.

Queue envelopes have a stable ID, kind (`command` or `domainEvent`), schema/version,
workspace, correlation/causation IDs, payload, and delivery metadata.

Production runtime uses pinned pg-boss and disables startup auto-migration with
`migrate: false`. A dedicated migration command upgrades the pg-boss schema before
services start. Runtime service roles do not receive DDL permission.

## PBI-002 adapter

`PgBossDurableMessageQueue` is a thin `pg-boss@12.26.0` implementation of the
application `DurableMessageQueue`. It uses schema `caseweaver_queue`, queue
`caseweaver.envelope.v1`, and the outbox envelope ID as the pg-boss job ID. Runtime
always sets `migrate`, `createSchema`, `schedule`, and `useListenNotify` to `false`.
Envelope IDs must be UUID-formatted because pg-boss stores job IDs as UUID values.
Call `runPgBossMigrations()` from the controlled installation migration path before
starting workers; runtime startup then fails rather than creating DDL objects.
