# PBI-012: Destinations, triggers, and publication

## Outcome

Operate analyses manually or automatically and safely publish through destinations.

## Delivery status

**Completed.** Publication profiles, intents, and attempts pin the exact destination
connector configuration version. Legacy work without that proof fails closed. The
provider-neutral authorized `analysis.trigger.v1` consumer creates or reuses the correct
immutable analysis request, and descriptor-driven destination contributions execute
through the production worker.

PostgreSQL integration and worker composition coverage exercise trigger/publication
recovery without replacing the feature-owned policy with host logic.

## Scope

- Authorized manual API and CLI triggers.
- Cron schedules and connector polling.
- Verified webhook endpoint and event translation.
- Opaque webhook endpoint routing and atomic verified-event inbox/outbox persistence.
- Preview-only, approval-required, and auto-publish-internal policies.
- Versioned publication profiles selecting destination, renderer, notices, visibility,
  and destination limits.
- Durable publication intents created atomically with analysis request resolution and
  command outbox creation.
- Idempotent `AnalysisCompleted` consumer that enqueues eligible publication commands.
- Authorized approval API with actor audit.
- Publication renderer, stable marker, database uniqueness constraint, and lease.
- Idempotent Jitbit internal-note publication.
- Independent publication retries, receipts, and `outcome_unknown` reconciliation.

## Acceptance criteria

- All triggers use the same command, authorization, budgets, and policies.
- Duplicate webhook delivery does not duplicate analysis or publication.
- A remote-success/local-timeout enters reconciliation before another write.
- A crash between webhook persistence and queue delivery cannot lose the command.
- Concurrent publishers cannot acquire the same publication identity.
- Dry-run does not suppress a later approved publication.
- Customer-visible publishing is unavailable by default.
- Analysis completion remains destination-neutral and does not render or publish.
- Auto-publication survives worker restart between analysis completion and publication.
- Creating an intent for an already-completed deduplicated analysis immediately schedules
  publication, and reconciliation finds any pending ready intent.

## Excluded

Additional destination connectors and UI approval screens.
