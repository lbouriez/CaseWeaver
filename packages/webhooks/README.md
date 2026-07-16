# Webhooks

**PBIs:** 006, 012

Webhook routing policy, verified-event normalization, replay/idempotency rules, and
translation from connector events to application commands.

Raw signature verification is delegated to the configured connector adapter.

The package accepts a server-resolved webhook endpoint context and exact raw request. It
must not route from untrusted vendor/workspace identifiers. Verified-event idempotency
and inbox/outbox command creation are one application transaction.

When an endpoint is configured to request analysis, its trusted route also carries the
server-owned principal captured at activation. That identity is copied only into the
internal verified event for attributable automated work; it is never read from headers
or payloads and must not appear in public endpoint metadata, browser state, or logs.
