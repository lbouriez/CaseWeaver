import type {
  ApplicationTransaction,
  KnowledgeSourceCommandStore,
} from "@caseweaver/application";
import { outboxEnvelopeId } from "@caseweaver/domain";

import type { PostgresTransactionLookup } from "../index.js";

interface SourceRow {
  readonly id: string;
  readonly lifecycle: string;
  readonly source_configuration_version_id: string;
  readonly connector_configuration_version_id: string;
}

function asDate(value: string): Date {
  return new Date(value);
}

function runtimePinsFromPayload(value: unknown): Readonly<{
  readonly sourceConfigurationVersionId: string;
  readonly connectorConfigurationVersionId: string;
}> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored source command payload is invalid.");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const sourceConfigurationVersionId = record.sourceConfigurationVersionId;
  const connectorConfigurationVersionId =
    record.connectorConfigurationVersionId;
  if (
    typeof sourceConfigurationVersionId !== "string" ||
    sourceConfigurationVersionId.length === 0 ||
    typeof connectorConfigurationVersionId !== "string" ||
    connectorConfigurationVersionId.length === 0
  ) {
    throw new Error("Stored source command payload is invalid.");
  }
  return Object.freeze({
    sourceConfigurationVersionId,
    connectorConfigurationVersionId,
  });
}

/**
 * Transaction-bound persistence for source-owned synchronization requests. It
 * resolves only lifecycle and immutable configuration version, never connector
 * settings, clients, cursors, or credentials.
 */
export class PostgresKnowledgeSourceCommandStore
  implements KnowledgeSourceCommandStore
{
  public constructor(
    private readonly transactions: PostgresTransactionLookup,
  ) {}

  public async lockIdempotencyKey(
    transaction: ApplicationTransaction,
    input: Parameters<KnowledgeSourceCommandStore["lockIdempotencyKey"]>[1],
  ): Promise<void> {
    const key = `${input.workspaceId}:${input.operation}:${input.keyDigest}`;
    // pg_advisory_xact_lock returns PostgreSQL's `void` type, which Prisma's
    // typed raw-result deserializer cannot represent. Execute it for its
    // transaction-scoped locking side effect rather than attempting to read it.
    await this.transactions.get(transaction).$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
    `;
  }

  public async findIdempotency(
    transaction: ApplicationTransaction,
    input: Parameters<KnowledgeSourceCommandStore["findIdempotency"]>[1],
  ) {
    const database = this.transactions.get(transaction);
    const record = await database.idempotencyRecord.findUnique({
      where: { workspaceId_operation_keyDigest: input },
      select: { requestDigest: true, resourceId: true },
    });
    if (record === null) return undefined;
    const envelope = await database.outboxEnvelope.findFirst({
      where: { id: record.resourceId, workspaceId: input.workspaceId },
      select: { id: true, type: true, payload: true },
    });
    if (
      envelope === null ||
      (envelope.type !== "knowledge.synchronize.v2" &&
        envelope.type !== "knowledge.full-rescan.v2")
    ) {
      if (
        envelope !== null &&
        (envelope.type === "knowledge.synchronize.v1" ||
          envelope.type === "knowledge.full-rescan.v1")
      ) {
        throw new Error("Stored source command is legacy and unavailable.");
      }
      throw new Error("Stored source command idempotency record is invalid.");
    }
    const pins = runtimePinsFromPayload(envelope.payload);
    return Object.freeze({
      requestDigest: record.requestDigest as Parameters<
        KnowledgeSourceCommandStore["recordIdempotency"]
      >[1]["requestDigest"],
      outboxEnvelopeId: outboxEnvelopeId(envelope.id),
      sourceConfigurationVersionId: pins.sourceConfigurationVersionId,
      connectorConfigurationVersionId: pins.connectorConfigurationVersionId,
      kind:
        envelope.type === "knowledge.full-rescan.v2"
          ? "fullRescan"
          : "synchronize",
    });
  }

  public async recordIdempotency(
    transaction: ApplicationTransaction,
    input: Parameters<KnowledgeSourceCommandStore["recordIdempotency"]>[1],
  ): Promise<void> {
    await this.transactions.get(transaction).idempotencyRecord.create({
      data: {
        workspaceId: input.workspaceId,
        operation: input.operation,
        keyDigest: input.keyDigest,
        requestDigest: input.requestDigest,
        resourceId: input.outboxEnvelopeId,
        createdAt: asDate(input.occurredAt),
      },
    });
  }

  public async findSource(
    transaction: ApplicationTransaction,
    input: Parameters<KnowledgeSourceCommandStore["findSource"]>[1],
  ) {
    const rows = await this.transactions.get(transaction).$queryRaw<
      readonly SourceRow[]
    >`
      SELECT
        source.id,
        source.lifecycle,
        runtime.source_configuration_version_id,
        runtime.connector_configuration_version_id
      FROM knowledge_sources AS source
      INNER JOIN knowledge_source_runtime_versions AS runtime
        ON runtime.workspace_id = source.workspace_id
       AND runtime.knowledge_source_id = source.id
       AND runtime.source_configuration_version_id = source.configuration_version
       AND runtime.connector_configuration_version_id = source.connector_configuration_version_id
      WHERE source.workspace_id = ${input.workspaceId}
        AND source.id = ${input.sourceId}
      FOR UPDATE OF source
    `;
    const source = rows[0];
    if (source === undefined) return undefined;
    if (source.lifecycle !== "enabled" && source.lifecycle !== "disabled") {
      throw new Error("Stored knowledge source lifecycle is invalid.");
    }
    return Object.freeze({
      id: source.id,
      lifecycle: source.lifecycle,
      sourceConfigurationVersionId: source.source_configuration_version_id,
      connectorConfigurationVersionId:
        source.connector_configuration_version_id,
    });
  }

  public async reserveManualFullRescan(
    transaction: ApplicationTransaction,
    input: Parameters<
      KnowledgeSourceCommandStore["reserveManualFullRescan"]
    >[1],
  ): Promise<boolean> {
    const occurredAt = asDate(input.occurredAt);
    const eligibleBefore = new Date(occurredAt.getTime() - input.cooldownMs);
    const rows = await this.transactions.get(transaction).$queryRaw<
      readonly Readonly<{ workspace_id: string }>[]
    >`
      INSERT INTO knowledge_source_states (
        workspace_id,
        knowledge_source_id,
        last_manual_full_rescan_requested_at
      ) VALUES (
        ${input.workspaceId},
        ${input.sourceId},
        ${occurredAt}
      )
      ON CONFLICT (workspace_id, knowledge_source_id)
      DO UPDATE SET
        last_manual_full_rescan_requested_at = EXCLUDED.last_manual_full_rescan_requested_at,
        updated_at = NOW()
      WHERE knowledge_source_states.last_manual_full_rescan_requested_at IS NULL
        OR knowledge_source_states.last_manual_full_rescan_requested_at <= ${eligibleBefore}
      RETURNING workspace_id
    `;
    return rows[0] !== undefined;
  }
}
