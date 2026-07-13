# PBI-009: Hybrid retrieval

## Outcome

Retrieve bounded, auditable evidence from documentation and resolved cases.

## Scope

- pgvector indexes and PostgreSQL full-text indexes.
- Parameterized PostgreSQL queries contained in the persistence adapter; retrieval policy
  remains database-neutral.
- Exclusive ownership of retrieval migrations and
  `infrastructure/postgres/src/retrieval`.
- Metadata filters and workspace/source access constraints.
- Vector and lexical candidate search.
- Deterministic score fusion and source-specific quotas.
- Retrieval profile versioning and token/character budgets.
- Optional reranker port integration, disabled by default.
- Persisted retrieval snapshot for analysis audit.
- Query embedding generation once per distinct selected embedding binding and result
  fusion across compatible knowledge-collection vector spaces.

## Acceptance criteria

- Retrieval executes in PostgreSQL and never loads the full vector corpus.
- Results include source revision, location, scores, and URL.
- Source quotas prevent one corpus from consuming the full context.
- Inactive and unauthorized revisions cannot appear.
- Result ordering is deterministic for equal scores.
- Reranking creates a separately costed AI operation.
- Multiple collections using different embedding providers remain searchable with
  explicit query-embedding usage and cost.

## Excluded

External vector databases and graph retrieval.
