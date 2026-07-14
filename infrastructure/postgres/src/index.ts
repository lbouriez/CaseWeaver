import { randomUUID } from "node:crypto";
import type {
  AnalysisIdentityRecord,
  AnalysisRequestStore,
  ApplicationTransaction,
  AuditStore,
  AuthorizationGuard,
  BootstrapInstallation,
  BootstrapWorkspaceStore,
  ClaimedOutboxEnvelope,
  ExecutionContext,
  OutboxStore,
  PublicationIntentStore,
  ResourceLeaseStore,
  UnitOfWork,
} from "@caseweaver/application";
import {
  type AnalysisJob,
  type AnalysisJobState,
  analysisIdentityId,
  analysisJobId,
  DomainValidationError,
  deserializeEnvelope,
  type Envelope,
  type PrincipalId,
  principalId,
  type UtcInstant,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import {
  isWorkspaceRole,
  requirePermission,
  type AuditRecord,
  type WorkspaceRole,
} from "@caseweaver/security";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "@prisma/client";

import {
  PostgresAnalysisExecutionStore,
  PostgresCaseSnapshotTombstoneStore,
} from "./analysis/index.js";
import {
  PostgresPublicationExecutionStore,
  PostgresPublicationIntentStore,
  PostgresVerifiedWebhookEventStore,
} from "./publication/index.js";

export * from "./retrieval/index.js";

type PrismaTransaction = Prisma.TransactionClient;

export interface PostgresTransactionLookup {
  get(transaction: ApplicationTransaction): PrismaTransaction;
}

class PrismaUnitOfWork implements UnitOfWork, PostgresTransactionLookup {
  private readonly transactions = new WeakMap<
    ApplicationTransaction,
    PrismaTransaction
  >();

  public constructor(private readonly client: PrismaClient) {}

  public async transaction<Result>(
    operation: (transaction: ApplicationTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.client.$transaction(async (database) => {
      const transaction = Object.freeze({}) as ApplicationTransaction;
      this.transactions.set(transaction, database);
      try {
        return await operation(transaction);
      } finally {
        this.transactions.delete(transaction);
      }
    });
  }

  public get(transaction: ApplicationTransaction): PrismaTransaction {
    const database = this.transactions.get(transaction);
    if (database === undefined) {
      throw new Error(
        "A PostgreSQL repository method requires an active transaction.",
      );
    }
    return database;
  }
}

function asDate(value: UtcInstant): Date {
  return new Date(value);
}

function asUtcInstant(value: Date): UtcInstant {
  return utcInstant(value);
}

function asAnalysisJobState(value: string): AnalysisJobState {
  if (
    value !== "queued" &&
    value !== "running" &&
    value !== "completed" &&
    value !== "failed" &&
    value !== "cancelled"
  ) {
    throw new DomainValidationError("Persisted analysis job state is invalid.");
  }
  return value;
}

function toAnalysisJob(row: {
  readonly id: string;
  readonly workspaceId: string;
  readonly analysisIdentityId: string;
  readonly runOrdinal: number;
  readonly state: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): AnalysisJob {
  return Object.freeze({
    id: analysisJobId(row.id),
    workspaceId: workspaceId(row.workspaceId),
    analysisIdentityId: analysisIdentityId(row.analysisIdentityId),
    runOrdinal: row.runOrdinal,
    state: asAnalysisJobState(row.state),
    createdAt: asUtcInstant(row.createdAt),
    updatedAt: asUtcInstant(row.updatedAt),
  });
}

class PostgresBootstrapStore implements BootstrapWorkspaceStore {
  public constructor(
    private readonly transactions: PostgresTransactionLookup,
  ) {}

  public async lockInstallation(
    transaction: ApplicationTransaction,
  ): Promise<BootstrapInstallation | undefined> {
    const database = this.transactions.get(transaction);
    await database.$executeRaw`
      INSERT INTO installation_state (singleton)
      VALUES (true)
      ON CONFLICT (singleton) DO NOTHING
    `;
    const rows = await database.$queryRaw<
      readonly {
        readonly workspace_id: string | null;
        readonly principal_id: string | null;
      }[]
    >`
      SELECT workspace_id, principal_id
      FROM installation_state
      WHERE singleton = true
      FOR UPDATE
    `;
    const installation = rows[0];
    if (
      installation === undefined ||
      installation.workspace_id === null ||
      installation.principal_id === null
    ) {
      return undefined;
    }

    return Object.freeze({
      workspaceId: workspaceId(installation.workspace_id),
      principalId: principalId(installation.principal_id),
    });
  }

  public async createWorkspace(
    transaction: ApplicationTransaction,
    id: ReturnType<typeof workspaceId>,
    occurredAt: UtcInstant,
  ): Promise<void> {
    await this.transactions.get(transaction).workspace.create({
      data: { id, createdAt: asDate(occurredAt) },
    });
  }

  public async createPrincipal(
    transaction: ApplicationTransaction,
    input: {
      readonly workspaceId: ReturnType<typeof workspaceId>;
      readonly principalId: PrincipalId;
      readonly occurredAt: UtcInstant;
    },
  ): Promise<void> {
    await this.transactions.get(transaction).principal.create({
      data: {
        id: input.principalId,
        workspaceId: input.workspaceId,
        createdAt: asDate(input.occurredAt),
      },
    });
  }

  public async assignWorkspaceRole(
    transaction: ApplicationTransaction,
    assignment: {
      readonly workspaceId: ReturnType<typeof workspaceId>;
      readonly principalId: PrincipalId;
      readonly role: WorkspaceRole;
      readonly occurredAt: UtcInstant;
    },
  ): Promise<void> {
    await this.transactions.get(transaction).workspaceRoleAssignment.create({
      data: {
        workspaceId: assignment.workspaceId,
        principalId: assignment.principalId,
        role: assignment.role,
        createdAt: asDate(assignment.occurredAt),
      },
    });
  }

  public async completeInstallation(
    transaction: ApplicationTransaction,
    installation: BootstrapInstallation,
    occurredAt: UtcInstant,
  ): Promise<void> {
    await this.transactions.get(transaction).installationState.update({
      where: { singleton: true },
      data: {
        workspaceId: installation.workspaceId,
        principalId: installation.principalId,
        initializedAt: asDate(occurredAt),
      },
    });
  }
}

class PostgresAuditStore implements AuditStore {
  public constructor(
    private readonly transactions: PostgresTransactionLookup,
  ) {}

  public async append(
    transaction: ApplicationTransaction,
    record: AuditRecord,
  ): Promise<void> {
    await this.transactions.get(transaction).auditEvent.create({
      data: {
        id: record.id,
        workspaceId: record.workspaceId,
        actorPrincipalId: record.actorPrincipalId,
        action: record.action,
        targetId: record.targetId,
        beforeHash: record.beforeHash,
        afterHash: record.afterHash,
        occurredAt: asDate(record.occurredAt),
      },
    });
  }
}

class PostgresAuthorizationGuard implements AuthorizationGuard {
  public constructor(
    private readonly unitOfWork: UnitOfWork & PostgresTransactionLookup,
  ) {}

  public async require(
    context: ExecutionContext,
    permission: Parameters<AuthorizationGuard["require"]>[1],
  ): Promise<void> {
    await this.unitOfWork.transaction(async (transaction) => {
      const assignments = await this.unitOfWork
        .get(transaction)
        .workspaceRoleAssignment.findMany({
          where: {
            workspaceId: context.workspaceId,
            principalId: context.principalId,
          },
          select: { role: true },
        });
      const roles = assignments.map((assignment) => {
        if (!isWorkspaceRole(assignment.role)) {
          throw new DomainValidationError(
            "Persisted workspace role is invalid.",
          );
        }
        return {
          workspaceId: context.workspaceId,
          principalId: context.principalId,
          role: assignment.role,
        };
      });
      requirePermission(
        roles,
        context.workspaceId,
        context.principalId,
        permission,
      );
    });
  }
}

class PostgresAnalysisRequestStore implements AnalysisRequestStore {
  public constructor(
    private readonly transactions: PostgresTransactionLookup,
  ) {}

  public async lockIdempotencyKey(
    transaction: ApplicationTransaction,
    input: Parameters<AnalysisRequestStore["lockIdempotencyKey"]>[1],
  ): Promise<void> {
    const key = `${input.workspaceId}:${input.operation}:${input.keyDigest}`;
    await this.transactions.get(transaction).$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
    `;
  }

  public async findIdempotency(
    transaction: ApplicationTransaction,
    input: Parameters<AnalysisRequestStore["findIdempotency"]>[1],
  ) {
    const row = await this.transactions
      .get(transaction)
      .idempotencyRecord.findUnique({
        where: {
          workspaceId_operation_keyDigest: input,
        },
      });
    if (row === null) {
      return undefined;
    }
    return Object.freeze({
      requestDigest: row.requestDigest as Parameters<
        AnalysisRequestStore["recordIdempotency"]
      >[1]["requestDigest"],
      resourceId: analysisJobId(row.resourceId),
    });
  }

  public async recordIdempotency(
    transaction: ApplicationTransaction,
    input: Parameters<AnalysisRequestStore["recordIdempotency"]>[1],
  ): Promise<void> {
    await this.transactions.get(transaction).idempotencyRecord.create({
      data: {
        workspaceId: input.workspaceId,
        operation: input.operation,
        keyDigest: input.keyDigest,
        requestDigest: input.requestDigest,
        resourceId: input.resourceId,
        createdAt: asDate(input.occurredAt),
      },
    });
  }

  public async findOrCreateIdentity(
    transaction: ApplicationTransaction,
    input: Parameters<AnalysisRequestStore["findOrCreateIdentity"]>[1],
  ): Promise<AnalysisIdentityRecord> {
    const database = this.transactions.get(transaction);
    const lockKey = `${input.workspaceId}:analysis-identity:${input.identityHash}`;
    await database.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    `;
    const existing = await database.analysisIdentity.findUnique({
      where: {
        workspaceId_identityHash: {
          workspaceId: input.workspaceId,
          identityHash: input.identityHash,
        },
      },
    });
    const row =
      existing ??
      (await database.analysisIdentity.create({
        data: {
          id: input.id,
          workspaceId: input.workspaceId,
          identityHash: input.identityHash,
          analysisProfileVersionId: input.analysisProfileVersionId,
          caseSnapshotId: input.caseSnapshotId,
          createdAt: asDate(input.occurredAt),
        },
      }));
    if (
      row.analysisProfileVersionId !== input.analysisProfileVersionId ||
      row.caseSnapshotId !== input.caseSnapshotId
    ) {
      throw new DomainValidationError(
        "Analysis identity hash resolves to different immutable inputs.",
      );
    }
    return Object.freeze({
      id: analysisIdentityId(row.id),
      workspaceId: workspaceId(row.workspaceId),
      identityHash: row.identityHash as AnalysisIdentityRecord["identityHash"],
      analysisProfileVersionId:
        row.analysisProfileVersionId as AnalysisIdentityRecord["analysisProfileVersionId"],
      caseSnapshotId:
        row.caseSnapshotId as AnalysisIdentityRecord["caseSnapshotId"],
    });
  }

  public async findJobByRunOrdinal(
    transaction: ApplicationTransaction,
    input: Parameters<AnalysisRequestStore["findJobByRunOrdinal"]>[1],
  ): Promise<AnalysisJob | undefined> {
    const row = await this.transactions.get(transaction).analysisJob.findFirst({
      where: {
        workspaceId: input.workspaceId,
        analysisIdentityId: input.analysisIdentityId,
        runOrdinal: input.runOrdinal,
      },
    });
    return row === null ? undefined : toAnalysisJob(row);
  }

  public async createJob(
    transaction: ApplicationTransaction,
    job: AnalysisJob,
  ): Promise<void> {
    await this.transactions.get(transaction).analysisJob.create({
      data: {
        id: job.id,
        workspaceId: job.workspaceId,
        analysisIdentityId: job.analysisIdentityId,
        runOrdinal: job.runOrdinal,
        state: job.state,
        createdAt: asDate(job.createdAt),
        updatedAt: asDate(job.updatedAt),
      },
    });
  }

  public async lockIdentityForRerun(
    transaction: ApplicationTransaction,
    input: Parameters<AnalysisRequestStore["lockIdentityForRerun"]>[1],
  ): Promise<{
    readonly identity: AnalysisIdentityRecord;
    readonly nextRunOrdinal: number;
  }> {
    const database = this.transactions.get(transaction);
    const locked = await database.$queryRaw<readonly { readonly id: string }[]>`
      SELECT id
      FROM analysis_identities
      WHERE workspace_id = ${input.workspaceId}
        AND id = ${input.analysisIdentityId}
      FOR UPDATE
    `;
    if (locked[0] === undefined) {
      throw new Error("Analysis identity was not found.");
    }
    const identity = await database.analysisIdentity.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: input.analysisIdentityId,
        },
      },
    });
    if (identity === null) {
      throw new Error("Analysis identity was not found.");
    }
    const latest = await database.analysisJob.findFirst({
      where: {
        workspaceId: input.workspaceId,
        analysisIdentityId: input.analysisIdentityId,
      },
      orderBy: { runOrdinal: "desc" },
      select: { runOrdinal: true },
    });
    return Object.freeze({
      identity: {
        id: analysisIdentityId(identity.id),
        workspaceId: workspaceId(identity.workspaceId),
        identityHash:
          identity.identityHash as AnalysisIdentityRecord["identityHash"],
        analysisProfileVersionId:
          identity.analysisProfileVersionId as AnalysisIdentityRecord["analysisProfileVersionId"],
        caseSnapshotId:
          identity.caseSnapshotId as AnalysisIdentityRecord["caseSnapshotId"],
      },
      nextRunOrdinal: (latest?.runOrdinal ?? -1) + 1,
    });
  }

  public async findJob(
    transaction: ApplicationTransaction,
    input: Parameters<AnalysisRequestStore["findJob"]>[1],
  ): Promise<AnalysisJob | undefined> {
    const row = await this.transactions
      .get(transaction)
      .analysisJob.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.analysisJobId,
          },
        },
      });
    return row === null ? undefined : toAnalysisJob(row);
  }

  public async updateJobState(
    transaction: ApplicationTransaction,
    job: AnalysisJob,
  ): Promise<void> {
    const result = await this.transactions
      .get(transaction)
      .analysisJob.updateMany({
        where: { id: job.id, workspaceId: job.workspaceId },
        data: { state: job.state, updatedAt: asDate(job.updatedAt) },
      });
    if (result.count !== 1) {
      throw new Error("Analysis job was not found in its workspace.");
    }
  }
}

