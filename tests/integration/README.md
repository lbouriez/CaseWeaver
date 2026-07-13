# Integration tests

**PBIs:** 002, 013

Real PostgreSQL/pgvector, queue, storage, application composition, migration, lease,
budget, retrieval, and idempotency tests with deterministic fake external systems.

PBI-002 keeps its foundational PostgreSQL integration tests next to the
`infrastructure/postgres` adapter so they can evolve with its migrations and repositories.
PBI-013 owns broader cross-package composition tests in this directory.
