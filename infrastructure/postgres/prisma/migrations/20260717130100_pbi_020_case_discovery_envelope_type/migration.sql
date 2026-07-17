-- PBI-020 case-discovery commands are deliberately target-free.  The scheduler
-- owns only immutable configuration pins; the worker obtains the private cursor
-- and discovered target from the connector at execution time.
ALTER TABLE outbox_envelopes
  DROP CONSTRAINT outbox_envelopes_type_check,
  DROP CONSTRAINT outbox_envelopes_kind_type_check,
  ADD CONSTRAINT outbox_envelopes_type_check CHECK (type IN (
    'analysis.execute.v1','analysis.discover.v1','analysis.trigger.v1','analysis.trigger.v2',
    'publication.execute.v1','publication.reconcile.v1','analysis.completed.v1',
    'knowledge.synchronize.v1','knowledge.full-rescan.v1',
    'knowledge.synchronize.v2','knowledge.full-rescan.v2',
    'retention.reap.v1','retention.purge.v1','diagnostics.export.generate.v1'
  )),
  ADD CONSTRAINT outbox_envelopes_kind_type_check CHECK (
    (type = 'analysis.completed.v1' AND kind = 'domainEvent') OR
    (type <> 'analysis.completed.v1' AND kind = 'command')
  ),
  ADD CONSTRAINT outbox_analysis_discover_v1_payload_check CHECK (
    type <> 'analysis.discover.v1' OR
    (
      jsonb_typeof(payload) = 'object'
      AND jsonb_typeof(payload->'scheduleId') = 'string'
      AND jsonb_typeof(payload->'scheduleConfigurationVersionId') = 'string'
      AND jsonb_typeof(payload->'triggerId') = 'string'
      AND jsonb_typeof(payload->'triggerVersionId') = 'string'
      AND jsonb_typeof(payload->'connectorRegistrationId') = 'string'
      AND jsonb_typeof(payload->'connectorConfigurationVersionId') = 'string'
      AND jsonb_typeof(payload->'occurrenceKey') = 'string'
      AND NOT (payload ? 'cursor')
      AND NOT (payload ? 'target')
    )
  );
