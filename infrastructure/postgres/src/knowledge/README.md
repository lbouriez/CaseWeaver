# PostgreSQL knowledge persistence

This folder contains the PostgreSQL adapters for source-command persistence, knowledge
ingestion records, and pinned source execution. It implements `@caseweaver/knowledge`
ports only; it does not construct connector clients, normalizers, chunkers, attachment
processors, AI providers, or worker handlers.

`runtime-execution.ts` resolves only safe, workspace-scoped immutable source,
connector, collection, profile, policy, and batch metadata. Its lease store returns an
opaque fence and cursor atomically. `index.ts` verifies that fence in the same
transaction as embeddings, mutations, snapshot reconciliation, and cursor advancement.
No resolver in this folder returns connector settings or credential locators.

`createPostgresKnowledgeRuntime` owns the raw PostgreSQL pool for the fenced
execution resolver, lease store, and vector/bulk ingestion store. Hosts close it
in their ordered shutdown sequence; it remains separate from Prisma's
control-plane client so bulk ingestion never leaks into transport composition.
