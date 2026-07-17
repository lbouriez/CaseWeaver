import {
  KnowledgeExecutionFenceError,
  type KnowledgeSourceExecutionLease,
  type KnowledgeSourceExecutionStore,
  type PinnedKnowledgeSourceConfiguration,
  type PinnedKnowledgeSourceConfigurationResolver,
  type SourceSynchronizationPolicy,
} from "@caseweaver/knowledge";
import type { Pool, QueryResultRow } from "pg";

interface RuntimeRow extends QueryResultRow {
  readonly workspace_id: string;
  readonly source_id: string;
  readonly source_configuration_version_id: string;
  readonly connector_configuration_version_id: string;
  readonly connector_registration_id: string;
  readonly knowledge_collection_id: string | null;
  readonly collection_runtime_version_id: string | null;
  readonly normalization_profile_id: string | null;
  readonly normalization_profile_version: string | null;
  readonly chunking_profile_id: string | null;
  readonly chunking_profile_version: string | null;
  readonly synchronization_policy: unknown;
  readonly embedding_batch_size: number | null;
  readonly attachment_stage_mode: string | null;
  readonly attachment_policy_configuration_version_id: string | null;
  readonly attachment_access_policy_hash: string | null;
  readonly embedding_binding_version_id: string;
  readonly embedding_profile_version: string;
  readonly dimensions: number;
  readonly maximum_input_tokens: number;
  readonly budget_currency: string;
  readonly budget_hard: boolean;
  readonly budget_policy_reference: string | null;
}

interface LeaseRow extends QueryResultRow {
  readonly cursor_version: string | null;
  readonly cursor_value: string | null;
  readonly execution_fence: string;
  readonly execution_lease_expires_at: Date;
}

/**
 * Returns only a safe source-neutral runtime record. Connector descriptor
 * settings and secret locators remain behind RuntimeConnectorConfigurationResolver.
 */
