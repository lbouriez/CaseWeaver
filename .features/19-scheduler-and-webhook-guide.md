# Scheduler and webhook implementation guide

## Purpose

Convert time and external events into durable commands without executing expensive work
inside ingress processes.

## Scheduler

The scheduler supports separate schedule types:

- knowledge-source synchronization,
- periodic full source rescan,
- case discovery/polling,
- optional recurring maintenance.

A schedule contains immutable target/configuration references, timezone, cron or interval,
jitter, overlap policy, enabled state, and next-run state.

Scheduler loop:

1. Query due schedules.
2. Acquire a short schedule lease.
3. Recalculate due time with timezone/DST rules.
4. Create deterministic command/idempotency key for the occurrence.
5. Persist schedule occurrence and command outbox atomically.
6. Advance next-run state.
7. Release lease.

The scheduler never calls connectors, AI, attachment processors, or analysis directly.
Multiple scheduler replicas must not duplicate an occurrence.

## Webhook ingress

Public route format contains only an opaque server-generated endpoint ID. Server-side
configuration resolves workspace, connector, adapter, secret reference, limits, and
enabled state.

Processing:

1. Enforce request size and transport limits.
2. Preserve exact raw body and relevant headers.
3. Resolve endpoint context from opaque ID.
4. Invoke connector verification before parsing trusted content.
5. Normalize verified event.
6. Persist webhook inbox/idempotency and command outbox atomically.
7. Return quickly; an outbox relay handles queue delivery.

Do not trust vendor/workspace IDs from body or headers for routing. Do not download
attachments or make AI calls in the HTTP request.

The relay is an application service hosted by worker and standalone lifecycles. It uses
injected `OutboxStore` and `DurableMessageQueue` ports. Typed queue envelopes distinguish
commands from domain events, including `AnalysisCompleted`. PostgreSQL and queue adapters
do not call each other. Multi-replica claiming must be safe and idempotent.

## Event translation

Verified events translate to commands such as:

- synchronize one knowledge item/source,
- discover or analyze one case,
- reconcile a publication,
- or ignore with an audited reason.

Webhook and polling must generate equivalent command identities for the same case/source
revision.

## Failure and replay

- Verification failure creates no command.
- Duplicate verified delivery returns the prior acceptance outcome.
- Persisted inbox without queue delivery is recovered by outbox relay.
- Handler failures are worker job failures, not webhook retries.
- Operators may replay verified inbox entries through an authorized command.

## Minimum tests

- DST/timezone and deterministic occurrence keys.
- Concurrent scheduler lease.
- Disabled/overlap behavior.
- Opaque route cannot be overridden by body/header.
- Raw-byte signature verification.
- Duplicate webhook idempotency.
- Crash-safe inbox/outbox relay.
- Webhook response does not wait for worker execution.
