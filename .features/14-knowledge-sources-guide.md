# Knowledge sources and ingestion implementation guide

## Purpose

Synchronize many independent knowledge sources without repeating downloads, attachment
processing, chunking, or embeddings for unchanged content.

## Source instance

Each configured source has:

- workspace and connector instance,
- capability/configuration version,
- target knowledge collection,
- filters and access policy,
- synchronization policy,
- cursor and last completed scan,
- normalization/chunking profile versions,
- and enabled/disabled state.

Schedules belong to the source instance, not the connector implementation.

## Discovery contract

Discovery returns lightweight records before full content:

```ts
type DiscoveryMode = "snapshot" | "delta";

interface DiscoveredItem {
  reference: ExternalReference;
  externalFingerprint?: string;
  observedAt: Instant;
  change: "upsert" | "delete";
}
```

- Fingerprints are opaque connector values: Git blob OID, ETag, version, update sequence,
  or checksum.
- Discovery never invokes AI.
- Snapshot pages share a stable scan epoch and explicit completion.
- Delta feeds delete only through explicit tombstones.

## No-op decision pipeline

For each discovered upsert:

1. If fingerprint equals the last successful observation, stop.
2. Otherwise load the source item.
3. Normalize deterministically and calculate normalized content hash.
4. If normalized hash is unchanged, record the new observation and stop.
5. Process only changed/new attachments.
6. Chunk with a versioned deterministic profile.
7. Reuse embeddings by chunk hash, immutable embedding binding, dimensions,
   normalization version, and embedding profile.
8. Generate embeddings only for cache misses.
9. Atomically activate the revision and update cursor/scan state.

Changing only a title, timestamp, API revision, or irrelevant metadata must not force
embedding when normalized searchable content is identical.

## Revisions and deletion

- Last successful active revision remains searchable until replacement fully succeeds.
- Incomplete snapshots cannot delete absent items.
- Successful snapshot completion reconciles missing items in the same final transaction.
- Delta tombstones deactivate the item without deleting audit history immediately.
- Cursor advancement, activation, and eligible deletion commit atomically.

## Chunking

- Profiles are source-aware and immutable versions.
- Stable content should produce stable chunk hashes.
- Markdown preserves headings, code blocks, lists, and anchors.
- Cases preserve ordered authorship, visibility, problem, investigation, and resolution.
- Chunks retain source URL and revision provenance.

## Embedding collections

A collection has one immutable embedding binding and dimensions. Multiple collections
may use different providers/models. Never compare vectors from incompatible spaces.

## Failure behavior

Item failures are recorded and classified. Policy decides whether a synchronization can
complete with item failures. A cursor must not skip work that was not safely recorded.

## Minimum tests

- Unchanged fingerprint performs no load or AI call.
- Changed fingerprint with unchanged normalized hash performs no embedding.
- One changed chunk embeds only that chunk.
- Failed replacement leaves the old revision active.
- Incomplete snapshot neither deletes nor advances.
- Delta tombstone deactivates exactly one item.
- Embedding binding change creates a new vector space.
