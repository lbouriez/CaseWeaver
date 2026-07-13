# Webhooks

**PBIs:** 006, 012

Webhook routing policy, verified-event normalization, replay/idempotency rules, and
translation from connector events to application commands.

Raw signature verification is delegated to the configured connector adapter.

The package accepts a server-resolved webhook endpoint context and exact raw request. It
must not route from untrusted vendor/workspace identifiers. Verified-event idempotency
and inbox/outbox command creation are one application transaction.
