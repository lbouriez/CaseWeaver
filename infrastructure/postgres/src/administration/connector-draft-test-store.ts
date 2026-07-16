import { randomUUID } from "node:crypto";
import type {
  ConnectorDraftTestAudit,
  ConnectorDraftTestIdentity,
  ConnectorDraftTestResult,
  ConnectorDraftTestStore,
} from "@caseweaver/administration";
import type { PrismaClient } from "@prisma/client";

const confirmationTtlMs = 5 * 60_000;

/**
 * PostgreSQL durable state for non-destructive connector draft tests. Only a
 * candidate digest and safe descriptor identity cross this adapter; raw
 * settings, locators, secret values, remote response data, and errors do not.
 */
export class PostgresConnectorDraftTestStore
  implements ConnectorDraftTestStore
{
  public constructor(
    private readonly client: PrismaClient,
    private readonly nextId: () => string = randomUUID,
  ) {}

  public async issueAndRecord(
    input: Parameters<ConnectorDraftTestStore["issueAndRecord"]>[0],
  ) {
    assertAudit(
      input.audit,
      input.identity,
      "admin.connectorDraftTest.preview",
      "succeeded",
    );
    const now = date(input.now);
    const expiresAt = new Date(now.getTime() + confirmationTtlMs);
    const confirmationId = this.nextId();
    const confirmation = "Run connector connection test";
    const impact =
      "CaseWeaver will perform one bounded, read-only connectivity check from the server. The candidate configuration is not saved or activated.";
    await this.client.$transaction(async (database) => {
      await database.administrationConnectorDraftTestConfirmation.create({
        data: {
          id: confirmationId,
          workspaceId: input.identity.workspaceId,
          principalId: input.identity.principalId,
          sessionId: input.identity.sessionId,
          descriptorType: input.identity.descriptorType,
          descriptorVersion: input.identity.descriptorVersion,
          testOperation: input.identity.operation,
          candidateDigest: input.identity.candidateDigest,
          confirmation,
          impact,
          expiresAt,
          createdAt: now,
        },
      });
      await appendAudit(database, input.audit, this.nextId);
    });
    return Object.freeze({
      confirmationId,
      confirmation,
      impact,
      expiresAt: expiresAt.toISOString(),
    });
  }

  public async consumeAndClaim(
    input: Parameters<ConnectorDraftTestStore["consumeAndClaim"]>[0],
  ) {
    return this.client.$transaction(async (database) => {
      await database.$queryRaw`
        SELECT 1 FROM pg_advisory_xact_lock(
          hashtextextended(${`connector-draft-test:${input.identity.workspaceId}:${input.idempotencyKeyDigest}`}, 0)
        )
      `;
      const existing =
        await database.administrationConnectorDraftTestClaim.findUnique({
          where: {
            workspaceId_keyDigest: {
              workspaceId: input.identity.workspaceId,
              keyDigest: input.idempotencyKeyDigest,
            },
          },
        });
      if (existing !== null) {
        if (!matches(existing, input.identity))
          return Object.freeze({ kind: "conflict" as const });
        const result =
          await database.administrationConnectorDraftTestResult.findUnique({
            where: { claimId: existing.id },
          });
        if (result === null)
          return Object.freeze({ kind: "outcome_unknown" as const });
        return Object.freeze({
          kind: "replayed" as const,
          result: storedResult(result),
        });
      }
      const confirmation =
        await database.administrationConnectorDraftTestConfirmation.updateMany({
          where: {
            id: input.confirmationId,
            workspaceId: input.identity.workspaceId,
            principalId: input.identity.principalId,
            sessionId: input.identity.sessionId,
            descriptorType: input.identity.descriptorType,
            descriptorVersion: input.identity.descriptorVersion,
            testOperation: input.identity.operation,
            candidateDigest: input.identity.candidateDigest,
            expiresAt: { gt: date(input.now) },
            consumedAt: null,
          },
          data: { consumedAt: date(input.now) },
        });
      if (confirmation.count !== 1)
        return Object.freeze({ kind: "outcome_unknown" as const });

      const claimId = this.nextId();
      await database.administrationConnectorDraftTestClaim.create({
        data: {
          id: claimId,
          workspaceId: input.identity.workspaceId,
          principalId: input.identity.principalId,
          descriptorType: input.identity.descriptorType,
          descriptorVersion: input.identity.descriptorVersion,
          testOperation: input.identity.operation,
          candidateDigest: input.identity.candidateDigest,
          keyDigest: input.idempotencyKeyDigest,
          createdAt: date(input.now),
        },
      });
      return Object.freeze({ kind: "acquired" as const, claimId });
    });
  }

  public async completeAndRecord(
    input: Parameters<ConnectorDraftTestStore["completeAndRecord"]>[0],
  ) {
    if (input.result.outcome === "outcome_unknown") {
      throw new Error("Connector draft-test terminal outcome is invalid.");
    }
    assertAudit(
      input.audit,
      input.identity,
      "admin.connectorDraftTest.executed",
      input.result.outcome,
    );
    return this.client.$transaction(async (database) => {
      const claim =
        await database.administrationConnectorDraftTestClaim.findUnique({
          where: { id: input.claimId },
        });
      if (claim === null || !matches(claim, input.identity))
        throw new Error("Connector draft-test claim is invalid.");
      const existing =
        await database.administrationConnectorDraftTestResult.findUnique({
          where: { claimId: input.claimId },
        });
      if (existing !== null) return storedResult(existing);
      const result =
        await database.administrationConnectorDraftTestResult.create({
          data: {
            id: input.claimId,
            claimId: input.claimId,
            workspaceId: input.identity.workspaceId,
            outcome: input.result.outcome,
            completedAt: date(input.result.completedAt),
          },
        });
      await appendAudit(database, input.audit, this.nextId);
      await database.administrationConnectorDraftTestClaim.update({
        where: { id: input.claimId },
        data: { completedAt: date(input.result.completedAt) },
      });
      return storedResult(result);
    });
  }
}

