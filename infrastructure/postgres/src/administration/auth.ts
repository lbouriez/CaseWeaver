import type {
  AuthAuditPlan,
  AuthAuditRecorder,
  AuthSessionAuditMutationStore,
  AuthSessionStore,
  LoginTransaction,
  OidcIdentityMapping,
  OidcIdentityMappingStore,
  ServerSession,
} from "@caseweaver/administration";
import { sha256Base64Url } from "@caseweaver/administration";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

type AuthenticationDatabase = PrismaClient | Prisma.TransactionClient;

function asDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error("A UTC timestamp is invalid.");
  return date;
}

function asIso(value: Date): string {
  return value.toISOString();
}

/**
 * Appends only the safe, server-owned fields from an authentication audit plan.
 * It has no access to OIDC tokens, callback values, session cookies, or CSRF
 * plaintext. Callers treat a failure as fatal before returning browser data.
 */
export class PostgresAuthAuditRecorder implements AuthAuditRecorder {
  public constructor(private readonly client: PrismaClient) {}

  public async record(plan: AuthAuditPlan): Promise<void> {
    await appendAuthAudit(this.client, plan);
  }
}

/**
 * Uses one PostgreSQL transaction for an authenticated session state change
 * and its authoritative success audit record. Browser cookies are produced by
 * the application only after this adapter resolves successfully.
 */
export class PostgresAuthSessionAuditMutationStore
  implements AuthSessionAuditMutationStore
{
  public constructor(private readonly client: PrismaClient) {}

  public async createSessionAndRecord(input: {
    readonly session: ServerSession;
    readonly audit: AuthAuditPlan;
  }): Promise<void> {
    await this.client.$transaction(async (database) => {
      await createSession(database, input.session, new Date());
      await appendAuthAudit(database, input.audit);
    });
  }

  public async revokeSessionAndRecord(input: {
    readonly sessionDigest: string;
    readonly now: string;
    readonly audit: AuthAuditPlan;
  }): Promise<boolean> {
    const now = asDate(input.now);
    return this.client.$transaction(async (database) => {
      const revoked = await database.administrationSession.updateMany({
        where: {
          sessionDigest: input.sessionDigest,
          revokedAt: null,
          idleExpiresAt: { gt: now },
          absoluteExpiresAt: { gt: now },
        },
        data: { revokedAt: now },
      });
      if (revoked.count !== 1) return false;
      await appendAuthAudit(database, input.audit);
      return true;
    });
  }

  public async rotateSessionAndRecord(input: {
    readonly previousSessionDigest: string;
    readonly replacement: ServerSession;
    readonly now: string;
    readonly audit: AuthAuditPlan;
  }): Promise<boolean> {
    const now = asDate(input.now);
    return this.client.$transaction(async (database) => {
      const revoked = await database.administrationSession.updateMany({
        where: {
          sessionDigest: input.previousSessionDigest,
          revokedAt: null,
          idleExpiresAt: { gt: now },
          absoluteExpiresAt: { gt: now },
        },
        data: { revokedAt: now },
      });
      if (revoked.count !== 1) return false;
      await createSession(database, input.replacement, now);
      await appendAuthAudit(database, input.audit);
      return true;
    });
  }
}

/**
 * Opaque cookie/CSRF/state values are stored as digests. OIDC nonce and PKCE
 * verifier values are short-lived authenticated-encryption ciphertext, because
 * the callback must recover them in memory to validate the provider response.
 * This adapter intentionally has no token columns or token-returning API.
 */
export class PostgresAuthSessionStore implements AuthSessionStore {
  public constructor(private readonly client: PrismaClient) {}

  public async createLoginTransaction(
    transaction: LoginTransaction,
  ): Promise<void> {
    if (transaction.nonce.keyId !== transaction.verifier.keyId) {
      throw new Error(
        "OIDC callback secrets must use the same encryption key.",
      );
    }
    await this.client.$executeRaw`
      INSERT INTO administration_login_transactions (
        id, state_digest, nonce_digest, verifier_digest,
        nonce_ciphertext, verifier_ciphertext, encryption_key_id,
        return_path, expires_at
      ) VALUES (
        ${transaction.id}, ${transaction.stateDigest},
        ${sha256Base64Url(transaction.nonce.ciphertext)},
        ${sha256Base64Url(transaction.verifier.ciphertext)},
        ${transaction.nonce.ciphertext}, ${transaction.verifier.ciphertext},
        ${transaction.nonce.keyId},
        ${transaction.returnPath}, ${asDate(transaction.expiresAt)}
      )
    `;
  }