interface OutboxRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly kind: string;
  readonly type: string;
  readonly schema_version: number;
  readonly occurred_at: Date;
  readonly correlation_id: string;
  readonly causation_id: string;
  readonly payload: unknown;
}

class PostgresOutboxStore implements OutboxStore {
  public constructor(
    private readonly transactions: PostgresTransactionLookup,
  ) {}

  public async append(
    transaction: ApplicationTransaction,
    envelope: Envelope,
  ): Promise<void> {
    await this.transactions.get(transaction).outboxEnvelope.create({
      data: {
        id: envelope.id,
        workspaceId: envelope.workspaceId,
        kind: envelope.kind,
        type: envelope.type,
        schemaVersion: envelope.schemaVersion,
        occurredAt: asDate(envelope.occurredAt),
        correlationId: envelope.correlationId,
        causationId: envelope.causationId,
        payload: envelope.payload as Prisma.InputJsonValue,
        availableAt: asDate(envelope.occurredAt),
      },
    });
  }

  public async claim(
    transaction: ApplicationTransaction,
    input: Parameters<OutboxStore["claim"]>[1],
  ): Promise<readonly ClaimedOutboxEnvelope[]> {
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    ) {
      throw new RangeError("Outbox claim limit must be between 1 and 100.");
    }
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1) {
      throw new RangeError("Outbox lease duration must be positive.");
    }
    const claimToken = randomUUID();
    const rows = await this.transactions.get(transaction).$queryRaw<
      readonly OutboxRow[]
    >`
      WITH selected AS (
        SELECT id
        FROM outbox_envelopes
        WHERE delivered_at IS NULL
          AND available_at <= NOW()
          AND (claimed_until IS NULL OR claimed_until <= NOW())
        ORDER BY occurred_at, id
        LIMIT ${input.limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox_envelopes AS envelope
      SET
        claim_token = ${claimToken},
        claimed_until = NOW() + (${input.leaseMs} * INTERVAL '1 millisecond'),
        claim_attempts = envelope.claim_attempts + 1
      FROM selected
      WHERE envelope.id = selected.id
      RETURNING
        envelope.id,
        envelope.workspace_id,
        envelope.kind,
        envelope.type,
        envelope.schema_version,
        envelope.occurred_at,
        envelope.correlation_id,
        envelope.causation_id,
        envelope.payload
    `;
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          claimToken,
          envelope: deserializeEnvelope({
            id: row.id,
            workspaceId: row.workspace_id,
            kind: row.kind,
            type: row.type,
            schemaVersion: row.schema_version,
            occurredAt: row.occurred_at.toISOString(),
            correlationId: row.correlation_id,
            causationId: row.causation_id,
            payload: row.payload,
          }),
        }),
      ),
    );
  }

  public async acknowledge(
    transaction: ApplicationTransaction,
    claim: ClaimedOutboxEnvelope,
    deliveredAt: UtcInstant,
  ): Promise<void> {
    const updated = await this.transactions.get(transaction).$executeRaw`
      UPDATE outbox_envelopes
      SET
        delivered_at = ${asDate(deliveredAt)},
        claim_token = NULL,
        claimed_until = NULL
      WHERE id = ${claim.envelope.id}
        AND workspace_id = ${claim.envelope.workspaceId}
        AND claim_token = ${claim.claimToken}
        AND delivered_at IS NULL
    `;
    if (updated !== 1) {
      throw new Error("Outbox claim is no longer active.");
    }
  }
}

