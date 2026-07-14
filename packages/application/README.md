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
cost attribution queries, privacy purge, and retention work queuing. Each mutation
commits its audit and durable outbox records in the same transaction.

This package depends only on domain/security contracts, never Prisma, pg-boss, HTTP, or
other concrete adapters.
