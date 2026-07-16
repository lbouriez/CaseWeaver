import { createHash } from "node:crypto";

import type {
  ApplicationTransaction,
  PublicationIntentStore,
  StoredPublicationProfile,
  UnitOfWork,
} from "@caseweaver/application";
import {
  type Envelope,
  IdempotencyConflictError,
  type PublicationIntent,
  publicationIntentId,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { caseAnalysisOutputSchema } from "@caseweaver/prompts";
import {
  createPublicationIdentity,
  type PublicationAttempt,
  type PublicationCandidate,
  PublicationExecutionError,
  type PublicationExecutionStore,
  publicationProfileSchema,
} from "@caseweaver/publication";
import type {
  VerifiedWebhookEvent,
  VerifiedWebhookEventStore,
  VerifiedWebhookStoreResult,
} from "@caseweaver/webhooks";
import type { Prisma } from "@prisma/client";

import type { PostgresTransactionLookup } from "../index.js";

type PublicationUnitOfWork = UnitOfWork & PostgresTransactionLookup;

interface IntentRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly analysis_job_id: string;
  readonly state: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface CandidateRow extends IntentRow {
  readonly analysis_result_id: string | null;
  readonly identity_hash: string | null;
  readonly publication_marker: string | null;
  readonly publication_profile_id: string;
  readonly profile_version: string;
  readonly definition: Prisma.JsonValue;
  readonly target_connector_instance_id: string | null;
  readonly target_resource_type: string | null;
  readonly target_external_id: string | null;
  readonly destination_connector_instance_id: string | null;
  readonly destination_connector_configuration_version_id: string | null;
  readonly profile_destination_connector_configuration_version_id:
    | string
    | null;
  readonly record: Prisma.JsonValue;
}

interface WebhookTriggerRow {
  readonly trigger_id: string;
  readonly trigger_version_id: string;
  readonly analysis_profile_version_id: string;
  readonly connector_registration_id: string;
  readonly connector_configuration_version_id: string;
}

/**
 * A public webhook route must fail closed when its retained immutable routing
 * state can no longer prove an active, exact analysis-trigger configuration.
 * The message intentionally omits endpoint, connector, and secret metadata.
 */
export class PostgresVerifiedWebhookEventStoreError extends Error {
  public constructor() {
    super("Webhook analysis trigger configuration is unavailable.");
    this.name = "PostgresVerifiedWebhookEventStoreError";
  }

  public readonly code = "analysis.trigger.configurationUnavailable";
  public readonly retryable = false;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function asIntent(row: IntentRow): PublicationIntent {
  if (
    row.state !== "pending" &&
    row.state !== "awaitingApproval" &&
    row.state !== "publishing" &&
    row.state !== "published" &&
    row.state !== "outcomeUnknown" &&
    row.state !== "failed" &&
    row.state !== "skipped"
  ) {
    throw new Error("Persisted publication intent state is invalid.");
  }
  return Object.freeze({
    id: publicationIntentId(row.id),
    workspaceId: workspaceId(row.workspace_id),
    analysisJobId: row.analysis_job_id as PublicationIntent["analysisJobId"],
    state: row.state,
    createdAt: utcInstant(row.created_at),
    updatedAt: utcInstant(row.updated_at),
  });
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function publicationOutput(record: Prisma.JsonValue) {
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    !("output" in record)
  ) {
    throw new Error("Published analysis result has no structured output.");
  }
  return caseAnalysisOutputSchema.parse(record.output);
}

function candidateFromRow(row: CandidateRow): PublicationCandidate {
  if (
    row.analysis_result_id === null ||
    row.identity_hash === null ||
    row.publication_marker === null ||
    row.target_connector_instance_id === null ||
    row.target_resource_type === null ||
    row.target_external_id === null ||
    row.destination_connector_instance_id === null ||
    row.destination_connector_configuration_version_id === null ||
    row.profile_destination_connector_configuration_version_id === null
  ) {
    throw new PublicationExecutionError(
      "publication.configurationUnavailable",
      "Publication intent has no immutable destination configuration.",
      false,
    );
  }
  const profile = publicationProfileSchema.parse(row.definition);
  if (
    profile.destination.connectorInstanceId !==
      row.destination_connector_instance_id ||
    row.profile_destination_connector_configuration_version_id !==
      row.destination_connector_configuration_version_id
  ) {
    throw new Error("Publication profile destination is inconsistent.");
  }
  if (
    profile.id !== row.publication_profile_id ||
    profile.version !== row.profile_version
  ) {
    throw new Error("Publication profile version is inconsistent.");
  }
  const identity = createPublicationIdentity({
    workspaceId: row.workspace_id,
    analysisResultId: row.analysis_result_id,
    publicationProfileId: row.publication_profile_id,
    publicationProfileVersion: row.profile_version,
    destinationConnectorInstanceId: row.destination_connector_instance_id,
    destinationConnectorConfigurationVersionId:
      row.destination_connector_configuration_version_id,
    target: {
      connectorInstanceId: row.target_connector_instance_id,
      resourceType: row.target_resource_type,
      externalId: row.target_external_id,
    },
  });
  if (
    identity.identityHash !== row.identity_hash ||
    identity.marker.value !== row.publication_marker
  ) {
    throw new Error("Publication intent identity is inconsistent.");
  }
  return Object.freeze({
    intent: asIntent(row),
    analysisResultId: row.analysis_result_id,
    identityHash: row.identity_hash,
    marker: Object.freeze({ value: row.publication_marker }),
    analysis: publicationOutput(row.record),
    profile,
    destination: Object.freeze({
      connectorRegistrationId: row.destination_connector_instance_id,
      connectorConfigurationVersionId:
        row.destination_connector_configuration_version_id,
    }),
    target: Object.freeze({
      connectorInstanceId: row.target_connector_instance_id,
      resourceType: row.target_resource_type,
      externalId: row.target_external_id,
    }),
  });
}

async function intentRow(
  database: ReturnType<PostgresTransactionLookup["get"]>,
  workspace: string,
  id: string,
): Promise<IntentRow | undefined> {
  const rows = await database.$queryRaw<readonly IntentRow[]>`
    SELECT id, workspace_id, analysis_job_id, state, created_at, updated_at
    FROM publication_intents
    WHERE workspace_id = ${workspace} AND id = ${id}
  `;
  return rows[0];
}

export class PostgresPublicationIntentStore implements PublicationIntentStore {
  public constructor(private readonly unitOfWork: PublicationUnitOfWork) {}

  public async findProfile(
    transaction: ApplicationTransaction,
    input: Parameters<PublicationIntentStore["findProfile"]>[1],
  ): Promise<StoredPublicationProfile | undefined> {
    const rows = await this.unitOfWork.get(transaction).$queryRaw<
      readonly {
        readonly definition: Prisma.JsonValue;
        readonly destination_connector_configuration_version_id: string | null;
      }[]
    >`
      SELECT
        version.definition,
        version.destination_connector_configuration_version_id
      FROM publication_profile_versions AS version
      JOIN publication_profiles AS profile
        ON profile.workspace_id = version.workspace_id
        AND profile.id = version.publication_profile_id
        AND profile.lifecycle = 'active'
      JOIN connector_registrations AS destination
        ON destination.workspace_id = version.workspace_id
        AND destination.id = version.definition #>> '{destination,connectorInstanceId}'
        AND destination.lifecycle = 'active'
      JOIN connector_capabilities AS capability
        ON capability.workspace_id = destination.workspace_id
        AND capability.connector_registration_id = destination.id
        AND capability.capability = 'analysisDestination'
      JOIN administration_configurations AS configuration
        ON configuration.workspace_id = version.workspace_id
        AND configuration.id = destination.id
        AND configuration.resource_type = 'connector-instances'
        AND configuration.lifecycle = 'active'
      JOIN administration_configuration_versions AS configuration_version
        ON configuration_version.workspace_id = version.workspace_id
        AND configuration_version.id = version.destination_connector_configuration_version_id
        AND configuration_version.configuration_id = configuration.id
        AND configuration_version.descriptor_kind = 'connector'
      JOIN administration_descriptor_revisions AS descriptor
        ON descriptor.kind = configuration_version.descriptor_kind
        AND descriptor.type = configuration_version.descriptor_type
        AND descriptor.version = configuration_version.descriptor_version
        AND descriptor.descriptor -> 'connectorCapabilities' ? 'analysisDestination'
      WHERE version.workspace_id = ${input.workspaceId}
        AND version.publication_profile_id = ${input.profileId}
        AND version.version = ${input.profileVersion}
    `;
    const row = rows[0];
    if (
      row === undefined ||
      row.destination_connector_configuration_version_id === null
    ) {
      return undefined;
    }
    const profile = publicationProfileSchema.parse(row.definition);
    if (
      profile.id !== input.profileId ||
      profile.version !== input.profileVersion
    ) {
      throw new Error(
        "Publication profile definition does not match its version.",
      );
    }
    return Object.freeze({
      id: profile.id,
      version: profile.version,
      destinationConnectorInstanceId: profile.destination.connectorInstanceId,
      destinationConnectorConfigurationVersionId:
        row.destination_connector_configuration_version_id,
      policy: profile.policy,
    });
  }

  public async createOrFindIntent(
    transaction: ApplicationTransaction,
    input: Parameters<PublicationIntentStore["createOrFindIntent"]>[1],
  ): Promise<PublicationIntent> {
    const database = this.unitOfWork.get(transaction);
    const storedProfile = await this.findProfile(transaction, {
      workspaceId: input.workspaceId,
      profileId: input.profile.id,
      profileVersion: input.profile.version,
    });
    if (
      storedProfile === undefined ||
      storedProfile.destinationConnectorInstanceId !==
        input.profile.destinationConnectorInstanceId ||
      storedProfile.destinationConnectorConfigurationVersionId !==
        input.profile.destinationConnectorConfigurationVersionId
    ) {
      throw new Error("Publication profile destination is unavailable.");
    }
    const key = [
      input.workspaceId,
      input.analysisJobId,
      input.profile.id,
      input.profile.version,
      input.target.connectorInstanceId,
      input.target.resourceType,
      input.target.externalId,
    ].join(":");
    await database.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
    `;
    const existing = await database.$queryRaw<
      readonly (IntentRow & {
        readonly intent_hash: string;
        readonly destination_connector_configuration_version_id: string | null;
      })[]
    >`
      SELECT
        id, workspace_id, analysis_job_id, state, intent_hash, created_at,
        updated_at, destination_connector_configuration_version_id
      FROM publication_intents
      WHERE workspace_id = ${input.workspaceId}
        AND analysis_job_id = ${input.analysisJobId}
        AND publication_profile_version_id = (
          SELECT id
          FROM publication_profile_versions
          WHERE workspace_id = ${input.workspaceId}
            AND publication_profile_id = ${input.profile.id}
            AND version = ${input.profile.version}
        )
        AND target_connector_instance_id = ${input.target.connectorInstanceId}
        AND target_resource_type = ${input.target.resourceType}
        AND target_external_id = ${input.target.externalId}
    `;
    const found = existing[0];
    if (found !== undefined) {
      if (found.intent_hash !== input.intentHash) {
        throw new IdempotencyConflictError("publication.intent");
      }
      if (
        found.destination_connector_configuration_version_id === null ||
        found.destination_connector_configuration_version_id !==
          input.profile.destinationConnectorConfigurationVersionId
      ) {
        throw new PublicationExecutionError(
          "publication.configurationUnavailable",
          "Publication intent has no immutable destination configuration.",
          false,
        );
      }
      await this.bindExistingResult(database, input, found.id);
      const current = await intentRow(database, input.workspaceId, found.id);
      if (current === undefined) {
        throw new Error("Publication intent was not found.");
      }
      return asIntent(current);
    }
    const profileRows = await database.$queryRaw<
      readonly {
        readonly id: string;
        readonly destination_connector_configuration_version_id: string | null;
      }[]
    >`
      SELECT
        version.id,
        version.destination_connector_configuration_version_id
      FROM publication_profile_versions AS version
      JOIN publication_profiles AS profile
        ON profile.workspace_id = version.workspace_id
        AND profile.id = version.publication_profile_id
        AND profile.lifecycle = 'active'
      JOIN connector_registrations AS destination
        ON destination.workspace_id = version.workspace_id
        AND destination.id = version.definition #>> '{destination,connectorInstanceId}'
        AND destination.lifecycle = 'active'
      JOIN connector_capabilities AS capability
        ON capability.workspace_id = destination.workspace_id
        AND capability.connector_registration_id = destination.id
        AND capability.capability = 'analysisDestination'
      JOIN administration_configurations AS configuration
        ON configuration.workspace_id = version.workspace_id
        AND configuration.id = destination.id
        AND configuration.resource_type = 'connector-instances'
        AND configuration.lifecycle = 'active'
      JOIN administration_configuration_versions AS configuration_version
        ON configuration_version.workspace_id = version.workspace_id
        AND configuration_version.id = version.destination_connector_configuration_version_id
        AND configuration_version.configuration_id = configuration.id
        AND configuration_version.descriptor_kind = 'connector'
      JOIN administration_descriptor_revisions AS descriptor
        ON descriptor.kind = configuration_version.descriptor_kind
        AND descriptor.type = configuration_version.descriptor_type
        AND descriptor.version = configuration_version.descriptor_version
        AND descriptor.descriptor -> 'connectorCapabilities' ? 'analysisDestination'
      WHERE version.workspace_id = ${input.workspaceId}
        AND version.publication_profile_id = ${input.profile.id}
        AND version.version = ${input.profile.version}
      FOR KEY SHARE
    `;
    const profileVersion = profileRows[0];
    if (
      profileVersion === undefined ||
      profileVersion.destination_connector_configuration_version_id === null ||
      profileVersion.destination_connector_configuration_version_id !==
        input.profile.destinationConnectorConfigurationVersionId
    ) {
      throw new Error("Publication profile destination is unavailable.");
    }
    const resultRows = await database.$queryRaw<
      readonly { readonly id: string }[]
    >`
      SELECT id
      FROM analysis_results
      WHERE workspace_id = ${input.workspaceId}
        AND analysis_job_id = ${input.analysisJobId}
    `;
    const analysisResult = resultRows[0];
    const identity =
      analysisResult === undefined
        ? undefined
        : createPublicationIdentity({
            workspaceId: input.workspaceId,
            analysisResultId: analysisResult.id,
            publicationProfileId: input.profile.id,
            publicationProfileVersion: input.profile.version,
            destinationConnectorInstanceId:
              input.profile.destinationConnectorInstanceId,
            destinationConnectorConfigurationVersionId:
              input.profile.destinationConnectorConfigurationVersionId,
            target: input.target,
          });
    await database.$executeRaw`
      INSERT INTO publication_intents (
        id, workspace_id, analysis_job_id, state, intent_hash,
        publication_profile_version_id, target_connector_instance_id,
        target_resource_type, target_external_id,
        destination_connector_instance_id,
        destination_connector_configuration_version_id,
        analysis_result_id, identity_hash,
        publication_marker, created_at, updated_at
      ) VALUES (
        ${input.id}, ${input.workspaceId}, ${input.analysisJobId}, ${input.state},
        ${input.intentHash}, ${profileVersion.id},
        ${input.target.connectorInstanceId}, ${input.target.resourceType},
        ${input.target.externalId}, ${input.profile.destinationConnectorInstanceId},
        ${input.profile.destinationConnectorConfigurationVersionId},
        ${analysisResult?.id ?? null}, ${identity?.identityHash ?? null},
        ${identity?.marker.value ?? null},
        ${new Date(input.occurredAt)}, ${new Date(input.occurredAt)}
      )
    `;
    const created = await intentRow(database, input.workspaceId, input.id);
    if (created === undefined)
      throw new Error("Publication intent was not created.");
    return asIntent(created);
  }

  private async bindExistingResult(
    database: ReturnType<PostgresTransactionLookup["get"]>,
    input: Parameters<PublicationIntentStore["createOrFindIntent"]>[1],
    intentId: string,
  ): Promise<void> {
    const resultRows = await database.$queryRaw<
      readonly { readonly id: string }[]
    >`
      SELECT id
      FROM analysis_results
      WHERE workspace_id = ${input.workspaceId}
        AND analysis_job_id = ${input.analysisJobId}
    `;
    const result = resultRows[0];
    if (result === undefined) return;
    const identity = createPublicationIdentity({
      workspaceId: input.workspaceId,
      analysisResultId: result.id,
      publicationProfileId: input.profile.id,
      publicationProfileVersion: input.profile.version,
      destinationConnectorInstanceId:
        input.profile.destinationConnectorInstanceId,
      destinationConnectorConfigurationVersionId:
        input.profile.destinationConnectorConfigurationVersionId,
      target: input.target,
    });
    await database.$executeRaw`
      UPDATE publication_intents
      SET
        analysis_result_id = ${result.id},
        identity_hash = ${identity.identityHash},
        publication_marker = ${identity.marker.value}
      WHERE workspace_id = ${input.workspaceId}
        AND id = ${intentId}
        AND analysis_result_id IS NULL
    `;
    const rows = await database.$queryRaw<
      readonly {
        readonly analysis_result_id: string | null;
        readonly identity_hash: string | null;
        readonly publication_marker: string | null;
      }[]
    >`
      SELECT analysis_result_id, identity_hash, publication_marker
      FROM publication_intents
      WHERE workspace_id = ${input.workspaceId} AND id = ${intentId}
    `;
    const current = rows[0];
    if (
      current?.analysis_result_id !== result.id ||
      current.identity_hash !== identity.identityHash ||
      current.publication_marker !== identity.marker.value
    ) {
      throw new Error("Publication intent has a conflicting analysis result.");
    }
  }

  public async findIntent(
    transaction: ApplicationTransaction,
    input: Parameters<PublicationIntentStore["findIntent"]>[1],
  ): Promise<PublicationIntent | undefined> {
    const row = await intentRow(
      this.unitOfWork.get(transaction),
      input.workspaceId,
      input.publicationIntentId,
    );
    return row === undefined ? undefined : asIntent(row);
  }

  public async updateIntent(
    transaction: ApplicationTransaction,
    intent: PublicationIntent,
  ): Promise<void> {
    const updated = await this.unitOfWork.get(transaction).$executeRaw`
      UPDATE publication_intents
      SET state = ${intent.state}, updated_at = ${new Date(intent.updatedAt)}
      WHERE workspace_id = ${intent.workspaceId} AND id = ${intent.id}
    `;
    if (updated !== 1) throw new Error("Publication intent was not found.");
  }

  public async approveIntent(
    transaction: ApplicationTransaction,
    input: Parameters<PublicationIntentStore["approveIntent"]>[1],
  ): Promise<
    | {
        readonly outcome: "approved" | "alreadyApproved";
        readonly intent: PublicationIntent;
      }
    | { readonly outcome: "notApprovable" }
  > {
    const database = this.unitOfWork.get(transaction);
    const rows = await database.$queryRaw<
      readonly (IntentRow & {
        readonly approved_by_principal_id: string | null;
        readonly approved_at: Date | null;
      })[]
    >`
      SELECT
        id, workspace_id, analysis_job_id, state, created_at, updated_at,
        approved_by_principal_id, approved_at
      FROM publication_intents
      WHERE workspace_id = ${input.workspaceId}
        AND id = ${input.publicationIntentId}
      FOR UPDATE
    `;
    const intent = rows[0];
    if (intent === undefined) return { outcome: "notApprovable" };
    if (intent.state === "awaitingApproval") {
      const updated = await database.$executeRaw`
        UPDATE publication_intents
        SET
          state = 'pending',
          approved_by_principal_id = ${input.actorPrincipalId},
          approved_at = ${new Date(input.occurredAt)},
          updated_at = ${new Date(input.occurredAt)}
        WHERE workspace_id = ${input.workspaceId}
          AND id = ${input.publicationIntentId}
          AND state = 'awaitingApproval'
      `;
      if (updated !== 1) {
        throw new Error("Publication approval state changed unexpectedly.");
      }
      return {
        outcome: "approved",
        intent: asIntent({
          ...intent,
          state: "pending",
          updated_at: new Date(input.occurredAt),
        }),
      };
    }
    if (
      intent.approved_by_principal_id !== null &&
      intent.approved_at !== null
    ) {
      return { outcome: "alreadyApproved", intent: asIntent(intent) };
    }
    return { outcome: "notApprovable" };
  }

  public async bindAnalysisResult(
    transaction: ApplicationTransaction,
    input: Parameters<PublicationIntentStore["bindAnalysisResult"]>[1],
  ): Promise<void> {
    const database = this.unitOfWork.get(transaction);
    const resultRows = await database.$queryRaw<
      readonly { readonly id: string }[]
    >`
      SELECT id
      FROM analysis_results
      WHERE workspace_id = ${input.workspaceId}
        AND analysis_job_id = ${input.analysisJobId}
        AND id = ${input.analysisResultId}
      FOR KEY SHARE
    `;
    if (resultRows[0] === undefined) {
      throw new Error("Publication analysis result was not found.");
    }
    const intents = await database.$queryRaw<
      readonly {
        readonly id: string;
        readonly destination_connector_instance_id: string;
        readonly destination_connector_configuration_version_id: string | null;
        readonly target_connector_instance_id: string;
        readonly target_resource_type: string;
        readonly target_external_id: string;
        readonly publication_profile_id: string;
        readonly profile_version: string;
        readonly profile_destination_connector_configuration_version_id:
          | string
          | null;
        readonly analysis_result_id: string | null;
        readonly identity_hash: string | null;
        readonly publication_marker: string | null;
      }[]
    >`
      SELECT
        intent.id,
        intent.destination_connector_instance_id,
        intent.destination_connector_configuration_version_id,
        intent.target_connector_instance_id,
        intent.target_resource_type,
        intent.target_external_id,
        profile.publication_profile_id,
        profile.version AS profile_version,
        profile.destination_connector_configuration_version_id
          AS profile_destination_connector_configuration_version_id,
        intent.analysis_result_id,
        intent.identity_hash,
        intent.publication_marker
      FROM publication_intents AS intent
      JOIN publication_profile_versions AS profile
        ON profile.workspace_id = intent.workspace_id
        AND profile.id = intent.publication_profile_version_id
      WHERE intent.workspace_id = ${input.workspaceId}
        AND intent.analysis_job_id = ${input.analysisJobId}
      FOR UPDATE OF intent
    `;
    for (const intent of intents) {
      if (
        intent.destination_connector_configuration_version_id === null ||
        intent.profile_destination_connector_configuration_version_id ===
          null ||
        intent.destination_connector_configuration_version_id !==
          intent.profile_destination_connector_configuration_version_id
      ) {
        throw new PublicationExecutionError(
          "publication.configurationUnavailable",
          "Publication intent has no immutable destination configuration.",
          false,
        );
      }
      const identity = createPublicationIdentity({
        workspaceId: input.workspaceId,
        analysisResultId: input.analysisResultId,
        publicationProfileId: intent.publication_profile_id,
        publicationProfileVersion: intent.profile_version,
        destinationConnectorInstanceId:
          intent.destination_connector_instance_id,
        destinationConnectorConfigurationVersionId:
          intent.destination_connector_configuration_version_id,
        target: {
          connectorInstanceId: intent.target_connector_instance_id,
          resourceType: intent.target_resource_type,
          externalId: intent.target_external_id,
        },
      });
      if (intent.analysis_result_id === null) {
        await database.$executeRaw`
          UPDATE publication_intents
          SET
            analysis_result_id = ${input.analysisResultId},
            identity_hash = ${identity.identityHash},
            publication_marker = ${identity.marker.value}
          WHERE workspace_id = ${input.workspaceId}
            AND id = ${intent.id}
            AND analysis_result_id IS NULL
        `;
        continue;
      }
      if (
        intent.analysis_result_id !== input.analysisResultId ||
        intent.identity_hash !== identity.identityHash ||
        intent.publication_marker !== identity.marker.value
      ) {
        throw new Error(
          "Publication intent has a conflicting analysis result.",
        );
      }
    }
  }

  public async findReadyIntentIds(
    transaction: ApplicationTransaction,
    input: Parameters<PublicationIntentStore["findReadyIntentIds"]>[1],
  ) {
    const rows = await this.unitOfWork.get(transaction).$queryRaw<
      readonly { readonly id: string }[]
    >`
      SELECT intent.id
      FROM publication_intents AS intent
      JOIN analysis_jobs AS job
        ON job.workspace_id = intent.workspace_id
        AND job.id = intent.analysis_job_id
      WHERE intent.workspace_id = ${input.workspaceId}
        AND intent.analysis_job_id = ${input.analysisJobId}
        AND intent.state = 'pending'
        AND intent.analysis_result_id IS NOT NULL
        AND job.state = 'completed'
      ORDER BY intent.id
    `;
    return Object.freeze(rows.map((row) => publicationIntentId(row.id)));
  }

  public async enqueuePublication(
    transaction: ApplicationTransaction,
    envelope: Envelope,
  ): Promise<void> {
    await this.unitOfWork.get(transaction).$executeRaw`
      INSERT INTO outbox_envelopes (
        id, workspace_id, kind, type, schema_version, occurred_at,
        correlation_id, causation_id, trace_context, payload, available_at
      ) VALUES (
        ${envelope.id}, ${envelope.workspaceId}, ${envelope.kind},
        ${envelope.type}, ${envelope.schemaVersion}, ${new Date(envelope.occurredAt)},
        ${envelope.correlationId}, ${envelope.causationId},
        ${
          envelope.traceContext === undefined
            ? null
            : JSON.stringify(envelope.traceContext)
        }::jsonb,
        ${JSON.stringify(envelope.payload)}::jsonb, ${new Date(envelope.occurredAt)}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
}

export class PostgresPublicationExecutionStore
  implements PublicationExecutionStore
{
  public constructor(private readonly unitOfWork: PublicationUnitOfWork) {}

  public async findCandidate(
    transaction: ApplicationTransaction,
    input: Parameters<PublicationExecutionStore["findCandidate"]>[1],
  ): Promise<PublicationCandidate | undefined> {
    const rows = await this.unitOfWork.get(transaction).$queryRaw<
      readonly CandidateRow[]
    >`
      SELECT
        intent.id, intent.workspace_id, intent.analysis_job_id, intent.state,
        intent.created_at, intent.updated_at, result.id AS analysis_result_id,
        intent.identity_hash, intent.publication_marker,
        intent.target_connector_instance_id, intent.target_resource_type,
        intent.target_external_id, intent.destination_connector_instance_id,
        intent.destination_connector_configuration_version_id,
        profile.publication_profile_id, profile.version AS profile_version,
        profile.destination_connector_configuration_version_id
          AS profile_destination_connector_configuration_version_id,
        profile.definition, result.record
      FROM publication_intents AS intent
      JOIN analysis_results AS result
        ON result.workspace_id = intent.workspace_id
        AND result.analysis_job_id = intent.analysis_job_id
      JOIN publication_profile_versions AS profile
        ON profile.workspace_id = intent.workspace_id
        AND profile.id = intent.publication_profile_version_id
      WHERE intent.workspace_id = ${input.workspaceId}
        AND intent.id = ${input.publicationIntentId}
    `;
    const row = rows[0];
    return row === undefined ? undefined : candidateFromRow(row);
  }

  public async prepare(
    transaction: ApplicationTransaction,
    input: Parameters<PublicationExecutionStore["prepare"]>[1],
  ): Promise<PublicationAttempt | undefined> {
    const database = this.unitOfWork.get(transaction);
    const rows = await database.$queryRaw<
      readonly {
        readonly state: string;
        readonly analysis_result_id: string | null;
        readonly identity_hash: string | null;
        readonly publication_marker: string | null;
      }[]
    >`
      SELECT state, analysis_result_id, identity_hash, publication_marker
      FROM publication_intents
      WHERE workspace_id = ${input.candidate.intent.workspaceId}
        AND id = ${input.candidate.intent.id}
      FOR UPDATE
    `;
    const current = rows[0];
    const allowed =
      current?.state === "pending" ||
      current?.state === "failed" ||
      (input.allowOutcomeUnknown && current?.state === "outcomeUnknown");
    if (
      !allowed ||
      current.analysis_result_id !== input.candidate.analysisResultId ||
      current.identity_hash !== input.identityHash ||
      current.publication_marker !== input.marker
    ) {
      return undefined;
    }
    const updated = await database.$executeRaw`
      UPDATE publication_intents
      SET
        state = 'publishing',
        updated_at = ${new Date(input.now)}
      WHERE workspace_id = ${input.candidate.intent.workspaceId}
        AND id = ${input.candidate.intent.id}
    `;
    if (updated !== 1) return undefined;
    const ordinals = await database.$queryRaw<
      readonly { readonly ordinal: number }[]
    >`
      SELECT COALESCE(MAX(attempt_ordinal), -1)::integer + 1 AS ordinal
      FROM publication_attempts
      WHERE workspace_id = ${input.candidate.intent.workspaceId}
        AND publication_intent_id = ${input.candidate.intent.id}
    `;
    const ordinal = ordinals[0]?.ordinal;
    if (ordinal === undefined)
      throw new Error("Publication attempt ordinal is missing.");
    const id = `publication-attempt:${sha256(`${input.candidate.intent.id}:${ordinal}`)}`;
    await database.$executeRaw`
      INSERT INTO publication_attempts (
        id, workspace_id, publication_intent_id, attempt_ordinal, state,
        identity_hash, publication_marker,
        destination_connector_configuration_version_id, created_at
      ) VALUES (
        ${id}, ${input.candidate.intent.workspaceId}, ${input.candidate.intent.id},
        ${ordinal}, 'publishing', ${input.identityHash}, ${input.marker},
        ${input.candidate.destination.connectorConfigurationVersionId},
        ${new Date(input.now)}
      )
    `;
    return Object.freeze({ id });
  }

  public async recordPublished(
    transaction: ApplicationTransaction,
    input: Parameters<PublicationExecutionStore["recordPublished"]>[1],
  ): Promise<void> {
    const database = this.unitOfWork.get(transaction);
    const updated = await database.$executeRaw`
      UPDATE publication_intents
      SET state = 'published', updated_at = ${new Date(input.now)}
      WHERE workspace_id = ${input.candidate.intent.workspaceId}
        AND id = ${input.candidate.intent.id}
        AND state = 'publishing'
    `;
    if (updated !== 1)
      throw new Error("Publication intent is no longer publishing.");
    await database.$executeRaw`
      UPDATE publication_attempts
      SET state = 'published', finished_at = ${new Date(input.now)},
          receipt = ${JSON.stringify(json(input.receipt))}::jsonb
      WHERE workspace_id = ${input.candidate.intent.workspaceId}
        AND id = ${input.attempt.id}
        AND state = 'publishing'
    `;
  }

  public async recordOutcomeUnknown(
    transaction: ApplicationTransaction,
    input: Parameters<PublicationExecutionStore["recordOutcomeUnknown"]>[1],
  ): Promise<void> {
    const database = this.unitOfWork.get(transaction);
    const updated = await database.$executeRaw`
      UPDATE publication_intents
      SET state = 'outcomeUnknown', updated_at = ${new Date(input.now)}
      WHERE workspace_id = ${input.candidate.intent.workspaceId}
        AND id = ${input.candidate.intent.id}
        AND state = 'publishing'
    `;
    if (updated !== 1)
      throw new Error("Publication intent is no longer publishing.");
    await database.$executeRaw`
      UPDATE publication_attempts
      SET state = 'outcomeUnknown', finished_at = ${new Date(input.now)}
      WHERE workspace_id = ${input.candidate.intent.workspaceId}
        AND id = ${input.attempt.id}
        AND state = 'publishing'
    `;
  }

  public async recordFailure(
    transaction: ApplicationTransaction,
    input: Parameters<PublicationExecutionStore["recordFailure"]>[1],
  ): Promise<void> {
    const database = this.unitOfWork.get(transaction);
    const updated = await database.$executeRaw`
      UPDATE publication_intents
      SET state = 'failed', updated_at = ${new Date(input.now)}
      WHERE workspace_id = ${input.candidate.intent.workspaceId}
        AND id = ${input.candidate.intent.id}
        AND state = 'publishing'
    `;
    if (updated !== 1)
      throw new Error("Publication intent is no longer publishing.");
    await database.$executeRaw`
      UPDATE publication_attempts
      SET
        state = 'failed', finished_at = ${new Date(input.now)},
        error_code = ${input.error.code}, error_retryable = ${input.error.retryable}
      WHERE workspace_id = ${input.candidate.intent.workspaceId}
        AND id = ${input.attempt.id}
        AND state = 'publishing'
    `;
  }

  public async findOutcomeUnknown(
    transaction: ApplicationTransaction,
    input: Parameters<PublicationExecutionStore["findOutcomeUnknown"]>[1],
  ) {
    const rows = await this.unitOfWork.get(transaction).$queryRaw<
      readonly { readonly id: string }[]
    >`
      SELECT id
      FROM publication_intents
      WHERE workspace_id = ${input.workspaceId}
        AND state = 'outcomeUnknown'
      ORDER BY updated_at, id
      LIMIT ${input.limit}
    `;
    return Object.freeze(rows.map((row) => publicationIntentId(row.id)));
  }
}

export class PostgresVerifiedWebhookEventStore
  implements VerifiedWebhookEventStore
{
  public constructor(private readonly unitOfWork: PublicationUnitOfWork) {}

  public async persist(
    event: VerifiedWebhookEvent,
  ): Promise<VerifiedWebhookStoreResult> {
    return this.unitOfWork.transaction(async (transaction) => {
      const database = this.unitOfWork.get(transaction);
      const id = `webhook-inbox:${sha256(`${event.endpointId}:${event.deliveryKey}`)}`;
      const inserted = await database.$queryRaw<
        readonly { readonly id: string }[]
      >`
        INSERT INTO webhook_inbox (
          id, workspace_id, endpoint_id, endpoint_configuration_version_id,
          connector_configuration_version_id, connector_instance_id,
          analysis_trigger_id, automated_principal_id, delivery_key, raw_body_digest,
          verification, signals, received_at
        ) VALUES (
          ${id}, ${event.workspaceId}, ${event.endpointId},
          ${event.endpointConfigurationVersionId},
          ${event.connectorConfigurationVersionId},
          ${event.connectorInstanceId}, ${event.analysisTriggerId ?? null},
          ${event.automatedPrincipalId ?? null},
          ${event.deliveryKey}, ${event.rawBodyDigest},
          ${JSON.stringify(event.verification)}::jsonb,
          ${JSON.stringify(event.signals)}::jsonb, ${new Date(event.receivedAt)}
        )
        ON CONFLICT (endpoint_id, delivery_key) DO NOTHING
        RETURNING id
      `;
      if (inserted[0] === undefined) {
        const existing = await database.$queryRaw<
          readonly { readonly raw_body_digest: string }[]
        >`
          SELECT raw_body_digest
          FROM webhook_inbox
          WHERE endpoint_id = ${event.endpointId}
            AND delivery_key = ${event.deliveryKey}
        `;
        return existing[0]?.raw_body_digest === event.rawBodyDigest
          ? "duplicate"
          : "idempotencyConflict";
      }
      if (event.analysisTriggerId === undefined) return "accepted";
      if (event.automatedPrincipalId === undefined) {
        throw new PostgresVerifiedWebhookEventStoreError();
      }
      const resolved = await database.$queryRaw<readonly WebhookTriggerRow[]>`
        SELECT
          trigger.id AS trigger_id,
          version.id AS trigger_version_id,
          version.analysis_profile_version_id,
          version.connector_registration_id,
          version.connector_configuration_version_id
        FROM analysis_triggers AS trigger
        JOIN analysis_trigger_versions AS version
          ON version.workspace_id = trigger.workspace_id
         AND version.id = trigger.current_version_id
         AND version.analysis_trigger_id = trigger.id
        JOIN connector_registrations AS connector
          ON connector.workspace_id = version.workspace_id
         AND connector.id = version.connector_registration_id
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
         AND connector_version.id = version.connector_configuration_version_id
         AND connector_version.configuration_id = configuration.id
         AND connector_version.descriptor_kind = 'connector'
        JOIN administration_descriptor_revisions AS descriptor
          ON descriptor.kind = connector_version.descriptor_kind
         AND descriptor.type = connector_version.descriptor_type
         AND descriptor.version = connector_version.descriptor_version
         AND descriptor.descriptor -> 'connectorCapabilities' ? 'caseSource'
        JOIN principals AS actor
          ON actor.workspace_id = trigger.workspace_id
         AND actor.id = ${event.automatedPrincipalId}
        WHERE trigger.workspace_id = ${event.workspaceId}
          AND trigger.id = ${event.analysisTriggerId}
          AND trigger.lifecycle = 'active'
          AND version.connector_registration_id = ${event.connectorInstanceId}
          AND version.connector_configuration_version_id = ${event.connectorConfigurationVersionId}
        FOR UPDATE OF trigger
      `;
      const trigger = resolved[0];
      if (trigger === undefined || resolved.length !== 1) {
        throw new PostgresVerifiedWebhookEventStoreError();
      }
      for (const [index, signal] of event.signals.entries()) {
        if (signal.kind !== "caseChanged") continue;
        if (
          signal.reference.connectorInstanceId !== event.connectorInstanceId
        ) {
          throw new PostgresVerifiedWebhookEventStoreError();
        }
        const target = signal.reference;
        const occurrenceKey = `webhook:${event.deliveryKey}:${index}`;
        const requestIdentity = [
          "caseweaver.analysis-trigger.webhook.v2",
          event.workspaceId,
          event.endpointId,
          event.deliveryKey,
          String(index),
          trigger.trigger_version_id,
          target.connectorInstanceId,
          target.resourceType,
          target.externalId,
        ].join("\u0000");
        const identityHash = sha256(requestIdentity);
        const triggerRequestId = `analysis-trigger-request:webhook:${identityHash}`;
        const idempotencyKeyDigest = sha256(
          `idempotency\u0000${requestIdentity}`,
        );
        const requestDigest = sha256(`request\u0000${requestIdentity}`);
        await database.$executeRaw`
          INSERT INTO analysis_trigger_requests (
            id, workspace_id, actor_principal_id, analysis_trigger_version_id,
            analysis_profile_version_id, connector_registration_id,
            connector_configuration_version_id, source, occurrence_key,
            target_connector_instance_id, target_resource_type, target_external_id,
            idempotency_key_digest, request_digest, state, created_at, updated_at
          ) VALUES (
            ${triggerRequestId}, ${event.workspaceId}, ${event.automatedPrincipalId},
            ${trigger.trigger_version_id}, ${trigger.analysis_profile_version_id},
            ${trigger.connector_registration_id},
            ${trigger.connector_configuration_version_id}, 'webhook', ${occurrenceKey},
            ${target.connectorInstanceId}, ${target.resourceType}, ${target.externalId},
            ${idempotencyKeyDigest}, ${requestDigest}, 'pending',
            ${new Date(event.receivedAt)}, ${new Date(event.receivedAt)}
          )
        `;
        await database.$executeRaw`
          INSERT INTO idempotency_records (
            workspace_id, operation, key_digest, request_digest, resource_id, created_at
          ) VALUES (
            ${event.workspaceId}, 'analysis.trigger', ${idempotencyKeyDigest},
            ${requestDigest}, ${triggerRequestId}, ${new Date(event.receivedAt)}
          )
        `;
        const envelopeId = `analysis-trigger-webhook:${identityHash}`;
        const envelopeContext = `webhook:${event.deliveryKey}`;
        await database.$executeRaw`
          INSERT INTO outbox_envelopes (
            id, workspace_id, kind, type, schema_version, occurred_at,
            correlation_id, causation_id, payload, available_at
          ) VALUES (
            ${envelopeId}, ${event.workspaceId}, 'command', 'analysis.trigger.v2', 1,
            ${new Date(event.receivedAt)}, ${envelopeContext}, ${envelopeContext},
            ${JSON.stringify({
              triggerRequestId,
              triggerId: trigger.trigger_id,
              triggerVersionId: trigger.trigger_version_id,
              connectorRegistrationId: trigger.connector_registration_id,
              connectorConfigurationVersionId:
                trigger.connector_configuration_version_id,
              source: "webhook",
              occurrenceKey,
              target,
            })}::jsonb, ${new Date(event.receivedAt)}
          )
        `;
        await database.$executeRaw`
          INSERT INTO audit_events (
            id, workspace_id, actor_principal_id, action, target_id, after_hash, occurred_at
          ) VALUES (
            ${`audit:analysis-trigger-webhook:${identityHash}`},
            ${event.workspaceId}, ${event.automatedPrincipalId},
            'analysis.trigger.requested', ${triggerRequestId}, ${requestDigest},
            ${new Date(event.receivedAt)}
          )
        `;
      }
      return "accepted";
    });
  }
}
