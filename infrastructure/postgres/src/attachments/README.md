# Attachment PostgreSQL persistence

`PostgresAttachmentRepository` persists workspace-scoped attachment references, blobs,
derivative cache claims, failure history, and AI operation attribution. Every new blob
or derivative output records its opaque deployment `storage_backend_id` with its key;
legacy key-only metadata is never rebound to a current backend.

It does not claim or delete expired storage itself. PBI-013 owns one canonical durable
retention-work lifecycle in `PostgresOperationsStore`: reference expiry is metadata-only,
then independently fenced object work carries the exact `{ workspaceId,
storageBackendId, key }` tuple to the configured object-storage bridge. This avoids a
second unaudited cleanup path in attachment persistence.

AI operation IDs stay opaque because the PBI-003 ledger has no guaranteed
foreign-key composition here; derivative-source queries expose that attribution with
the source job instead.

Completed derivatives retain the verifier-derived SHA-256 and exact byte length of
canonical UTF-8 output. `findDerivativeEvidenceRecord` is a server-private, typed
lookup for the exact workspace/attachment/derivative association; it returns no
external reference, URL, or secret and fails closed for deleted, legacy, malformed, or
unlinked records. Object bytes are still re-verified by `attachment-runtime` before
they become analysis evidence.

PBI-008 exports composition only. It deliberately does not register a worker command:
PBI-011/PBI-012 must define the durable analysis/source-job command contract that
provides attachment and source-job attribution.