class PostgresResourceLeaseStore implements ResourceLeaseStore {
  public constructor(
    private readonly transactions: PostgresTransactionLookup,
  ) {}

  public async acquire(
    transaction: ApplicationTransaction,
    input: Parameters<ResourceLeaseStore["acquire"]>[1],
  ) {
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1) {
      throw new RangeError("Resource lease duration must be positive.");
    }
    const rows = await this.transactions.get(transaction).$queryRaw<
      readonly { readonly fencing_token: bigint; readonly expires_at: Date }[]
    >`
      INSERT INTO resource_leases (
        id, workspace_id, resource_type, resource_key, fencing_token, expires_at
      )
      VALUES (
        ${randomUUID()},
        ${input.workspaceId},
        ${input.resourceType},
        ${input.resourceKey},
        1,
        NOW() + (${input.leaseMs} * INTERVAL '1 millisecond')
      )
      ON CONFLICT (workspace_id, resource_type, resource_key)
      DO UPDATE SET
        fencing_token = resource_leases.fencing_token + 1,
        expires_at = NOW() + (${input.leaseMs} * INTERVAL '1 millisecond'),
        updated_at = NOW()
      WHERE resource_leases.expires_at <= NOW()
      RETURNING fencing_token, expires_at
    `;
    const lease = rows[0];
    return lease === undefined
      ? undefined
      : Object.freeze({
          fencingToken: lease.fencing_token,
          expiresAt: asUtcInstant(lease.expires_at),
        });
  }

  public async complete(
    transaction: ApplicationTransaction,
    input: Parameters<ResourceLeaseStore["complete"]>[1],
  ): Promise<boolean> {
    const deleted = await this.transactions.get(transaction).$executeRaw`
      DELETE FROM resource_leases
      WHERE workspace_id = ${input.workspaceId}
        AND resource_type = ${input.resourceType}
        AND resource_key = ${input.resourceKey}
        AND fencing_token = ${input.fencingToken}
    `;
    return deleted === 1;
  }
}

