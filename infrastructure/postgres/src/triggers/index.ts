import { createHash } from "node:crypto";
import {
  createAnalysisRequestIdentity,
  identityInputFor,
  immutableCaseSnapshotSchema,
} from "@caseweaver/analysis";
import type {
  AnalysisTriggerRequestStore,
  ApplicationTransaction,
} from "@caseweaver/application";
import {
  analysisJobId,
  analysisProfileVersionId,
  analysisTriggerId,
  analysisTriggerRequestId,
  analysisTriggerVersionId,
  caseSnapshotId,
  connectorRegistrationId,
  type EnvelopeFor,
  principalId,
  sha256Digest,
  workspaceId,
} from "@caseweaver/domain";
import type { Prisma } from "@prisma/client";

import type { PostgresTransactionLookup } from "../index.js";

interface RequestRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly actor_principal_id: string | null;
  readonly analysis_trigger_id: string;
  readonly analysis_trigger_version_id: string;
  readonly analysis_profile_version_id: string;
  readonly connector_registration_id: string;
  readonly connector_configuration_version_id: string;
  readonly source: string;
  readonly occurrence_key: string | null;
  readonly target_connector_instance_id: string;
  readonly target_resource_type: string;
  readonly target_external_id: string;
  readonly idempotency_key_digest: string;
  readonly request_digest: string;
  readonly state: string;
  readonly capture_fencing_token: bigint;
  readonly capture_lease_expires_at: Date | null;
  readonly case_snapshot_id: string | null;
  readonly error_retryable: boolean | null;
}

interface CapturedSubmissionRow {
  readonly snapshot: Prisma.JsonValue;
  readonly definition: Prisma.JsonValue;
}

interface SnapshotAttachmentReferenceRow {
  readonly attachment_id: string;
  readonly attachment_derivative_id: string;
  readonly processor_version: string;
  readonly output_content_hash: string;
}

type TriggerUnitOfWork = PostgresTransactionLookup;

export class PostgresAnalysisTriggerStoreError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "analysis.trigger.configurationUnavailable"
      | "analysis.trigger.captureLost" = "analysis.trigger.configurationUnavailable",
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "PostgresAnalysisTriggerStoreError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isSource(value: string): value is "manual" | "schedule" | "webhook" {
  return value === "manual" || value === "schedule" || value === "webhook";
}

function requestFromRow(
  row: RequestRow,
): import("@caseweaver/application").AnalysisTriggerRequest {
  if (!isSource(row.source) || row.actor_principal_id === null) {
    throw new PostgresAnalysisTriggerStoreError(
      "Persisted analysis trigger request is unavailable.",
    );
  }
  return Object.freeze({
    id: analysisTriggerRequestId(row.id),
    workspaceId: workspaceId(row.workspace_id),
    actorPrincipalId: principalId(row.actor_principal_id),
    triggerId: analysisTriggerId(row.analysis_trigger_id),
    triggerVersionId: analysisTriggerVersionId(row.analysis_trigger_version_id),
    analysisProfileVersionId: analysisProfileVersionId(
      row.analysis_profile_version_id,
    ),
    connectorRegistrationId: connectorRegistrationId(
      row.connector_registration_id,
    ),
    connectorConfigurationVersionId: row.connector_configuration_version_id,
    source: row.source,
    ...(row.occurrence_key === null
      ? {}
      : { occurrenceKey: row.occurrence_key }),
    target: Object.freeze({
      connectorInstanceId: row.target_connector_instance_id,
      resourceType: row.target_resource_type,
      externalId: row.target_external_id,
    }),
    idempotencyKeyDigest: sha256Digest(row.idempotency_key_digest),
    requestDigest: sha256Digest(row.request_digest),
  });
}

function matchesCommand(
  row: RequestRow,
  command: EnvelopeFor<"analysis.trigger.v2">,
): boolean {
  return (
    row.id === command.payload.triggerRequestId &&
    row.analysis_trigger_id === command.payload.triggerId &&
    row.analysis_trigger_version_id === command.payload.triggerVersionId &&
    row.connector_registration_id === command.payload.connectorRegistrationId &&
    row.connector_configuration_version_id ===
      command.payload.connectorConfigurationVersionId &&
    row.source === command.payload.source &&
    row.occurrence_key === (command.payload.occurrenceKey ?? null) &&
    row.target_connector_instance_id ===
      command.payload.target.connectorInstanceId &&
    row.target_resource_type === command.payload.target.resourceType &&
    row.target_external_id === command.payload.target.externalId
  );
}