  public async consumeLoginTransaction(
    stateDigest: string,
    now: string,
  ): Promise<LoginTransaction | undefined> {
    interface ConsumedLoginTransaction {
      readonly id: string;
      readonly state_digest: string;
      readonly nonce_ciphertext: string;
      readonly verifier_ciphertext: string;
      readonly encryption_key_id: string;
      readonly return_path: string;
      readonly expires_at: Date;
    }
    const consumed = await this.client.$queryRaw<
      readonly ConsumedLoginTransaction[]
    >`
      WITH candidate AS (
        SELECT id
        FROM administration_login_transactions
        WHERE state_digest = ${stateDigest}
          AND consumed_at IS NULL
          AND expires_at > ${asDate(now)}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE administration_login_transactions AS transaction
      SET consumed_at = ${asDate(now)}
      FROM candidate
      WHERE transaction.id = candidate.id
      RETURNING
        transaction.id,
        transaction.state_digest,
        transaction.nonce_ciphertext,
        transaction.verifier_ciphertext,
        transaction.encryption_key_id,
        transaction.return_path,
        transaction.expires_at
    `;
    const row = consumed[0];
    if (row === undefined) return undefined;
    return Object.freeze({
      id: row.id,
      stateDigest: row.state_digest,
      nonce: Object.freeze({
        ciphertext: row.nonce_ciphertext,
        keyId: row.encryption_key_id,
      }),
      verifier: Object.freeze({
        ciphertext: row.verifier_ciphertext,
        keyId: row.encryption_key_id,
      }),
      returnPath: row.return_path,
      expiresAt: asIso(row.expires_at),
    });
  }

  public async createSession(session: ServerSession): Promise<void> {
    await createSession(this.client, session, new Date());
  }

  public async findActiveSession(
    sessionDigest: string,
    now: string,
  ): Promise<ServerSession | undefined> {
    const row = await this.client.administrationSession.findFirst({
      where: {
        sessionDigest,
        revokedAt: null,
        idleExpiresAt: { gt: asDate(now) },
        absoluteExpiresAt: { gt: asDate(now) },
      },
    });
    if (
      row === null ||
      row.csrfCiphertext === null ||
      row.csrfEncryptionKeyId === null
    ) {
      return undefined;
    }
    return Object.freeze({
      id: row.id,
      workspaceId: row.workspaceId,
      principalId: row.principalId,
      sessionDigest: row.sessionDigest,
      csrfDigest: row.csrfDigest,
      csrf: Object.freeze({
        ciphertext: row.csrfCiphertext,
        keyId: row.csrfEncryptionKeyId,
      }),
      expiresAt: asIso(
        row.idleExpiresAt < row.absoluteExpiresAt
          ? row.idleExpiresAt
          : row.absoluteExpiresAt,
      ),
    });
  }

  public async revokeSession(
    sessionDigest: string,
    now: string,
  ): Promise<void> {
    await this.client.administrationSession.updateMany({
      where: { sessionDigest, revokedAt: null },
      data: { revokedAt: asDate(now) },
    });
  }

  public async rotateSession(
    input: Readonly<{
      readonly previousSessionDigest: string;
      readonly replacement: ServerSession;
      readonly now: string;
    }>,
  ): Promise<boolean> {
    const now = asDate(input.now);
    const expiresAt = asDate(input.replacement.expiresAt);
    return this.client.$transaction(async (database) => {
      const revoked = await database.administrationSession.updateMany({
        where: {
          sessionDigest: input.previousSessionDigest,
          revokedAt: null,
          idleExpiresAt: { gt: now },
          absoluteExpiresAt: { gt: now },
        },
        data: { revokedAt: now },
      });
      if (revoked.count !== 1) return false;
      await database.administrationSession.create({
        data: {
          id: input.replacement.id,
          workspaceId: input.replacement.workspaceId,
          principalId: input.replacement.principalId,
          sessionDigest: input.replacement.sessionDigest,
          csrfDigest: input.replacement.csrfDigest,
          csrfCiphertext: input.replacement.csrf.ciphertext,
          csrfEncryptionKeyId: input.replacement.csrf.keyId,
          issuedAt: now,
          idleExpiresAt: expiresAt,
          absoluteExpiresAt: expiresAt,
        },
      });
      return true;
    });
  }
}

