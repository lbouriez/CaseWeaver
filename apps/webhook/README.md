# Webhook application

**PBIs:** 006, 007, 012

Public HTTP ingress for connector webhooks. Resolve connector instance, verify the raw
request through `WebhookAdapter`, translate it to domain events/commands, persist
idempotency, enqueue, and respond quickly.

No AI calls, attachment downloads, source synchronization, analysis, or publication are
allowed in the request process.

Routing uses a server-generated opaque endpoint ID mapped server-side to workspace,
connector instance, adapter type, and secret reference. Request body/header values never
select the adapter before verification. Preserve exact raw bytes for signature
verification and reject before normalization when verification fails.

Verified events are stored in an inbox and commands in an outbox in one PostgreSQL
transaction. A relay delivers outbox commands to the durable queue.
