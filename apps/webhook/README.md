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
endpoint projection into this transport. It passes only immutable workspace, connector,
configuration-version, and verified-event-type identities to a trusted adapter resolver;
settings and secret locators stay outside the public app. It enforces the endpoint's
persisted raw-body maximum and database-time rate admission before adapter verification
or inbox persistence. An absent, disabled, or unresolvable endpoint is indistinguishable
from a public 404.

Verified events are stored in an inbox and commands in an outbox in one PostgreSQL
transaction. A relay delivers outbox commands to the durable queue.