function snapshotId(
  request: import("@caseweaver/application").AnalysisTriggerRequest,
  contentHash: string,
): ReturnType<typeof caseSnapshotId> {
  return caseSnapshotId(
    `case-snapshot:${sha256(
      [
        request.workspaceId,
        request.connectorRegistrationId,
        request.target.resourceType,
        request.target.externalId,
        contentHash,
      ].join("\u0000"),
    )}`,
  );
}

function referenceId(
  request: import("@caseweaver/application").AnalysisTriggerRequest,
): string {
  return `external-reference:${sha256(
    [
      request.workspaceId,
      request.connectorRegistrationId,
      request.target.resourceType,
      request.target.externalId,
    ].join("\u0000"),
  )}`;
}

function json(value: unknown): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

function safeFailureCode(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)
    ? value
    : "analysis.trigger.captureFailed";
}

function isOpaqueIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1_024 &&
    !value.includes("\u0000") &&
    !value.includes("\r") &&
    !value.includes("\n")
  );
}

function capturedAttachmentReferences(
  request: import("@caseweaver/application").AnalysisTriggerRequest,
  snapshot: import("@caseweaver/application").CapturedCaseSnapshot,
): readonly Readonly<{
  readonly connectorRegistrationId: string;
  readonly resourceType: string;
  readonly externalId: string;
}>[] {
  const values = snapshot.attachmentReferences ?? [];
  if (values.length > 1_000) {
    throw new PostgresAnalysisTriggerStoreError(
      "Case snapshot attachment references exceed the supported bound.",
      "analysis.trigger.captureLost",
      false,
    );
  }
  const unique = new Map<
    string,
    Readonly<{
      readonly connectorRegistrationId: string;
      readonly resourceType: string;
      readonly externalId: string;
    }>
  >();
  for (const value of values) {
    if (
      value.connectorRegistrationId !== request.connectorRegistrationId ||
      !isOpaqueIdentifier(value.resourceType) ||
      !isOpaqueIdentifier(value.externalId)
    ) {
      throw new PostgresAnalysisTriggerStoreError(
        "Case snapshot attachment references are unavailable.",
        "analysis.trigger.captureLost",
        false,
      );
    }
    unique.set(
      `${value.resourceType}\u0000${value.externalId}`,
      Object.freeze({ ...value }),
    );
  }
  return Object.freeze(
    [...unique.values()].toSorted((left, right) =>
      `${left.resourceType}\u0000${left.externalId}`.localeCompare(
        `${right.resourceType}\u0000${right.externalId}`,
      ),
    ),
  );
}

async function persistSnapshotAttachmentReferences(
  database: Prisma.TransactionClient,
  input: Readonly<{
    readonly workspaceId: string;
    readonly caseSnapshotId: string;
    readonly request: import("@caseweaver/application").AnalysisTriggerRequest;
    readonly snapshot: import("@caseweaver/application").CapturedCaseSnapshot;
  }>,
): Promise<void> {
  const attachmentReferences = capturedAttachmentReferences(
    input.request,
    input.snapshot,
  );
  const evidence = new Map<string, SnapshotAttachmentReferenceRow>();
  for (const reference of attachmentReferences) {
    const rows = await database.$queryRaw<
      readonly SnapshotAttachmentReferenceRow[]
    >`
      SELECT DISTINCT
        attachment.id AS attachment_id,
        derivative.id AS attachment_derivative_id,
        derivative.processor_version,
        derivative.output_content_hash
      FROM external_references AS external_reference
      JOIN attachments AS attachment
        ON attachment.workspace_id = external_reference.workspace_id
       AND attachment.external_reference_id = external_reference.id
      JOIN attachment_derivative_sources AS source
        ON source.workspace_id = attachment.workspace_id
       AND source.attachment_id = attachment.id
      JOIN attachment_derivatives AS derivative
        ON derivative.workspace_id = source.workspace_id
       AND derivative.id = source.attachment_derivative_id
      WHERE external_reference.workspace_id = ${input.workspaceId}
        AND external_reference.connector_registration_id = ${reference.connectorRegistrationId}
        AND external_reference.kind = ${reference.resourceType}
        AND external_reference.external_id = ${reference.externalId}
        AND attachment.lifecycle = 'accepted'
        AND attachment.retention_state = 'active'
        AND derivative.status = 'completed'
        AND derivative.retention_state = 'active'
        AND derivative.output_mime_type = 'text/plain'
        AND derivative.output_content_hash ~ '^[0-9a-fA-F]{64}$'
        AND derivative.output_byte_length IS NOT NULL
        AND derivative.output_byte_length >= 0
      ORDER BY attachment.id, derivative.id
    `;
    for (const row of rows) {
      evidence.set(
        `${row.attachment_id}\u0000${row.attachment_derivative_id}`,
        row,
      );
    }
  }
  for (const [ordinal, row] of [...evidence.values()]
    .toSorted((left, right) =>
      `${left.attachment_id}\u0000${left.attachment_derivative_id}`.localeCompare(
        `${right.attachment_id}\u0000${right.attachment_derivative_id}`,
      ),
    )
    .entries()) {
    await database.$executeRaw`
      INSERT INTO case_snapshot_attachment_references (
        workspace_id, case_snapshot_id, ordinal, attachment_id,
        attachment_derivative_id, processor_version, output_content_hash
      ) VALUES (
        ${input.workspaceId}, ${input.caseSnapshotId}, ${ordinal},
        ${row.attachment_id}, ${row.attachment_derivative_id},
        ${row.processor_version}, ${row.output_content_hash.toLowerCase()}
      )
    `;
  }
}

