# PBI-004: Incremental knowledge ingestion

## Outcome

Build the source-neutral ingestion pipeline.

## Scope

- `KnowledgeSource` contract and discovery cursor.
- Per-source manual, cron, interval, webhook, and periodic full-rescan policies.
- Opaque external fingerprints and cheap pre-load change checks.
- Knowledge collections with immutable embedding binding/version and dimensions.
- Immutable source revisions and active-revision activation.
- Versioned normalization and chunking profiles.
- Deterministic chunk IDs and content hashes.
- Batched embeddings with reuse across unchanged chunks.
- Deletion/tombstone handling.
- Failed-revision diagnostics and synchronization statistics.

## Acceptance criteria

- Re-running unchanged content performs no embedding call.
- Matching external fingerprints skip load, normalization, attachments, chunking, and AI.
- Changed external metadata with identical normalized content advances observation/cursor
  state without generating chunks or embeddings.
- A changed document creates a revision and embeds only changed chunks.
- Sources in different collections can use different embedding providers/models.
- Query embedding reuse and multi-space retrieval requirements are exposed to retrieval.
- A failed revision leaves the prior revision searchable.
- Deletion removes the item from active retrieval.
- Cursor advancement and activation commit atomically where required.
- Embedding operations allocate usage and cost to affected chunks.

## Excluded

Specific source connectors and retrieval ranking.
