# Knowledge

**PBI:** 004

Source-neutral synchronization pipeline: discover, fingerprint comparison, load,
normalize, revision, attachment processing request, chunk, embedding reuse, activation,
deletion, and cursor advancement.

Unchanged fingerprints and unchanged normalized content must terminate before embedding.

Discovery explicitly declares `snapshot` or `delta` semantics. Snapshot scans use stable
scan epochs and reconcile missing items only after every page succeeds. Delta feeds
delete only through explicit tombstones. Activation, eligible deletions, and cursor
advancement commit atomically; failed scans do none of them.

`KnowledgeIngestionService` accepts a PBI-006 `KnowledgeSource`, normalization/chunk
ports, a persistence port, and an injected `AiExecutionGateway`. It never imports a
connector implementation or provider SDK. Embedding cache identity includes normalized
chunk hash, immutable binding version, embedding profile, vector dimensions, and
normalization profile. Attachment preparation is an optional port owned by PBI-008.