function matches(
  value: Readonly<{
    workspaceId: string;
    principalId: string;
    descriptorType: string;
    descriptorVersion: string;
    testOperation: string;
    candidateDigest: string;
  }>,
  identity: ConnectorDraftTestIdentity,
): boolean {
  return (
    value.workspaceId === identity.workspaceId &&
    value.principalId === identity.principalId &&
    value.descriptorType === identity.descriptorType &&
    value.descriptorVersion === identity.descriptorVersion &&
    value.testOperation === identity.operation &&
    value.candidateDigest === identity.candidateDigest
  );
}

function storedResult(
  value: Readonly<{ id: string; outcome: string; completedAt: Date }>,
): ConnectorDraftTestResult {
  if (value.outcome !== "succeeded" && value.outcome !== "failed")
    throw new Error("Connector draft-test result is invalid.");
  return Object.freeze({
    id: value.id,
    outcome: value.outcome,
    completedAt: value.completedAt.toISOString(),
  });
}

function date(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new Error("Connector draft-test timestamp is invalid.");
  return parsed;
}

function assertAudit(
  audit: ConnectorDraftTestAudit,
  identity: ConnectorDraftTestIdentity,
  action: string,
  outcome: "succeeded" | "failed",
): void {
  if (
    audit.workspaceId !== identity.workspaceId ||
    audit.actorPrincipalId !== identity.principalId ||
    audit.action !== action ||
    audit.targetType !== "connector-descriptor" ||
    audit.targetId !==
      `${identity.descriptorType}@${identity.descriptorVersion}` ||
    audit.permission !== "connector.manage" ||
    audit.outcome !== outcome
  ) {
    throw new Error("Connector draft-test audit is invalid.");
  }
}

async function appendAudit(
  database: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
  audit: ConnectorDraftTestAudit,
  nextId: () => string,
): Promise<void> {
  await database.auditEvent.create({
    data: {
      id: nextId(),
      workspaceId: audit.workspaceId,
      actorPrincipalId: audit.actorPrincipalId,
      action: audit.action,
      targetId: audit.targetId,
      targetType: audit.targetType,
      permission: audit.permission,
      outcome: audit.outcome,
      requestId: audit.requestId,
      correlationId: audit.correlationId,
      idempotencyKeyDigest: audit.idempotencyKeyDigest,
      uiActionId: audit.uiActionId,
      traceId: audit.traceId,
      clientAddress: audit.clientAddress,
      userAgent: audit.userAgent,
      origin: "admin_ui",
      occurredAt: date(audit.occurredAt),
    },
  });
}
