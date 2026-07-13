# PBI-002: Domain and persistence foundation

## Outcome

Implement portable domain primitives, durable jobs, and initial database migrations.

## Scope

- Workspace, connector registration, external reference, case snapshot, knowledge item,
  attachment, analysis profile, job, attempt, evidence, and publication types.
- Principal, credential registration, workspace role/permission, and audit-event types.
- Discriminated job and publication state machines.
- PostgreSQL migrations and typed repositories.
- Prisma schema/client for conventional persistence plus parameterized SQL for
  transaction, inbox/outbox, and lease foundations.
- Database-neutral domain-specific repository ports; Prisma types remain internal.
- PostgreSQL-backed queue with lease expiry, heartbeat, retry classification, and
  cancellation.
- Application-layer outbox relay using `OutboxStore` and `DurableMessageQueue` ports for
  typed command and domain-event envelopes.
- Transactional outbox for domain events.
- Single-workspace bootstrap while retaining workspace IDs in all owned records.
- Application-service authorization guard and one-administrator bootstrap flow.

PBI-002 persists identity, ownership, lifecycle, version, hash, and provenance
placeholders only. It does not define normalized case/message bodies or hashing
(PBI-006), knowledge content/revisions/chunks (PBI-004), attachment derivatives
(PBI-008), model/budget data (PBI-003), structured analysis/evidence payloads
(PBI-011), or publication profile/destination details (PBI-012).

## Acceptance criteria

- Expired running jobs are recoverable without duplicate active leases.
- State transitions reject invalid transitions.
- Force-rerun preserves previous analyses.
- Migrations run from an empty database and on the previous migration.
- Repository tests use a real PostgreSQL test database.
- Retrieval-specific vector/full-text indexes and queries are excluded and owned by
  PBI 009.
- Persistence follows `.features/20-persistence-and-database-guide.md`.
- Connector-specific fields are absent from core tables.
- Privileged operations can require a principal, permission, and workspace.

## Excluded

Real connectors, embeddings, and model calls.
