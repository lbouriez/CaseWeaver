# PBI-013: Production operations

## Outcome

Make CaseWeaver operable as an autonomous, recoverable service.

## Scope

- Queue, synchronization, cache, cost, budget, and publication metrics.
- OpenTelemetry traces across API, worker, database, connectors, providers, and sandbox.
- Dead-letter inspection, authorized retry, cancellation, and lease-recovery commands.
- Retention jobs and privacy deletion with audit events and tombstones.
- Redacted diagnostic export.
- Docker Compose production example and installation documentation.
- Distributed and standalone profiles using the identical durable queue and handlers.
- Documented disposable PostgreSQL/pgvector integration-test environment.

## Acceptance criteria

- Operators can identify why a job failed without exposing secrets.
- Lease recovery and dead-letter retry work end to end.
- Cost and reservations can be queried by analysis, model role, connector, and time.
- Privacy deletion removes governed content and leaves the documented audit tombstone.
- Operational commands enforce workspace permissions and record their actor.
- Switching between standalone and distributed deployment preserves queued work and
  execution semantics.

## Excluded

MCP and user interfaces.
