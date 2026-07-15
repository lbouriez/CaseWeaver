# Worker application

**PBIs:** 001, 002, 004, 008, 009, 010, 011, 012, 013, 016

Executes durable commands through application use cases. Hosts synchronization,
attachment, embedding, retrieval, repository-agent, analysis, and publication handlers.

The worker owns retries and heartbeats but delegates policy to reusable packages.

Hosts the application-layer outbox relay in distributed mode. Multiple replicas safely
claim envelopes without duplicate effects.

PBI-013 registers durable retention-purge envelopes only. The injected service claims a
fenced work item before idempotently deleting the referenced object and marking its
metadata deleted.

PBI-016 adds an injected `diagnostics.export.generate.v1` handler. It receives only an
opaque export ID and workspace ID, claims a bounded export, serializes already-redacted
audit-safe events, and writes server-private artifact bytes. Periodic maintenance
expires and deletes artifacts through the same bounded lifecycle; neither command nor
handler receives storage URLs, secret values, or browser input.