function analysisCommandForCapturedRequest(
  request: import("@caseweaver/application").AnalysisTriggerRequest,
  row: CapturedSubmissionRow,
): import("@caseweaver/application").RequestAnalysisCommand {
  const snapshot = immutableCaseSnapshotSchema.parse(row.snapshot);
  const identity = createAnalysisRequestIdentity(
    identityInputFor(
      { id: snapshot.id, revision: snapshot.revision },
      row.definition,
    ),
  );
  return Object.freeze({
    idempotencyKeyDigest: sha256Digest(
      sha256(`analysis.trigger.analysis.v1\u0000${request.id}`),
    ),
    requestDigest: sha256Digest(identity.requestHash),
    identityHash: sha256Digest(identity.identityHash),
    analysisProfileVersionId: request.analysisProfileVersionId,
    caseSnapshotId: caseSnapshotId(snapshot.id),
  });
}

/**
 * PostgreSQL implementation of the versioned trigger request and fenced case
 * capture protocol. It persists only normalized immutable snapshot content and
 * opaque target/pin identities; it never resolves connector settings or a
 * CaseSource client.
 */
export class PostgresAnalysisTriggerRequestStore
  implements AnalysisTriggerRequestStore
{
  public constructor(private readonly transactions: TriggerUnitOfWork) {}

  public async createOrFind(
    transaction: ApplicationTransaction,
    input: Parameters<AnalysisTriggerRequestStore["createOrFind"]>[1],
  ): Promise<
    | Readonly<{
        readonly kind: "created";
        readonly request: import("@caseweaver/application").AnalysisTriggerRequest;
      }>
    | Readonly<{
        readonly kind: "replayed";
        readonly request: import("@caseweaver/application").AnalysisTriggerRequest;
      }>
  > {
    const database = this.transactions.get(transaction);
    const lockKey = `${input.workspaceId}:analysis.trigger:${input.idempotencyKeyDigest}`;
    await database.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    `;
    const prior = await database.idempotencyRecord.findUnique({
      where: {
        workspaceId_operation_keyDigest: {
          workspaceId: input.workspaceId,
          operation: "analysis.trigger",
          keyDigest: input.idempotencyKeyDigest,
        },
      },
      select: { requestDigest: true, resourceId: true },
    });
    if (prior !== null) {
      const rows = await database.$queryRaw<readonly RequestRow[]>`
        SELECT
          request.id, request.workspace_id, request.actor_principal_id,
          trigger_version.analysis_trigger_id,
          request.analysis_trigger_version_id,
          request.analysis_profile_version_id,
          request.connector_registration_id,
          request.connector_configuration_version_id,
          request.source, request.occurrence_key,
          request.target_connector_instance_id, request.target_resource_type,
          request.target_external_id, request.idempotency_key_digest,
          request.request_digest, request.state, request.capture_fencing_token,
          request.capture_lease_expires_at, request.case_snapshot_id,
          request.error_retryable
        FROM analysis_trigger_requests AS request
        JOIN analysis_trigger_versions AS trigger_version
          ON trigger_version.workspace_id = request.workspace_id
         AND trigger_version.id = request.analysis_trigger_version_id
        WHERE request.workspace_id = ${input.workspaceId}
          AND request.id = ${prior.resourceId}
      `;
      const row = rows[0];
      if (row === undefined) {
        throw new PostgresAnalysisTriggerStoreError(
          "Stored analysis trigger idempotency request is unavailable.",
        );
      }
      const request = requestFromRow(row);
      if (
        input.expectedTriggerVersionId !== undefined &&
        request.triggerVersionId !== input.expectedTriggerVersionId
      ) {
        throw new PostgresAnalysisTriggerStoreError(
          "Analysis trigger configuration is unavailable.",
        );
      }
      if (
        prior.requestDigest !== input.requestDigest ||
        request.requestDigest !== input.requestDigest
      ) {
        return Object.freeze({ kind: "replayed", request });
      }
      return Object.freeze({ kind: "replayed", request });
    }

    const resolved = await database.$queryRaw<
      readonly {
        readonly trigger_version_id: string;
        readonly analysis_profile_version_id: string;
        readonly connector_registration_id: string;
        readonly connector_configuration_version_id: string;
      }[]
    >`
      SELECT
        trigger_version.id AS trigger_version_id,
        trigger_version.analysis_profile_version_id,
        trigger_version.connector_registration_id,
        trigger_version.connector_configuration_version_id
      FROM analysis_triggers AS trigger
      JOIN analysis_trigger_versions AS trigger_version
        ON trigger_version.workspace_id = trigger.workspace_id
       AND trigger_version.analysis_trigger_id = trigger.id
       AND trigger_version.id = trigger.current_version_id
      JOIN analysis_profile_versions AS profile
        ON profile.workspace_id = trigger_version.workspace_id
       AND profile.id = trigger_version.analysis_profile_version_id
      JOIN connector_registrations AS connector
        ON connector.workspace_id = trigger_version.workspace_id
       AND connector.id = trigger_version.connector_registration_id
       AND connector.lifecycle = 'active'
      JOIN connector_capabilities AS capability
        ON capability.workspace_id = connector.workspace_id
       AND capability.connector_registration_id = connector.id
       AND capability.capability = 'caseSource'
      JOIN administration_configurations AS configuration
        ON configuration.workspace_id = connector.workspace_id
       AND configuration.id = connector.id
       AND configuration.resource_type = 'connector-instances'
       AND configuration.lifecycle = 'active'
      JOIN administration_configuration_versions AS connector_version
        ON connector_version.workspace_id = configuration.workspace_id
       AND connector_version.id = trigger_version.connector_configuration_version_id
       AND connector_version.configuration_id = configuration.id
       AND connector_version.descriptor_kind = 'connector'
      JOIN administration_descriptor_revisions AS descriptor
        ON descriptor.kind = connector_version.descriptor_kind
       AND descriptor.type = connector_version.descriptor_type
       AND descriptor.version = connector_version.descriptor_version
       AND descriptor.descriptor -> 'connectorCapabilities' ? 'caseSource'
      WHERE trigger.workspace_id = ${input.workspaceId}
        AND trigger.id = ${input.triggerId}
        AND trigger.lifecycle = 'active'
        AND (
          ${input.expectedTriggerVersionId ?? null}::text IS NULL
          OR trigger_version.id = ${input.expectedTriggerVersionId ?? null}
        )
    `;
    const version = resolved[0];
    if (
      version === undefined ||
      version.connector_registration_id !== input.target.connectorInstanceId
    ) {
      throw new PostgresAnalysisTriggerStoreError(
        "Analysis trigger configuration is unavailable.",
      );
    }
    await database.$executeRaw`
      INSERT INTO analysis_trigger_requests (
        id, workspace_id, actor_principal_id, analysis_trigger_version_id,
        analysis_profile_version_id, connector_registration_id,
        connector_configuration_version_id, source, occurrence_key,
        target_connector_instance_id, target_resource_type, target_external_id,
        idempotency_key_digest, request_digest, state, created_at, updated_at
      ) VALUES (
        ${input.id}, ${input.workspaceId}, ${input.actorPrincipalId}, ${version.trigger_version_id},
        ${version.analysis_profile_version_id}, ${version.connector_registration_id},
        ${version.connector_configuration_version_id}, ${input.source},
        ${input.occurrenceKey ?? null}, ${input.target.connectorInstanceId},
        ${input.target.resourceType}, ${input.target.externalId},
        ${input.idempotencyKeyDigest}, ${input.requestDigest}, 'pending',
        ${new Date(input.occurredAt)}, ${new Date(input.occurredAt)}
      )
    `;
    await database.idempotencyRecord.create({
      data: {
        workspaceId: input.workspaceId,
        operation: "analysis.trigger",
        keyDigest: input.idempotencyKeyDigest,
        requestDigest: input.requestDigest,
        resourceId: input.id,
        createdAt: new Date(input.occurredAt),
      },
    });
    const rows = await database.$queryRaw<readonly RequestRow[]>`
      SELECT
        request.id, request.workspace_id, request.actor_principal_id,
        trigger_version.analysis_trigger_id,
        request.analysis_trigger_version_id, request.analysis_profile_version_id,
        request.connector_registration_id,
        request.connector_configuration_version_id,
        request.source, request.occurrence_key,
        request.target_connector_instance_id, request.target_resource_type,
        request.target_external_id, request.idempotency_key_digest,
        request.request_digest, request.state, request.capture_fencing_token,
        request.capture_lease_expires_at, request.case_snapshot_id,
        request.error_retryable
      FROM analysis_trigger_requests AS request
      JOIN analysis_trigger_versions AS trigger_version
        ON trigger_version.workspace_id = request.workspace_id
       AND trigger_version.id = request.analysis_trigger_version_id
      WHERE request.workspace_id = ${input.workspaceId} AND request.id = ${input.id}
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new PostgresAnalysisTriggerStoreError(
        "Analysis trigger request was not created.",
      );
    }
    return Object.freeze({ kind: "created", request: requestFromRow(row) });
  }

  public async claimCapture(
    transaction: ApplicationTransaction,
    input: Parameters<AnalysisTriggerRequestStore["claimCapture"]>[1],
  ): Promise<Awaited<ReturnType<AnalysisTriggerRequestStore["claimCapture"]>>> {
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1) {
      throw new RangeError("Analysis trigger capture lease must be positive.");
    }
    const database = this.transactions.get(transaction);
    const rows = await database.$queryRaw<readonly RequestRow[]>`
      SELECT
        request.id, request.workspace_id, request.actor_principal_id,
        trigger_version.analysis_trigger_id,
        request.analysis_trigger_version_id,
        request.analysis_profile_version_id,
        request.connector_registration_id,
        request.connector_configuration_version_id,
        request.source, request.occurrence_key,
        request.target_connector_instance_id, request.target_resource_type,
        request.target_external_id, request.idempotency_key_digest,
        request.request_digest, request.state, request.capture_fencing_token,
        request.capture_lease_expires_at, request.case_snapshot_id,
        request.error_retryable
      FROM analysis_trigger_requests AS request
      JOIN analysis_trigger_versions AS trigger_version
        ON trigger_version.workspace_id = request.workspace_id
       AND trigger_version.id = request.analysis_trigger_version_id
      WHERE request.workspace_id = ${input.command.workspaceId}
        AND request.id = ${input.command.payload.triggerRequestId}
      FOR UPDATE OF request
    `;
    const row = rows[0];
    if (row === undefined) return { kind: "notFound" };
    if (!matchesCommand(row, input.command)) return { kind: "unavailable" };

    const available = await database.$queryRaw<
      readonly { readonly id: string }[]
    >`
      SELECT request.id
      FROM analysis_trigger_requests AS request
      JOIN analysis_trigger_versions AS trigger_version
        ON trigger_version.workspace_id = request.workspace_id
       AND trigger_version.id = request.analysis_trigger_version_id
      JOIN analysis_triggers AS trigger
        ON trigger.workspace_id = trigger_version.workspace_id
       AND trigger.id = trigger_version.analysis_trigger_id
       AND trigger.lifecycle = 'active'
      JOIN connector_registrations AS connector
        ON connector.workspace_id = request.workspace_id
       AND connector.id = request.connector_registration_id
       AND connector.lifecycle = 'active'
      JOIN connector_capabilities AS capability
        ON capability.workspace_id = connector.workspace_id
       AND capability.connector_registration_id = connector.id
       AND capability.capability = 'caseSource'
      JOIN administration_configurations AS configuration
        ON configuration.workspace_id = connector.workspace_id
       AND configuration.id = connector.id
       AND configuration.resource_type = 'connector-instances'
       AND configuration.lifecycle = 'active'
      JOIN administration_configuration_versions AS connector_version
        ON connector_version.workspace_id = configuration.workspace_id
       AND connector_version.id = request.connector_configuration_version_id
       AND connector_version.configuration_id = configuration.id
       AND connector_version.descriptor_kind = 'connector'
      JOIN administration_descriptor_revisions AS descriptor
        ON descriptor.kind = connector_version.descriptor_kind
       AND descriptor.type = connector_version.descriptor_type
       AND descriptor.version = connector_version.descriptor_version
       AND descriptor.descriptor -> 'connectorCapabilities' ? 'caseSource'
      WHERE request.workspace_id = ${input.command.workspaceId}
        AND request.id = ${row.id}
    `;
    if (available[0] === undefined) return { kind: "unavailable" };
    if (row.state === "captured" && row.case_snapshot_id !== null) {
      return {
        kind: "captured",
        caseSnapshotId: caseSnapshotId(row.case_snapshot_id),
        request: requestFromRow(row),
      };
    }
    if (row.state === "capturing" && row.capture_lease_expires_at !== null) {
      const lease = await database.$queryRaw<
        readonly { readonly active: boolean }[]
      >`
        SELECT capture_lease_expires_at > NOW() AS active
        FROM analysis_trigger_requests
        WHERE workspace_id = ${input.command.workspaceId}
          AND id = ${row.id}
      `;
      if (lease[0]?.active === true) {
        return { kind: "alreadyCapturing" };
      }
    }
    if (row.state === "failed" && row.error_retryable !== true) {
      return { kind: "unavailable" };
    }
    const nextFencingToken = row.capture_fencing_token + 1n;
    const updated = await database.$executeRaw`
      UPDATE analysis_trigger_requests
      SET
        state = 'capturing',
        capture_fencing_token = ${nextFencingToken},
        capture_lease_expires_at = NOW() + (${input.leaseMs} * INTERVAL '1 millisecond'),
        error_code = NULL,
        error_retryable = NULL,
        updated_at = NOW()
      WHERE workspace_id = ${input.command.workspaceId}
        AND id = ${row.id}
        AND state <> 'captured'
    `;
    if (updated !== 1) return { kind: "alreadyCapturing" };
    return {
      kind: "claimed",
      claim: Object.freeze({
        request: requestFromRow(row),
        fencingToken: nextFencingToken,
      }),
    };
  }

  public async persistCapture(
    transaction: ApplicationTransaction,
    input: Parameters<AnalysisTriggerRequestStore["persistCapture"]>[1],
  ): Promise<ReturnType<typeof caseSnapshotId>> {
    const database = this.transactions.get(transaction);
    const id = snapshotId(input.claim.request, input.snapshot.contentHash);
    const snapshot = immutableCaseSnapshotSchema.parse({
      id,
      revision: input.snapshot.revision,
      capturedAt: input.snapshot.capturedAt,
      title: input.snapshot.title,
      summary: input.snapshot.summary,
      contentHash: input.snapshot.contentHash,
      messages: input.snapshot.messages,
    });
    const reference = referenceId(input.claim.request);
    const refs = await database.$queryRaw<readonly { readonly id: string }[]>`
      INSERT INTO external_references (
        id, workspace_id, connector_registration_id, kind, external_id, observed_hash
      ) VALUES (
        ${reference}, ${input.claim.request.workspaceId},
        ${input.claim.request.connectorRegistrationId},
        ${input.claim.request.target.resourceType},
        ${input.claim.request.target.externalId}, ${input.snapshot.contentHash}
      )
      ON CONFLICT (workspace_id, connector_registration_id, kind, external_id)
      DO UPDATE SET observed_hash = EXCLUDED.observed_hash, updated_at = NOW()
      RETURNING id
    `;
    const externalReference = refs[0];
    if (externalReference === undefined) {
      throw new PostgresAnalysisTriggerStoreError(
        "Case capture external reference is unavailable.",
        "analysis.trigger.captureLost",
        true,
      );
    }
    const createdSnapshots = await database.$queryRaw<
      readonly { readonly id: string }[]
    >`
      INSERT INTO case_snapshots (
        id, workspace_id, external_reference_id, lifecycle, snapshot_hash,
        snapshot, observed_at
      ) VALUES (
        ${id}, ${input.claim.request.workspaceId}, ${externalReference.id},
        'active', ${input.snapshot.contentHash}, ${JSON.stringify(json(snapshot))}::jsonb,
        ${new Date(input.snapshot.capturedAt)}
      )
      ON CONFLICT (workspace_id, external_reference_id, snapshot_hash)
      DO NOTHING
      RETURNING id
    `;
    const created = createdSnapshots[0];
    const persisted =
      created ??
      (
        await database.$queryRaw<readonly { readonly id: string }[]>`
          SELECT id
          FROM case_snapshots
          WHERE workspace_id = ${input.claim.request.workspaceId}
            AND external_reference_id = ${externalReference.id}
            AND snapshot_hash = ${input.snapshot.contentHash}
        `
      )[0];
    if (persisted === undefined) {
      throw new PostgresAnalysisTriggerStoreError(
        "Case snapshot capture is unavailable.",
        "analysis.trigger.captureLost",
        true,
      );
    }
    if (created !== undefined) {
      await persistSnapshotAttachmentReferences(database, {
        workspaceId: input.claim.request.workspaceId,
        caseSnapshotId: created.id,
        request: input.claim.request,
        snapshot: input.snapshot,
      });
    }
    const updated = await database.$executeRaw`
      UPDATE analysis_trigger_requests
      SET
        state = 'captured',
        case_snapshot_id = ${persisted.id},
        capture_lease_expires_at = NULL,
        captured_at = NOW(),
        updated_at = NOW()
      WHERE workspace_id = ${input.claim.request.workspaceId}
        AND id = ${input.claim.request.id}
        AND state = 'capturing'
        AND capture_fencing_token = ${input.claim.fencingToken}
        AND capture_lease_expires_at > NOW()
    `;
    if (updated !== 1) {
      throw new PostgresAnalysisTriggerStoreError(
        "Analysis trigger capture claim was lost.",
        "analysis.trigger.captureLost",
        true,
      );
    }
    return caseSnapshotId(persisted.id);
  }

  public async failCapture(
    transaction: ApplicationTransaction,
    input: Parameters<AnalysisTriggerRequestStore["failCapture"]>[1],
  ): Promise<void> {
    const updated = await this.transactions.get(transaction).$executeRaw`
      UPDATE analysis_trigger_requests
      SET
        state = 'failed',
        capture_lease_expires_at = NULL,
        error_code = ${safeFailureCode(input.error.code)},
        error_retryable = ${input.error.retryable},
        updated_at = ${new Date(input.occurredAt)}
      WHERE workspace_id = ${input.claim.request.workspaceId}
        AND id = ${input.claim.request.id}
        AND state = 'capturing'
        AND capture_fencing_token = ${input.claim.fencingToken}
    `;
    if (updated > 1) {
      throw new PostgresAnalysisTriggerStoreError(
        "Analysis trigger capture failure update is inconsistent.",
        "analysis.trigger.captureLost",
        true,
      );
    }
  }

  public async prepareAnalysisSubmission(
    transaction: ApplicationTransaction,
    input: Parameters<
      AnalysisTriggerRequestStore["prepareAnalysisSubmission"]
    >[1],
  ): Promise<
    Awaited<
      ReturnType<AnalysisTriggerRequestStore["prepareAnalysisSubmission"]>
    >
  > {
    const database = this.transactions.get(transaction);
    const requests = await database.$queryRaw<readonly RequestRow[]>`
      SELECT
        request.id, request.workspace_id, request.actor_principal_id,
        trigger_version.analysis_trigger_id,
        request.analysis_trigger_version_id,
        request.analysis_profile_version_id,
        request.connector_registration_id,
        request.connector_configuration_version_id,
        request.source, request.occurrence_key,
        request.target_connector_instance_id, request.target_resource_type,
        request.target_external_id, request.idempotency_key_digest,
        request.request_digest, request.state, request.capture_fencing_token,
        request.capture_lease_expires_at, request.case_snapshot_id,
        request.error_retryable
      FROM analysis_trigger_requests AS request
      JOIN analysis_trigger_versions AS trigger_version
        ON trigger_version.workspace_id = request.workspace_id
       AND trigger_version.id = request.analysis_trigger_version_id
      WHERE request.workspace_id = ${input.command.workspaceId}
        AND request.id = ${input.command.payload.triggerRequestId}
      FOR UPDATE OF request
    `;
    const requestRow = requests[0];
    if (requestRow === undefined) return { kind: "notFound" };
    if (!matchesCommand(requestRow, input.command)) {
      return { kind: "unavailable" };
    }
    if (
      requestRow.state !== "captured" ||
      requestRow.case_snapshot_id === null
    ) {
      return { kind: "notCaptured" };
    }

    const linked = await database.$queryRaw<
      readonly { readonly analysis_job_id: string }[]
    >`
      SELECT analysis_job_id
      FROM analysis_trigger_request_analyses
      WHERE workspace_id = ${input.command.workspaceId}
        AND analysis_trigger_request_id = ${requestRow.id}
    `;
    const submitted = linked[0];
    if (submitted !== undefined) {
      return {
        kind: "submitted",
        analysisJobId: analysisJobId(submitted.analysis_job_id),
      };
    }

    const captured = await database.$queryRaw<readonly CapturedSubmissionRow[]>`
      SELECT snapshot.snapshot, profile.definition
      FROM analysis_trigger_requests AS request
      JOIN analysis_trigger_versions AS trigger_version
        ON trigger_version.workspace_id = request.workspace_id
       AND trigger_version.id = request.analysis_trigger_version_id
      JOIN analysis_triggers AS trigger
        ON trigger.workspace_id = trigger_version.workspace_id
       AND trigger.id = trigger_version.analysis_trigger_id
       AND trigger.lifecycle = 'active'
      JOIN analysis_profile_versions AS profile
        ON profile.workspace_id = request.workspace_id
       AND profile.id = request.analysis_profile_version_id
      JOIN connector_registrations AS connector
        ON connector.workspace_id = request.workspace_id
       AND connector.id = request.connector_registration_id
       AND connector.lifecycle = 'active'
      JOIN connector_capabilities AS capability
        ON capability.workspace_id = connector.workspace_id
       AND capability.connector_registration_id = connector.id
       AND capability.capability = 'caseSource'
      JOIN administration_configurations AS configuration
        ON configuration.workspace_id = connector.workspace_id
       AND configuration.id = connector.id
       AND configuration.resource_type = 'connector-instances'
       AND configuration.lifecycle = 'active'
      JOIN administration_configuration_versions AS connector_version
        ON connector_version.workspace_id = configuration.workspace_id
       AND connector_version.id = request.connector_configuration_version_id
       AND connector_version.configuration_id = configuration.id
       AND connector_version.descriptor_kind = 'connector'
      JOIN administration_descriptor_revisions AS descriptor
        ON descriptor.kind = connector_version.descriptor_kind
       AND descriptor.type = connector_version.descriptor_type
       AND descriptor.version = connector_version.descriptor_version
       AND descriptor.descriptor -> 'connectorCapabilities' ? 'caseSource'
      JOIN case_snapshots AS snapshot
        ON snapshot.workspace_id = request.workspace_id
       AND snapshot.id = request.case_snapshot_id
       AND snapshot.lifecycle = 'active'
      WHERE request.workspace_id = ${input.command.workspaceId}
        AND request.id = ${requestRow.id}
    `;
    const row = captured[0];
    if (row === undefined) return { kind: "unavailable" };
    const request = requestFromRow(requestRow);
    return {
      kind: "ready",
      submission: Object.freeze({
        request,
        command: analysisCommandForCapturedRequest(request, row),
      }),
    };
  }

  public async bindAnalysisJob(
    transaction: ApplicationTransaction,
    input: Parameters<AnalysisTriggerRequestStore["bindAnalysisJob"]>[1],
  ): Promise<void> {
    const database = this.transactions.get(transaction);
    const inserted = await database.$queryRaw<
      readonly { readonly analysis_job_id: string }[]
    >`
      INSERT INTO analysis_trigger_request_analyses (
        workspace_id, analysis_trigger_request_id, analysis_job_id, created_at
      ) VALUES (
        ${input.workspaceId}, ${input.triggerRequestId}, ${input.analysisJobId},
        ${new Date(input.occurredAt)}
      )
      ON CONFLICT (workspace_id, analysis_trigger_request_id) DO NOTHING
      RETURNING analysis_job_id
    `;
    const bound = inserted[0];
    if (bound === undefined) {
      const existing = await database.$queryRaw<
        readonly { readonly analysis_job_id: string }[]
      >`
        SELECT analysis_job_id
        FROM analysis_trigger_request_analyses
        WHERE workspace_id = ${input.workspaceId}
          AND analysis_trigger_request_id = ${input.triggerRequestId}
        FOR UPDATE
      `;
      if (existing[0]?.analysis_job_id !== input.analysisJobId) {
        throw new PostgresAnalysisTriggerStoreError(
          "Analysis trigger request is linked to another analysis job.",
          "analysis.trigger.captureLost",
          true,
        );
      }
    }
  }
}
