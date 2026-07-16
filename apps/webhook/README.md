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

PBI-016's `PersistedWebhookEndpointResolver` composes the active-only administration
endpoint projection into this transport. It retains the immutable endpoint configuration
version for inbox history and passes the separate immutable connector configuration
version, workspace, connector, and verified-event-type identities to a trusted adapter
resolver; settings and secret locators stay outside the public app. It enforces the
endpoint's persisted raw-body maximum and database-time rate admission before adapter
verification or inbox persistence. An absent, disabled, legacy-unpinned, or unresolvable
endpoint is indistinguishable from a public 404.

Verified events are stored in an inbox and commands in an outbox in one PostgreSQL
transaction. A relay delivers outbox commands to the durable queue.

For configured analysis triggers, the store accepts work only when the endpoint's
retained connector configuration exactly matches the active immutable trigger version
and the server-owned activation principal is present. It atomically retains the v2
trigger request, idempotency record, audit event, and `analysis.trigger.v2` outbox
envelope; a legacy or mismatched route fails closed without retaining an inbox row.

`caseweaver-webhook start` composes that persisted ingress and endpoint/rate-limit
projection from `DATABASE_URL`, with `WEBHOOK_HOST` (default `0.0.0.0`),
`WEBHOOK_PORT` (default `8081`), and `WEBHOOK_MAXIMUM_BODY_BYTES` (default 1 MiB,
maximum 10 MiB). It uses an explicit empty webhook-adapter registry until a connector
contribution actually declares a webhook capability: configured endpoints without one
remain public 404s, not permissive or mutable fallbacks. Readiness performs only a
bounded database transaction probe; shutdown closes HTTP admission before its database
client.
