# Attachment PostgreSQL persistence

`PostgresAttachmentRepository` persists workspace-scoped attachment references, blobs,
derivative cache claims, failure history, AI operation attribution, and retention
cleanup claims. It returns opaque storage keys for outer cleanup and never deletes
storage bytes.

AI operation IDs stay opaque because the PBI-003 ledger has no guaranteed
foreign-key composition here; derivative-source queries expose that attribution with
the source job instead.

PBI-008 exports composition only. It deliberately does not register a worker command:
PBI-011/PBI-012 must define the durable analysis/source-job command contract that
provides attachment and source-job attribution.
