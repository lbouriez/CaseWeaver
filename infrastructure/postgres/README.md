# PostgreSQL infrastructure

**PBIs:** 002, 003, 004, 009, 013

Migrations, typed repositories, transactions, outbox, pgvector/full-text queries,
workspace filtering, leases, audit records, AI operation ledger, and budget reservations.

Business ranking and state-transition policy remain in vendor-neutral packages.

Owns inbox/outbox persistence and schedule/domain leases. It does not own queue-job
leases or worker heartbeats.

Implements `OutboxStore` with multi-replica-safe claiming, retry metadata, and envelopes
for both commands and domain events. It does not publish them directly.

## Implementation decision

- Prisma schema/client/migrations for conventional relational data and transactions.
- Checked-in custom migration SQL for extensions and specialized indexes.
- Parameterized Prisma raw/TypedSQL or narrowly scoped `pg` queries for pgvector,
  full-text, bulk operations, leases, and outbox claiming.
- No Prisma-generated type leaves this package.

Planned internal layout:

```text
prisma/
  schema.prisma
  migrations/
src/
  client/
  repositories/<capability>/
  queries/
  unit-of-work/
```

See `.features/20-persistence-and-database-guide.md`.

## PBI-002 foundation

`prisma/migrations/20260713190000_pbi_002_foundation` is the first forward-only
migration. It enables `vector` but deliberately creates no vector columns, retrieval
indexes, normalized content, or connector configuration fields. Apply it with:

```powershell
$env:DATABASE_URL = "postgresql://..."
pnpm --filter @caseweaver/postgres run prisma:migrate:deploy
```

The adapter exposes application ports only. Its outbox claim/ack and resource-lease
operations use parameterized PostgreSQL SQL with database time, `SKIP LOCKED`, and
fencing tokens. `test:integration` requires a disposable `DATABASE_URL` whose database
name includes `test`.
