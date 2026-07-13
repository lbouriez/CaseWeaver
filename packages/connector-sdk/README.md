# Connector SDK

**PBI:** 006

Contracts and conformance tooling for `KnowledgeSource`, `CaseSource`,
`AttachmentSource`, `AnalysisDestination`, and `WebhookAdapter`.

Owns normalized boundary schemas, cursors, fingerprints, pagination, cancellation,
rate-limit metadata, connector errors, and contract-test helpers.

Knowledge discovery declares snapshot/delta mode. Snapshot pages share a stable scan
epoch and completion marker; delta discovery carries explicit upsert/tombstone events.
