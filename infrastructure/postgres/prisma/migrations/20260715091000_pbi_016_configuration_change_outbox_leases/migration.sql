-- Cache invalidation relays may run on multiple replicas. Claims are fenced by a
-- random token and lease, so an unacknowledged change is retried after a restart.
ALTER TABLE administration_configuration_change_outbox
  ADD COLUMN claim_token text,
  ADD COLUMN claimed_until timestamptz,
  ADD COLUMN claim_attempts integer NOT NULL DEFAULT 0;

DROP INDEX administration_configuration_change_outbox_pending_idx;
CREATE INDEX administration_configuration_change_outbox_pending_idx
  ON administration_configuration_change_outbox (published_at, claimed_until, created_at);
