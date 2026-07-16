# Versioned analysis trigger persistence

This folder implements the PostgreSQL side of durable analysis-trigger requests
and their fenced case-snapshot capture. It is intentionally not a connector
adapter and does not resolve configuration settings, secret locators, source
URLs, or clients.

`PostgresAnalysisTriggerRequestStore` resolves an active immutable trigger
revision when a server-owned request is accepted, records the exact profile and
connector configuration version pins, and deduplicates by workspace-scoped
idempotency digest. Automated ingress can require the exact revision it discovered;
a mismatch is unavailable rather than rebound to a current revision. Capture is
claimed with database time and a monotonic fence; only that current claim can persist
the normalized immutable snapshot. A repeated capture result includes its exact durable
request so downstream work retains the profile and connector pins. Repeated snapshot
content is deduplicated under the normalized connector target. Only the transaction
that creates a snapshot can append its attachment evidence: opaque references from the
capture resolve to completed, retention-active, verified derivatives and are stored
with their processor version and output digest. A later upload, retry, or derivative
cannot mutate an existing snapshot's evidence set.

After capture, `prepareAnalysisSubmission` reads only the retained active snapshot,
trigger/profile revision, descriptor, and exact connector pin to derive the existing
PBI-011 analysis-request identity. `bindAnalysisJob` appends a single immutable
request-to-analysis-job relationship. The database verifies the captured snapshot and
profile before accepting that relationship, rejects later changes/deletes, and lets the
caller commit it with the PBI-011 job, outbox, idempotency, and audit records.

Legacy `analysis.trigger.v1` records are deliberately not resolved here. Their
consumer classifies them as unavailable instead of substituting a mutable
configuration. Trusted outer composition may provide normalized capture content,
but worker registration and connector runtime resolution belong outside this
folder.
