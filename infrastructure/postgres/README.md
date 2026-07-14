# PostgreSQL infrastructure

**PBIs:** 002, 003, 004, 009, 013

Migrations, typed repositories, transactions, outbox, pgvector/full-text queries,
workspace filtering, leases, audit records, AI operation ledger, and budget reservations.

Business ranking and state-transition policy remain in vendor-neutral packages.

Owns inbox/outbox persistence and schedule/domain leases. It does not own queue-job
leases or worker heartbeats.

## PBI-012 publication and triggers

The PBI-012 migration adds immutable publication profiles, durable publication intents
and attempts, verified-webhook inbox records, and case-analysis schedules. Publication
identity is unique per workspace, destination connector, and stable marker; execution
uses a fenced resource lease. `PostgresVerifiedWebhookEventStore` persists accepted
case-change commands in the same transaction as its inbox record.

## PBI-009 retrieval

`createPostgresRetrievalPersistence` implements the retrieval search and immutable
snapshot ports. Search applies workspace, selected-collection, authorized-source,
active-document/revision, and source-lifecycle predicates in both parameterized
full-text and vector queries. The migration provisions finite indexed dimensions `3`
(deterministic tests) and `1536`; callers may configure a subset but unsupported
dimensions are rejected rather than falling back to a corpus scan.

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

## PBI-013 operations

`20260714140000_pbi_013_operations` adds queryable immutable AI-operation attribution,
fenced expired-attempt recovery, privacy tombstones, and durable retention work items.
Privacy purge replaces governed snapshot/result/evidence content with tombstones and
queues object deletion; retention workers complete the object deletion through a
fencing token before metadata is marked deleted.
