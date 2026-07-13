# Knowledge ingestion and retrieval

## Normalized document

Every source document includes:

- connector and external reference,
- source type,
- title and normalized content,
- source URL when available,
- external created and updated times,
- content hash,
- access metadata,
- product/version/language metadata,
- attachment references,
- and connector-owned metadata.

Revisions are immutable. Searchable activation occurs only after normalization,
attachment processing, chunking, and required embeddings succeed.

## Knowledge collections

A knowledge collection groups one or more configured sources and defines the immutable
embedding binding/version and vector dimensions used by its active index. Sources may
target different collections and therefore different AI providers or embedding models.

An analysis profile selects one or more collections. Retrieval creates at most one query
embedding per distinct selected embedding binding, reuses it across collections sharing
that binding, and fuses bounded results after searching each compatible vector space.
This makes multiple embedding providers possible while keeping the additional cost
explicit.

## Incremental ingestion

- Every source instance runs from its own manual, cron, polling, webhook, or combined
  synchronization policy.
- Discovery declares either snapshot or delta semantics.
- Snapshot synchronization uses a stable scan epoch across every page. Items absent from
  a snapshot are eligible for deletion only after the complete scan succeeds.
- Delta synchronization deletes only from explicit tombstones/events.
- Discovery uses connector cursors and cheap external fingerprints where possible.
- If the discovered external fingerprint equals the last successful observation, the
  item is a no-op: do not load content, process attachments, chunk, or call embeddings.
- When the external fingerprint changes, load and normalize the item, then compare its
  normalized content hash.
- If normalized content is unchanged, record the new external observation and advance
  the cursor without creating chunks or embeddings.
- If normalized content changed, compare deterministic chunks and embed only chunks that
  do not already have a reusable embedding.
- Chunk IDs derive from document revision, chunking profile, and chunk position.
- Embedding reuse is keyed by normalized chunk hash, immutable embedding binding version,
  embedding profile, vector dimensions, and relevant normalization version.
- Deleted source items are tombstoned and removed from active retrieval.
- Failed revisions remain inspectable without replacing the prior successful revision.

Activation, eligible deletion reconciliation, and cursor advancement commit atomically.
A failed, cancelled, or incomplete scan performs none of those final state changes.

Examples:

- An unchanged Markdown file is skipped using its Git blob OID or persisted file hash.
- A closed helpdesk case with the same API revision, ETag, update sequence, or equivalent
  connector fingerprint is skipped without loading comments or generating embeddings.
- If a helpdesk API reports a new update timestamp but normalized problem/resolution text
  is unchanged, metadata is updated and no embedding call occurs.
- Changing the embedding binding intentionally creates a new embedding space and requires
  embeddings for that collection; old embeddings remain attributable to their binding.

Resolved support cases should create distinguishable problem, investigation, and
resolution knowledge when the connector can identify them. Generated CaseWeaver
publications are excluded through stored publication identity, not matching disclaimer
text.

## Chunking

Chunking profiles are source-aware and versioned. Markdown chunking should preserve
headings, code blocks, lists, and source anchors. Historical cases should preserve role,
message ordering, and separation between question and verified resolution.

## Retrieval

Initial retrieval combines:

- PostgreSQL full-text ranking,
- pgvector similarity,
- metadata filters,
- source-specific quotas,
- and deterministic result fusion.

Fusion occurs across the selected collections after each collection has performed
retrieval in its own compatible embedding space.

The query must never load all vectors into application memory. Retrieval is executed in
the database with bounded candidates.

Default evidence groups:

- product documentation,
- historical problems,
- historical resolutions,
- attachment derivatives,
- optional operational knowledge.

Reranking is optional and disabled by default because it adds cost and latency. When
enabled it receives only a bounded candidate set and records its own AI operation.

## Retrieval output

Each result includes score components, source identity, revision, chunk location, source
URL, content, and access metadata. The analysis stores the selected evidence exactly as
seen so later source changes do not make an old analysis unauditable.

## Budgets

Retrieval configuration limits:

- candidates per source,
- final chunks per source,
- maximum characters/tokens,
- maximum age where appropriate,
- and optional minimum scores.

When content exceeds the analysis budget, deterministic trimming occurs before any
additional summarization call is considered.