export class PostgresPinnedKnowledgeSourceConfigurationResolver
  implements PinnedKnowledgeSourceConfigurationResolver
{
  public constructor(private readonly pool: Pool) {}

  public async resolve(
    input: Parameters<PinnedKnowledgeSourceConfigurationResolver["resolve"]>[0],
  ): Promise<PinnedKnowledgeSourceConfiguration | undefined> {
    const result = await this.pool.query<RuntimeRow>(
      `SELECT
         source.workspace_id,
         source.id AS source_id,
         runtime.source_configuration_version_id,
         runtime.connector_configuration_version_id,
         runtime.connector_registration_id,
         runtime.knowledge_collection_id,
         runtime.collection_runtime_version_id,
         runtime.normalization_profile_id,
         runtime.normalization_profile_version,
         runtime.chunking_profile_id,
         runtime.chunking_profile_version,
         runtime.synchronization_policy,
         runtime.embedding_batch_size,
         runtime.attachment_stage_mode,
         runtime.attachment_policy_configuration_version_id,
         runtime.attachment_access_policy_hash,
         collection_runtime.embedding_binding_version_id,
         collection_runtime.embedding_profile_version,
         collection_runtime.dimensions,
         collection_runtime.maximum_input_tokens,
         collection_runtime.budget_currency,
         collection_runtime.budget_hard,
         collection_runtime.budget_policy_reference
       FROM knowledge_sources AS source
       INNER JOIN knowledge_source_runtime_versions AS runtime
         ON runtime.workspace_id = source.workspace_id
        AND runtime.knowledge_source_id = source.id
        AND runtime.source_configuration_version_id = $3
        AND runtime.connector_configuration_version_id = $4
       INNER JOIN knowledge_collection_runtime_versions AS collection_runtime
         ON collection_runtime.workspace_id = runtime.workspace_id
        AND collection_runtime.id = runtime.collection_runtime_version_id
        AND collection_runtime.knowledge_collection_id = runtime.knowledge_collection_id
       INNER JOIN administration_configurations AS source_configuration
         ON source_configuration.workspace_id = source.workspace_id
        AND source_configuration.id = source.id
        AND source_configuration.resource_type = 'knowledge-sources'
        AND source_configuration.lifecycle = 'active'
       INNER JOIN administration_configuration_versions AS source_version
         ON source_version.workspace_id = source_configuration.workspace_id
        AND source_version.id = runtime.source_configuration_version_id
        AND source_version.configuration_id = source_configuration.id
       INNER JOIN connector_registrations AS connector
         ON connector.workspace_id = runtime.workspace_id
        AND connector.id = runtime.connector_registration_id
        AND connector.lifecycle = 'active'
       INNER JOIN connector_capabilities AS capability
         ON capability.workspace_id = connector.workspace_id
        AND capability.connector_registration_id = connector.id
        AND capability.capability = 'knowledgeSource'
       INNER JOIN administration_configurations AS connector_configuration
         ON connector_configuration.workspace_id = connector.workspace_id
        AND connector_configuration.id = connector.id
        AND connector_configuration.resource_type = 'connector-instances'
        AND connector_configuration.lifecycle = 'active'
       INNER JOIN administration_configuration_versions AS connector_version
         ON connector_version.workspace_id = connector_configuration.workspace_id
        AND connector_version.id = runtime.connector_configuration_version_id
        AND connector_version.configuration_id = connector_configuration.id
        AND connector_version.descriptor_kind = 'connector'
       WHERE source.workspace_id = $1
         AND source.id = $2
         AND source.lifecycle = 'enabled'`,
      [
        input.workspaceId,
        input.sourceId,
        input.sourceConfigurationVersionId,
        input.connectorConfigurationVersionId,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return toPinnedRuntime(row);
  }
}

/**
 * Database-time source fence. Claim returns the current cursor in the same
 * atomic update, and final ingestion commit verifies the returned fence.
 */
export class PostgresKnowledgeSourceExecutionStore
  implements KnowledgeSourceExecutionStore
{
  public constructor(private readonly pool: Pool) {}

  public async claim(
    input: Parameters<KnowledgeSourceExecutionStore["claim"]>[0],
  ): Promise<KnowledgeSourceExecutionLease | undefined> {
    assertLeaseMs(input.leaseMs);
    const result = await this.pool.query<LeaseRow>(
      `WITH ensured AS (
         INSERT INTO knowledge_source_states (workspace_id, knowledge_source_id)
         VALUES ($1, $2)
         ON CONFLICT (workspace_id, knowledge_source_id) DO NOTHING
       ), claimed AS (
         UPDATE knowledge_source_states
            SET execution_fence = execution_fence + 1,
                execution_lease_expires_at = NOW() + ($3::bigint * interval '1 millisecond'),
                last_execution_mode = $4,
                updated_at = NOW()
          WHERE workspace_id = $1
            AND knowledge_source_id = $2
            AND (execution_lease_expires_at IS NULL OR execution_lease_expires_at <= NOW())
          RETURNING cursor_version, cursor_value, execution_fence, execution_lease_expires_at
       ) SELECT * FROM claimed`,
      [input.workspaceId, input.sourceId, input.leaseMs, input.mode],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    if ((row.cursor_version === null) !== (row.cursor_value === null)) {
      throw new KnowledgeExecutionFenceError();
    }
    return Object.freeze({
      fence: Object.freeze({ value: row.execution_fence }),
      ...(row.cursor_version === null || row.cursor_value === null
        ? {}
        : {
            cursor: Object.freeze({
              version: row.cursor_version,
              value: row.cursor_value,
            }),
          }),
      expiresAt: row.execution_lease_expires_at.toISOString(),
    });
  }

  public async renew(
    input: Parameters<KnowledgeSourceExecutionStore["renew"]>[0],
  ): Promise<boolean> {
    assertLeaseMs(input.leaseMs);
    const result = await this.pool.query(
      `UPDATE knowledge_source_states
          SET execution_lease_expires_at = NOW() + ($4::bigint * interval '1 millisecond'),
              updated_at = NOW()
        WHERE workspace_id = $1
          AND knowledge_source_id = $2
          AND execution_fence = $3::bigint
          AND execution_lease_expires_at > NOW()`,
      [
        input.workspaceId,
        input.sourceId,
        fenceValue(input.fence.value),
        input.leaseMs,
      ],
    );
    return result.rowCount === 1;
  }

  public async cancel(
    input: Parameters<KnowledgeSourceExecutionStore["cancel"]>[0],
  ): Promise<void> {
    await this.pool.query(
      `UPDATE knowledge_source_states
          SET execution_lease_expires_at = NOW(), updated_at = NOW()
        WHERE workspace_id = $1
          AND knowledge_source_id = $2
          AND execution_fence = $3::bigint`,
      [input.workspaceId, input.sourceId, fenceValue(input.fence.value)],
    );
  }
}

function toPinnedRuntime(
  row: RuntimeRow,
): PinnedKnowledgeSourceConfiguration | undefined {
  if (
    row.knowledge_collection_id === null ||
    row.collection_runtime_version_id === null ||
    row.normalization_profile_id === null ||
    row.normalization_profile_version === null ||
    row.chunking_profile_id === null ||
    row.chunking_profile_version === null ||
    row.embedding_batch_size === null ||
    !isIdentifier(row.knowledge_collection_id) ||
    !isIdentifier(row.collection_runtime_version_id) ||
    !isIdentifier(row.normalization_profile_id) ||
    !isIdentifier(row.normalization_profile_version) ||
    !isIdentifier(row.chunking_profile_id) ||
    !isIdentifier(row.chunking_profile_version) ||
    !isIdentifier(row.connector_registration_id) ||
    !isIdentifier(row.embedding_binding_version_id) ||
    !isIdentifier(row.embedding_profile_version) ||
    !isIdentifier(row.source_configuration_version_id) ||
    !isIdentifier(row.connector_configuration_version_id) ||
    !Number.isSafeInteger(row.embedding_batch_size) ||
    row.embedding_batch_size < 1 ||
    !Number.isSafeInteger(row.dimensions) ||
    row.dimensions < 1 ||
    !Number.isSafeInteger(row.maximum_input_tokens) ||
    row.maximum_input_tokens < 1 ||
    !/^[A-Z]{3}$/u.test(row.budget_currency) ||
    (row.budget_hard && row.budget_policy_reference === null) ||
    (row.budget_policy_reference !== null &&
      !isIdentifier(row.budget_policy_reference))
  ) {
    return undefined;
  }
  const synchronization = parseSynchronizationPolicy(
    row.synchronization_policy,
  );
  if (synchronization === undefined) return undefined;
  if (
    (row.attachment_stage_mode === null ||
      row.attachment_stage_mode === "disabled") &&
    (row.attachment_policy_configuration_version_id !== null ||
      row.attachment_access_policy_hash !== null)
  ) {
    return undefined;
  }
  const attachmentPreparation = pinnedAttachmentPreparation(row);
  if (
    attachmentPreparation === undefined &&
    row.attachment_stage_mode !== "disabled" &&
    row.attachment_stage_mode !== null
  ) {
    return undefined;
  }
  return Object.freeze({
    workspaceId: row.workspace_id,
    sourceId: row.source_id,
    sourceConfigurationVersionId: row.source_configuration_version_id,
    connectorConfigurationVersionId: row.connector_configuration_version_id,
    connectorRegistrationId: row.connector_registration_id,
    collection: Object.freeze({
      id: row.knowledge_collection_id,
      runtimeVersionId: row.collection_runtime_version_id,
      embeddingBindingVersionId: row.embedding_binding_version_id,
      embeddingProfileVersion: row.embedding_profile_version,
      dimensions: row.dimensions,
      maximumInputTokens: row.maximum_input_tokens,
      budget: Object.freeze({
        currency: row.budget_currency,
        hard: row.budget_hard,
        ...(row.budget_policy_reference === null
          ? {}
          : { policyReference: row.budget_policy_reference }),
      }),
    }),
    normalizationProfile: Object.freeze({
      id: row.normalization_profile_id,
      version: row.normalization_profile_version,
    }),
    chunkingProfile: Object.freeze({
      id: row.chunking_profile_id,
      version: row.chunking_profile_version,
    }),
    synchronization,
    embeddingBatchSize: row.embedding_batch_size,
    ...(attachmentPreparation === undefined ? {} : { attachmentPreparation }),
  });
}

/** Legacy rows are deliberately treated as no-attachment configurations. */
function pinnedAttachmentPreparation(row: RuntimeRow):
  | Readonly<{
      readonly mode: "optional" | "required";
      readonly policyVersion: string;
      readonly accessPolicyHash: string;
    }>
  | undefined {
  if (row.attachment_stage_mode === null) {
    return undefined;
  }
  if (row.attachment_stage_mode === "disabled") {
    return undefined;
  }
  if (
    (row.attachment_stage_mode !== "optional" &&
      row.attachment_stage_mode !== "required") ||
    row.attachment_policy_configuration_version_id === null ||
    row.attachment_access_policy_hash === null ||
    !isIdentifier(row.attachment_policy_configuration_version_id) ||
    !/^[a-f0-9]{64}$/u.test(row.attachment_access_policy_hash)
  ) {
    return undefined;
  }
  return Object.freeze({
    mode: row.attachment_stage_mode,
    policyVersion: row.attachment_policy_configuration_version_id,
    accessPolicyHash: row.attachment_access_policy_hash,
  });
}

function parseSynchronizationPolicy(
  value: unknown,
): SourceSynchronizationPolicy | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const policy = value as Readonly<Record<string, unknown>>;
  if (
    !Array.isArray(policy.triggers) ||
    policy.triggers.length < 1 ||
    policy.triggers.length > 20
  ) {
    return undefined;
  }
  const triggers: SourceSynchronizationPolicy["triggers"][number][] = [];
  for (const candidate of policy.triggers) {
    const trigger = parseSynchronizationTrigger(candidate);
    if (trigger === undefined) return undefined;
    triggers.push(trigger);
  }
  const rescanInterval = policy.periodicFullRescanIntervalMs;
  if (
    rescanInterval !== undefined &&
    (typeof rescanInterval !== "number" ||
      !Number.isSafeInteger(rescanInterval) ||
      rescanInterval < 1)
  ) {
    return undefined;
  }
  return Object.freeze({
    triggers: Object.freeze(triggers),
    ...(typeof rescanInterval !== "number"
      ? {}
      : { periodicFullRescanIntervalMs: rescanInterval }),
  });
}

function parseSynchronizationTrigger(
  value: unknown,
): SourceSynchronizationPolicy["triggers"][number] | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const trigger = value as Readonly<Record<string, unknown>>;
  if (trigger.mode === "manual" || trigger.mode === "webhook") {
    return Object.freeze({ mode: trigger.mode });
  }
  if (
    trigger.mode === "cron" &&
    isBoundedText(trigger.expression, 500) &&
    isBoundedText(trigger.timezone, 100) &&
    isOverlapPolicy(trigger.overlapPolicy) &&
    isDuration(trigger.maximumDurationMs) &&
    isOptionalJitter(trigger.jitterMs)
  ) {
    return Object.freeze({
      mode: "cron",
      expression: trigger.expression,
      timezone: trigger.timezone,
      overlapPolicy: trigger.overlapPolicy,
      maximumDurationMs: trigger.maximumDurationMs,
      ...(trigger.jitterMs === undefined ? {} : { jitterMs: trigger.jitterMs }),
    });
  }
  if (
    trigger.mode === "interval" &&
    isDuration(trigger.intervalMs) &&
    isOverlapPolicy(trigger.overlapPolicy) &&
    isDuration(trigger.maximumDurationMs) &&
    isOptionalJitter(trigger.jitterMs)
  ) {
    return Object.freeze({
      mode: "interval",
      intervalMs: trigger.intervalMs,
      overlapPolicy: trigger.overlapPolicy,
      maximumDurationMs: trigger.maximumDurationMs,
      ...(trigger.jitterMs === undefined ? {} : { jitterMs: trigger.jitterMs }),
    });
  }
  return undefined;
}

function fenceValue(value: string): string {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new KnowledgeExecutionFenceError();
  return value;
}

function assertLeaseMs(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 900_000) {
    throw new RangeError(
      "Knowledge source execution lease duration is invalid.",
    );
  }
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

function isDuration(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 86_400_000
  );
}

function isOptionalJitter(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 86_400_000)
  );
}

function isOverlapPolicy(value: unknown): value is "skip" | "queue" {
  return value === "skip" || value === "queue";
}
