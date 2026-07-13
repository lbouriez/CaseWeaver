# ADR 0001: Use pg-boss for the initial durable message queue

## Status

Accepted.

## Context

CaseWeaver needs a PostgreSQL-backed durable queue for typed command and domain-event
envelopes. It must support stable message identifiers, retries, cancellation,
multi-worker leasing, heartbeat expiry, and dead-letter handling without creating a
second storage technology.

## Decision

Use `pg-boss` version `12.26.0` behind the application-owned `DurableMessageQueue` port.

- Use schema `caseweaver_queue`.
- Use queue name `caseweaver.envelope.v1`.
- Use the CaseWeaver outbox envelope ID as the stable pg-boss job ID.
- Runtime uses `migrate: false`, `createSchema: false`, `schedule: false`, and
  `useListenNotify: false`.
- A dedicated migration command runs Prisma migrations, then pg-boss schema migration,
  before workers start.
- Runtime database roles do not have DDL permission.
- PostgreSQL outbox relay and pg-boss adapter remain separate infrastructure components;
  the application relay calls both through ports.

## Consequences

- Workers never perform queue DDL at startup.
- A crash after queue publish but before outbox acknowledgement is safe through stable
  message ID deduplication and idempotent handlers.
- `pg-boss` is an adapter detail; another durable queue can replace it by implementing
  `DurableMessageQueue`.
- CaseWeaver remains the authoritative record for application attempts and typed
  failures; pg-boss operational metadata does not replace those records.