export interface PostgresPersistence {
  readonly unitOfWork: UnitOfWork;
  readonly bootstrapWorkspaceStore: BootstrapWorkspaceStore;
  readonly analysisRequestStore: AnalysisRequestStore;
  readonly publicationIntentStore: PublicationIntentStore;
  readonly analysisExecutionStore: PostgresAnalysisExecutionStore;
  readonly publicationExecutionStore: PostgresPublicationExecutionStore;
  readonly caseSnapshotTombstoneStore: PostgresCaseSnapshotTombstoneStore;
  readonly verifiedWebhookEventStore: PostgresVerifiedWebhookEventStore;
  readonly auditStore: AuditStore;
  readonly authorizationGuard: AuthorizationGuard;
  readonly outboxStore: OutboxStore;
  readonly resourceLeaseStore: ResourceLeaseStore;
  close(): Promise<void>;
}

export interface PostgresPersistenceConfiguration {
  readonly databaseUrl: string;
}

export function createPostgresPersistence(
  configuration: PostgresPersistenceConfiguration,
): PostgresPersistence {
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: configuration.databaseUrl }),
  });
  const unitOfWork = new PrismaUnitOfWork(client);

  return Object.freeze({
    unitOfWork,
    bootstrapWorkspaceStore: new PostgresBootstrapStore(unitOfWork),
    analysisRequestStore: new PostgresAnalysisRequestStore(unitOfWork),
    publicationIntentStore: new PostgresPublicationIntentStore(unitOfWork),
    analysisExecutionStore: new PostgresAnalysisExecutionStore(unitOfWork),
    publicationExecutionStore: new PostgresPublicationExecutionStore(
      unitOfWork,
    ),
    caseSnapshotTombstoneStore: new PostgresCaseSnapshotTombstoneStore(
      unitOfWork,
    ),
    verifiedWebhookEventStore: new PostgresVerifiedWebhookEventStore(
      unitOfWork,
    ),
    auditStore: new PostgresAuditStore(unitOfWork),
    authorizationGuard: new PostgresAuthorizationGuard(unitOfWork),
    outboxStore: new PostgresOutboxStore(unitOfWork),
    resourceLeaseStore: new PostgresResourceLeaseStore(unitOfWork),
    close: async () => client.$disconnect(),
  });
}

export * from "./ai/index.js";
export * from "./analysis/index.js";
export * from "./attachments/index.js";
export * from "./knowledge/index.js";
export * from "./publication/index.js";
export * from "./scheduling/index.js";
