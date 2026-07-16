# Application

**PBIs:** 002, 011, 012, 013

Owns vendor-neutral ports, opaque transaction boundaries, authorization contexts, and
the PBI-002 `BootstrapWorkspace`, `RequestAnalysis`, `ForceRerunAnalysis`,
`CancelAnalysisJob`, `RequestAnalysisWithPublication`, `ApprovePublication`,
`SchedulePublicationForCompletedAnalysis`, and `OutboxRelay` use cases. The relay
claims briefly, publishes outside the transaction, and acknowledges only after
publication.

PBI-013 additionally owns authorized, idempotent operational use cases for
dead-letter inspection/retry, cancellation, fenced expired-attempt recovery, exact
cost attribution queries, privacy purge, and retention work. An operator request
enqueues a bounded `retention.reap.v1` command; a worker then finds durable expired
work, emits purge commands, and performs fenced deletion. Deletion accepts only an
immutable `{ workspaceId, storageBackendId, key }` reference: historical key-only
records fail closed and are never mapped to a current backend. Mutations, reaping,
completion, audit, and durable outbox records share their respective transactions.

PBI-016 adds `RequestKnowledgeSourceSynchronization`: a source-owned,
provider-neutral use case for manual incremental synchronization and full
rescans. It authorizes `connector.manage`, resolves only an enabled workspace
source and its immutable source-plus-connector configuration version pair, and
commits the v2 outbox command, idempotency record, and audit event together. Manual
full rescans use a bounded persistence-enforced cooldown; connector configuration,
credentials, and connector I/O remain outside this package. Legacy pinless commands
are unavailable rather than being re-bound to a mutable connector configuration.

PBI-012's `StoredPublicationProfile` likewise carries the exact immutable destination
connector-configuration version selected when the profile was activated. The
application layer passes that pin unchanged to the publication store; it does not
resolve or substitute a mutable connector version.

The versioned analysis-trigger use cases accept a server-owned, opaque target request,
store the resolved immutable trigger/profile/connector pins, and atomically append an
`analysis.trigger.v2` command with its audit record. Automated ingress may provide the
exact trigger revision it discovered; a store must reject a mismatch rather than resolve
a mutable replacement. The separate capture use case owns lease/fence handling and
snapshot persistence coordination; trusted composition supplies normalized case
content privately. A capture may include opaque attachment references; PostgreSQL
resolves and appends only already completed, retention-active derivative identities in
the same new-snapshot transaction. Repeating a deduplicated snapshot never adds newer
attachment content. Once a snapshot is durable, `CaptureAndSubmitAnalysisTrigger`
obtains a transaction-bound submission from the trigger store and delegates to the
existing PBI-011 analysis-request workflow. That writes the analysis job,
`analysis.execute.v1` outbox command, audit event, idempotency record, and immutable
trigger-request-to-job link in one transaction. It does not register a worker or
resolve a connector. Legacy v1 trigger commands fail closed before any configuration
lookup.

This package depends only on domain/security contracts, never Prisma, pg-boss, HTTP, or
other concrete adapters.
