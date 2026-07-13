# PostgreSQL infrastructure

**PBIs:** 002, 003, 004, 009, 013

Migrations, typed repositories, transactions, outbox, pgvector/full-text queries,
workspace filtering, leases, audit records, AI operation ledger, and budget reservations.

Business ranking and state-transition policy remain in vendor-neutral packages.

Owns inbox/outbox persistence and schedule/domain leases. It does not own queue-job
leases or worker heartbeats.
