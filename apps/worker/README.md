# Worker application

**PBIs:** 001, 002, 004, 008, 009, 010, 011, 012, 013

Executes durable commands through application use cases. Hosts synchronization,
attachment, embedding, retrieval, repository-agent, analysis, and publication handlers.

The worker owns retries and heartbeats but delegates policy to reusable packages.

Hosts the application-layer outbox relay in distributed mode. Multiple replicas safely
claim envelopes without duplicate effects.
