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

## Pinned execution runtime

Durable execution resolves an exact source-configuration version, connector-
configuration version, and immutable collection runtime version through
`PinnedKnowledgeSourceConfigurationResolver`. The safe resolved record contains only
source-neutral IDs, profile IDs/versions, synchronization policy, batch size, immutable
binding/limit/budget metadata, and an opaque execution fence—never connector settings,
secret locators, or clients. Missing, disabled, mismatched, partial, or legacy pins are
unavailable; they are never rebound to mutable configuration.

`KnowledgeSynchronizationCoordinator` makes `incremental` and `fullRescan` distinct
execution modes. A full rescan carries an explicit reset control and requires snapshot
discovery semantics, rather than treating an absent cursor as a rescan. It claims,
renews throughout the full synchronization lifetime, and conditionally releases a
bounded source lease. Loss of the fence aborts discovery, load, and AI work through
the synchronization signal; the final ingestion commit carries the opaque fence so
persistence can reject stale activation/cursor updates.

`ImmutableKnowledgeTextProfileRegistry` resolves exact normalization and chunking
profile ID/version pairs. There is no implicit profile default. The exported baseline
registry is source-neutral and deterministic; deployments may add profiles through
trusted composition. Hard-budget embedding work rejects unknown pricing rather than
turning it into zero cost.

## Attachment preparation and derived evidence

Knowledge source versions may pin an immutable attachment-preparation policy with a
mode (`disabled`, `optional`, or `required`), policy version, and access-policy hash.
The attachment runtime supplies a structurally compatible, safe result: selected
derivative identities/content hashes, typed warnings, an order-independent identity
hash, and a retry signal. It does not supply a blob key, URL, locator, local path, or
secret through this port.

The active knowledge-item read model retains only a deterministic hash of that pinned
policy. Both fingerprint and normalized-content no-op checks compare this hash, so
adding, removing, or changing a source's immutable attachment policy creates a new
revision instead of silently retaining evidence prepared under a different policy.

Activation/store mutations retain a separate policy-free attachment result projection:
its status, identity hash, selected derivative identities, typed warning identities,
and retry state. They never retain the policy object; that object exists only in the
immutable source configuration selected for the run.

Ingestion normalizes the source document first, then prepares attachments before it
calculates the normalized-content hash. It never alters the normalizer's source text.
Instead, each successful canonical derivative becomes a dedicated immutable evidence
chunk, prefixed with its opaque occurrence/derivative identities and content hash. A
later completed derivative therefore creates a new knowledge revision while unchanged
source chunks can reuse their embeddings.

Optional preparation warnings retain source knowledge, mark the active item retryable,
and prevent an unchanged fingerprint from hiding future evidence. Required warnings
fail the revision closed. The attachment package owns byte streaming, cache claims,
processors, and vision metering; this package owns only the source-neutral consumer
port and chunk/revision semantics.
