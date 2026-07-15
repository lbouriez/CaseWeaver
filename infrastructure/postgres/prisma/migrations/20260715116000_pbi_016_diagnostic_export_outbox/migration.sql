ALTER TABLE outbox_envelopes
  DROP CONSTRAINT outbox_envelopes_type_check,
  DROP CONSTRAINT outbox_envelopes_kind_type_check,
  ADD CONSTRAINT outbox_envelopes_type_check
    CHECK (
      type IN (
        'analysis.execute.v1',
        'analysis.trigger.v1',
        'publication.execute.v1',
        'publication.reconcile.v1',
        'analysis.completed.v1',
        'knowledge.synchronize.v1',
        'knowledge.full-rescan.v1',
        'retention.reap.v1',
        'retention.purge.v1',
        'diagnostics.export.generate.v1'
      )
    ),
  ADD CONSTRAINT outbox_envelopes_kind_type_check
    CHECK (
      (type = 'analysis.completed.v1' AND kind = 'domainEvent')
      OR (
        type IN (
          'analysis.execute.v1',
          'analysis.trigger.v1',
          'publication.execute.v1',
          'publication.reconcile.v1',
          'knowledge.synchronize.v1',
          'knowledge.full-rescan.v1',
          'retention.reap.v1',
          'retention.purge.v1',
          'diagnostics.export.generate.v1'
        )
        AND kind = 'command'
      )
    );
