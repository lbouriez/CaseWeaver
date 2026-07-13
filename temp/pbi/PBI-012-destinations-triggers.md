# PBI-012: Destinations, triggers, and publication

## Outcome

Operate analyses manually or automatically and safely publish through destinations.

## Scope

- Authorized manual API and CLI triggers.
- Cron schedules and connector polling.
- Verified webhook endpoint and event translation.
- Preview-only, approval-required, and auto-publish-internal policies.
- Authorized approval API with actor audit.
- Publication renderer, stable marker, database uniqueness constraint, and lease.
- Idempotent Jitbit internal-note publication.
- Independent publication retries, receipts, and `outcome_unknown` reconciliation.

## Acceptance criteria

- All triggers use the same command, authorization, budgets, and policies.
- Duplicate webhook delivery does not duplicate analysis or publication.
- A remote-success/local-timeout enters reconciliation before another write.
- Concurrent publishers cannot acquire the same publication identity.
- Dry-run does not suppress a later approved publication.
- Customer-visible publishing is unavailable by default.

## Excluded

Additional destination connectors and UI approval screens.
