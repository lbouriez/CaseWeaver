-- PBI-013 durability remediation: knowledge schedules originally wrote an isolated
-- command table that no relay consumed. Pending historical occurrences must enter the
-- same append-only outbox used by every other durable command before new scheduler
-- writes are switched to that path.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM knowledge_schedule_commands command
    WHERE command.delivered_at IS NULL
      AND (
        command.payload ->> 'sourceId' IS NULL
        OR command.payload ->> 'configurationVersion' IS NULL
      )
  ) THEN
    RAISE EXCEPTION
      'Pending legacy knowledge schedule command has an invalid durable payload.';
  END IF;
END
$$;

WITH pending_commands AS (
  SELECT
    command.*,
    occurrence.knowledge_schedule_id,
    md5('caseweaver.legacy-knowledge-schedule-outbox.v1:' || command.id) AS id_digest
  FROM knowledge_schedule_commands command
  JOIN knowledge_schedule_occurrences occurrence
    ON occurrence.workspace_id = command.workspace_id
   AND occurrence.id = command.knowledge_schedule_occurrence_id
  WHERE command.delivered_at IS NULL
)
INSERT INTO outbox_envelopes (
  id,
  workspace_id,
  kind,
  type,
  schema_version,
  occurred_at,
  correlation_id,
  causation_id,
  payload,
  available_at
)
SELECT
  substr(id_digest, 1, 8) || '-' ||
  substr(id_digest, 9, 4) || '-5' ||
  substr(id_digest, 14, 3) || '-8' ||
  substr(id_digest, 18, 3) || '-' ||
  substr(id_digest, 21, 12),
  command.workspace_id,
  'command',
  command.command_type,
  1,
  command.created_at,
  'schedule:' || command.knowledge_schedule_id || ':' || command.idempotency_key,
  'schedule:' || command.knowledge_schedule_id || ':' || command.idempotency_key,
  jsonb_build_object(
    'sourceId', command.payload ->> 'sourceId',
    'configurationVersion', command.payload ->> 'configurationVersion',
    'trigger', 'schedule'
  ),
  command.created_at
FROM pending_commands command
ON CONFLICT (id) DO NOTHING;