async function createSession(
  database: AuthenticationDatabase,
  session: ServerSession,
  issuedAt: Date,
): Promise<void> {
  const expiresAt = asDate(session.expiresAt);
  await database.administrationSession.create({
    data: {
      id: session.id,
      workspaceId: session.workspaceId,
      principalId: session.principalId,
      sessionDigest: session.sessionDigest,
      csrfDigest: session.csrfDigest,
      csrfCiphertext: session.csrf.ciphertext,
      csrfEncryptionKeyId: session.csrf.keyId,
      issuedAt,
      idleExpiresAt: expiresAt,
      absoluteExpiresAt: expiresAt,
    },
  });
}

async function appendAuthAudit(
  database: AuthenticationDatabase,
  plan: AuthAuditPlan,
): Promise<void> {
  const event = plan.event;
  if (event.workspaceId === undefined) {
    throw new Error("Authentication audit workspace is required.");
  }
  await database.auditEvent.create({
    data: {
      id: randomUUID(),
      workspaceId: event.workspaceId,
      ...(event.actorPrincipalId === undefined
        ? {}
        : { actorPrincipalId: event.actorPrincipalId }),
      action: event.action,
      ...(event.targetId === undefined ? {} : { targetId: event.targetId }),
      occurredAt: asDate(event.occurredAt),
      origin: "admin_ui",
      targetType: event.targetType,
      outcome: event.outcome,
      ...(event.reasonCode === undefined
        ? {}
        : { reasonCode: event.reasonCode }),
      ...(event.uiActionId === undefined
        ? {}
        : { uiActionId: event.uiActionId }),
      ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
      ...(event.correlationId === undefined
        ? {}
        : { correlationId: event.correlationId }),
      ...(event.idempotencyKeyDigest === undefined
        ? {}
        : { idempotencyKeyDigest: event.idempotencyKeyDigest }),
      ...(event.clientAddress === undefined
        ? {}
        : { clientAddress: event.clientAddress }),
      ...(event.userAgent === undefined ? {} : { userAgent: event.userAgent }),
    },
  });
}

/** PostgreSQL identity mapping reader for server-derived workspace selection. */
export class PostgresOidcIdentityMappingStore
  implements OidcIdentityMappingStore
{
  public constructor(private readonly client: PrismaClient) {}

  public async findByExternalIdentity(
    input: Readonly<{
      readonly issuer: string;
      readonly subject: string;
    }>,
  ): Promise<readonly OidcIdentityMapping[]> {
    const rows = await this.client.oidcIdentityMapping.findMany({
      where: { issuer: input.issuer, subject: input.subject },
      orderBy: [{ workspaceId: "asc" }, { principalId: "asc" }],
    });
    return Object.freeze(rows.map(toMapping));
  }

  public async findByWorkspacePrincipal(
    input: Readonly<{
      readonly workspaceId: string;
      readonly principalId: string;
    }>,
  ): Promise<OidcIdentityMapping | undefined> {
    const row = await this.client.oidcIdentityMapping.findUnique({
      where: {
        workspaceId_principalId: {
          workspaceId: input.workspaceId,
          principalId: input.principalId,
        },
      },
    });
    return row === null ? undefined : toMapping(row);
  }
}

function toMapping(
  row: Readonly<{
    readonly id: string;
    readonly workspaceId: string;
    readonly principalId: string;
    readonly issuer: string;
    readonly subject: string;
    readonly displayName: string;
  }>,
): OidcIdentityMapping {
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    principalId: row.principalId,
    issuer: row.issuer,
    subject: row.subject,
    displayName: row.displayName,
  });
}
