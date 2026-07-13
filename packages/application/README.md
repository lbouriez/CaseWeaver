# Application

**PBIs:** 002, 011, 012, 013

Use-case interfaces, commands, queries, transaction boundaries, authorization checks,
repository/queue/clock/secret ports, inbox/outbox contracts, and orchestration contracts.

Owns the outbox relay application service. The relay claims committed envelopes through
`OutboxStore`, publishes typed command/domain-event envelopes through
`DurableMessageQueue`, and marks delivery idempotently.

May depend on domain and SDK contracts. Must not depend on concrete adapters.
