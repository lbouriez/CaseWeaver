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
