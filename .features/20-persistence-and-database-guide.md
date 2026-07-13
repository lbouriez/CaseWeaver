# Persistence and database implementation guide

## Decision

The initial adapter targets PostgreSQL with pgvector. Use Prisma for schema modeling,
ordinary CRUD, relations, transactions, and the migration workflow. Use parameterized
raw SQL, Prisma TypedSQL/raw APIs, or a narrowly scoped `pg` client where PostgreSQL
features are not adequately represented by Prisma.

Typical raw-SQL areas:

- pgvector columns, indexes, and similarity queries,
- advanced full-text search,
- bulk ingestion/upsert,
- advisory locks or specialized lease queries,
- extension setup,
- outbox claiming,
- and pg-boss integration.

Prisma is an implementation detail of `infrastructure/postgres`. Prisma models and client
types never cross repository ports.

## Why not only Prisma

Prisma improves maintainability for conventional data but extension-specific types and
queries can require raw SQL. Forcing vector/full-text/lease operations through an ORM
abstraction would reduce clarity, performance, and control.

## Why not raw SQL everywhere

Most configuration, identity, job metadata, profiles, audit, and relationships benefit
from generated types, consistent transactions, and migration tooling. Raw SQL is reserved
for operations where it is materially better.

## Database portability

The system is database-portable at the application-port level, not by pretending SQL
dialects are identical.

Define domain-specific ports such as:

- workspace/configuration repositories,
- source/revision/chunk repositories,
- case/analysis/publication repositories,
- AI operation and budget repositories,
- hybrid search,
- unit of work,
- inbox/outbox,
- and lease stores.

Do not create a generic `Repository<T>` or expose query builders outward.

A future database adapter may use another relational/vector combination, but it must
declare and satisfy required capabilities:

- atomic transactions,
- uniqueness/idempotency constraints,
- durable inbox/outbox,
- safe concurrent leases,
- full-text retrieval,
- compatible vector retrieval or an external vector adapter,
- migrations,
- and workspace isolation.

Feature packages depend on ports and capability declarations, never PostgreSQL behavior.

## PostgreSQL schema rules

- Use UUID/string IDs generated through an injected ID service.
- Every workspace-owned table includes `workspace_id`.
- Immutable records are insert-only except explicit retention/tombstone fields.
- Use database constraints for uniqueness, state identity, and idempotency.
- Store timestamps as timezone-aware UTC.
- Monetary values use exact decimal/numeric types plus currency.
- JSON is used only for connector/provider-owned extensibility and is schema-validated.
- Foreign keys and useful query indexes are required.
- Embeddings record binding version and dimensions; incompatible vectors never share a
  search index without partitioning.

## Migrations

- Prisma Migrate is the primary migration workflow.
- Checked-in migrations may contain reviewed custom SQL.
- Enable `vector` explicitly.
- Pin the pg-boss version. Production workers use `migrate: false`; a dedicated migration
  command upgrades its schema before runtime services start.
- Runtime database roles do not have DDL privileges.
- Do not rely on `prisma db push` outside disposable development experiments.
- Migrations are forward-only in production; document destructive operations.
- Validate migration from empty database and from the previous schema.
- Large/non-transactional index operations require an explicit rollout plan.

## Query safety

- Parameterize values; never interpolate user/schema identifiers.
- Validate any unavoidable identifier against an allowlist.
- Bound result sets and streaming/batch sizes.
- Use transactions for activation/cursor, inbox/outbox, publication identity, and budget
  reservations.
- Record query purpose and timing without logging sensitive values.

## Queue and outbox ownership

- PostgreSQL implements durable inbox/outbox storage and domain/schedule leases.
- The queue adapter implements typed command/domain-event envelope delivery and queue-job
  leases through `DurableMessageQueue`.
- An application-layer relay, hosted by worker/standalone, claims outbox envelopes and
  publishes them through the injected queue port.
- Envelopes support both commands and domain events and have stable delivery identity.
- Infrastructure adapters never invoke each other directly.

## Test database

`deploy/docker/compose.test.yml` starts an isolated PostgreSQL/pgvector instance:

```powershell
docker compose -f deploy\docker\compose.test.yml up -d --wait
docker compose -f deploy\docker\compose.test.yml down -v
```

The default connection is test-only:

```text
postgresql://caseweaver:caseweaver@localhost:54329/caseweaver_test
```

Integration tests create isolated schemas or reset through migrations/transactions. They
must never point at an unverified non-test database.

## Minimum tests

- Empty and incremental migrations.
- Repository constraints and workspace isolation.
- Transaction rollback.
- Concurrent lease/idempotency/budget reservation.
- pgvector/full-text query behavior with a small deterministic corpus.
- Inbox/outbox recovery.
- pg-boss empty-schema and pinned-version upgrade path with runtime auto-migration
  disabled.

Do not mock Prisma to test SQL. Use the disposable PostgreSQL instance for persistence
behavior and keep the dataset small.
