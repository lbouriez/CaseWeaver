import { randomUUID } from "node:crypto";
import type { UnitOfWork } from "@caseweaver/application";
import {
  createEnvelope,
  type EnvelopeFor,
  outboxEnvelopeId,
  repositoryChangeRequestId,
  type SecretReference,
  secretReference,
  type WorkspaceId,
} from "@caseweaver/domain";
import type {
  ClaimedRepositoryChange,
  RepositoryChangeRequest,
  RepositoryChangeStore,
} from "@caseweaver/repository-changes";
import type { Prisma, PrismaClient } from "@prisma/client";

import type { PostgresTransactionLookup } from "../index.js";

type JsonObject = Readonly<Record<string, Prisma.JsonValue>>;
type TransactionalUnitOfWork = UnitOfWork & PostgresTransactionLookup;

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu;

export class PostgresRepositoryChangeError extends Error {
  public readonly code = "repositoryChange.unavailable";
  public readonly retryable = false;

  public constructor() {
    super("Repository-change automation is unavailable.");
    this.name = "PostgresRepositoryChangeError";
  }
}

function unavailable(): never {
  throw new PostgresRepositoryChangeError();
}

function object(value: Prisma.JsonValue | undefined): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    unavailable();
  return value as JsonObject;
}

function text(value: Prisma.JsonValue | undefined, maximum = 16_000): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\0]/u.test(value)
  )
    unavailable();
  return value;
}

function safeIdentifier(value: Prisma.JsonValue | undefined): string {
  const candidate = text(value, 200);
  if (!identifier.test(candidate)) unavailable();
  return candidate;
}

function branchName(value: Prisma.JsonValue | undefined): string {
  const candidate = text(value, 240);
  if (
    candidate.startsWith("refs/") ||
    candidate.startsWith("/") ||
    candidate.startsWith(".") ||
    candidate.endsWith("/") ||
    candidate.endsWith(".") ||
    candidate.includes("..") ||
    candidate.includes("//") ||
    candidate.includes("@{") ||
    /[~^:?*[\\\]\s\0]/u.test(candidate) ||
    !/^[A-Za-z0-9._/-]+$/u.test(candidate)
  )
    unavailable();
  return candidate;
}

function recordFromJson(value: Prisma.JsonValue): JsonObject {
  return object(value);
}

function issueFromRecord(value: Prisma.JsonValue) {
  const record = recordFromJson(value);
  const output = object(record.output);
  if (output.confidence !== "high") return undefined;
  if (
    record.repositoryInvestigation === undefined ||
    record.repositoryInvestigation === null ||
    typeof record.repositoryInvestigation !== "object" ||
    Array.isArray(record.repositoryInvestigation)
  )
    return undefined;
  const investigation = record.repositoryInvestigation as JsonObject;
  const findings = investigation.findings;
  if (!Array.isArray(findings) || findings.length === 0) return undefined;
  const actions = output.recommendedActions;
  if (!Array.isArray(actions) || actions.length === 0) return undefined;
  const firstAction = object(actions[0] as Prisma.JsonValue);
  return Object.freeze({
    summary: text(output.summary, 8_000),
    diagnosis: text(firstAction.statement, 4_000),
    runtime: object(investigation.run),
  });
}

function runtimeFromIssue(value: ReturnType<typeof issueFromRecord>) {
  if (value === undefined) return undefined;
  const run = value.runtime;
  const runtimeVersionId = safeIdentifier(run.runtimeVersionId);
  const repositoryId = safeIdentifier(run.repositoryId);
  const analyzedCommit = text(run.pinnedCommit, 64).toLowerCase();
  if (!sha.test(analyzedCommit)) unavailable();
  return Object.freeze({ runtimeVersionId, repositoryId, analyzedCommit });
}

function automationFromSettings(settings: Prisma.JsonValue):
  | {
      readonly targetBranch: string;
      readonly remoteUrl: string;
      readonly secretReferenceId: string;
    }
  | undefined {
  if (
    settings === null ||
    typeof settings !== "object" ||
    Array.isArray(settings)
  )
    return undefined;
  const settingsRecord = settings as JsonObject;
  if (
    settingsRecord.repository === undefined ||
    settingsRecord.repository === null ||
    typeof settingsRecord.repository !== "object" ||
    Array.isArray(settingsRecord.repository)
  )
    return undefined;
  const repository = settingsRecord.repository as JsonObject;
  if (repository.mode !== "remoteHttps") return undefined;
  if (
    repository.automation === undefined ||
    repository.automation === null ||
    typeof repository.automation !== "object" ||
    Array.isArray(repository.automation)
  )
    return undefined;
  const automation = repository.automation as JsonObject;
  if (automation.automaticDraftPullRequest !== true) return undefined;
  if (
    repository.checkoutRef === undefined ||
    repository.checkoutRef === null ||
    typeof repository.checkoutRef !== "object" ||
    Array.isArray(repository.checkoutRef)
  )
    return undefined;
  const checkoutRef = repository.checkoutRef as JsonObject;
  if (checkoutRef.kind !== "branch") return undefined;
  const remoteUrl = text(repository.remoteUrl, 4_096);
  const secretReferenceId = safeIdentifier(
    repository.checkoutSecretReferenceId,
  );
  try {
    const url = new URL(remoteUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      unavailable();
  } catch (error) {
    if (error instanceof PostgresRepositoryChangeError) throw error;
    unavailable();
  }
  return Object.freeze({
    targetBranch: branchName(checkoutRef.name),
    remoteUrl,
    secretReferenceId,
  });
}

function asRequest(
  row: {
    readonly id: string;
    readonly workspaceId: string;
    readonly analysisResultId: string;
    readonly runtimeVersionId: string;
    readonly repositoryId: string;
    readonly analyzedCommit: string;
    readonly targetBranch: string;
    readonly state: string;
    readonly createdAt: Date;
  },
  record: Prisma.JsonValue,
): RepositoryChangeRequest {
  const issue = issueFromRecord(record);
  if (issue === undefined) unavailable();
  if (
    ![
      "queued",
      "planning",
      "authoring",
      "draft_created",
      "no_change",
      "failed",
      "outcome_unknown",
    ].includes(row.state) ||
    !identifier.test(row.id) ||
    !identifier.test(row.workspaceId) ||
    !identifier.test(row.analysisResultId) ||
    !identifier.test(row.runtimeVersionId) ||
    !identifier.test(row.repositoryId) ||
    !sha.test(row.analyzedCommit)
  )
    unavailable();
  return Object.freeze({
    id: repositoryChangeRequestId(row.id),
    workspaceId: row.workspaceId as WorkspaceId,
    state: row.state as RepositoryChangeRequest["state"],
    issue: Object.freeze({
      analysisResultId:
        row.analysisResultId as RepositoryChangeRequest["issue"]["analysisResultId"],
      summary: issue.summary,
      diagnosis: issue.diagnosis,
      confidence: "high",
    }),
    runtime: Object.freeze({
      runtimeVersionId: row.runtimeVersionId,
      repositoryId: row.repositoryId,
      analyzedCommit: row.analyzedCommit.toLowerCase(),
      targetBranch: row.targetBranch,
    }),
    createdAt: row.createdAt.toISOString(),
  });
}

/** Server-only location/credential identity used by the Azure DevOps adapter. */
export class PostgresRepositoryChangeConfigurationResolver {
  public constructor(private readonly client: PrismaClient) {}

  public async resolve(
    request: RepositoryChangeRequest,
    signal: AbortSignal,
  ): Promise<{
    readonly remoteUrl: string;
    readonly checkoutSecretReference: SecretReference;
  }> {
    if (signal.aborted) unavailable();
    const version =
      await this.client.administrationConfigurationVersion.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: request.workspaceId,
            id: request.runtime.runtimeVersionId,
          },
        },
        select: { settings: true },
      });
    if (version === null) unavailable();
    const automation = automationFromSettings(version.settings);
    if (automation === undefined) unavailable();
    const registration = await this.client.credentialRegistration.findFirst({
      where: {
        workspaceId: request.workspaceId,
        id: automation.secretReferenceId,
        lifecycle: "active",
      },
      select: { secretReference: true },
    });
    if (registration === null) unavailable();
    return Object.freeze({
      remoteUrl: automation.remoteUrl,
      checkoutSecretReference: secretReference(registration.secretReference),
    });
  }
}

export class PostgresRepositoryChangeStore implements RepositoryChangeStore {
  public constructor(private readonly unitOfWork: TransactionalUnitOfWork) {}

  public async scheduleFromCompletedAnalysis(
    event: EnvelopeFor<"analysis.completed.v1">,
    signal: AbortSignal,
  ): Promise<"scheduled" | "not_eligible"> {
    if (signal.aborted) unavailable();
    return this.unitOfWork.transaction(async (transaction) => {
      const database = this.unitOfWork.get(transaction);
      const result = await database.analysisResult.findUnique({
        where: {
          workspaceId_id: {
            workspaceId: event.workspaceId,
            id: event.payload.analysisResultId,
          },
        },
        select: { id: true, analysisJobId: true, record: true },
      });
      if (
        result === null ||
        result.analysisJobId !== event.payload.analysisJobId
      )
        return "not_eligible";
      const issue = issueFromRecord(result.record);
      const runtime = runtimeFromIssue(issue);
      if (issue === undefined || runtime === undefined) return "not_eligible";
      const version =
        await database.administrationConfigurationVersion.findUnique({
          where: {
            workspaceId_id: {
              workspaceId: event.workspaceId,
              id: runtime.runtimeVersionId,
            },
          },
          select: { settings: true },
        });
      if (version === null) return "not_eligible";
      const automation = automationFromSettings(version.settings);
      if (automation === undefined) return "not_eligible";
      const requestId = repositoryChangeRequestId(
        `repository-change-${randomUUID()}`,
      );
      const created = await database.repositoryChangeRequest.createMany({
        data: {
          id: requestId,
          workspaceId: event.workspaceId,
          analysisResultId: result.id,
          runtimeVersionId: runtime.runtimeVersionId,
          repositoryId: runtime.repositoryId,
          analyzedCommit: runtime.analyzedCommit,
          targetBranch: automation.targetBranch,
          state: "queued",
        },
        skipDuplicates: true,
      });
      if (created.count === 0) return "scheduled";
      const command = createEnvelope<"repository-change.execute.v1">({
        id: outboxEnvelopeId(`repository-change-outbox-${randomUUID()}`),
        kind: "command",
        type: "repository-change.execute.v1",
        schemaVersion: 1,
        workspaceId: event.workspaceId,
        occurredAt: event.occurredAt,
        correlationId: event.correlationId,
        causationId: event.causationId,
        payload: { repositoryChangeRequestId: requestId },
      });
      await database.outboxEnvelope.create({
        data: {
          id: command.id,
          workspaceId: command.workspaceId,
          kind: command.kind,
          type: command.type,
          schemaVersion: command.schemaVersion,
          occurredAt: new Date(command.occurredAt),
          correlationId: command.correlationId,
          causationId: command.causationId,
          payload: command.payload,
          availableAt: new Date(command.occurredAt),
        },
      });
      return "scheduled";
    });
  }

  public async claim(
    requestId: RepositoryChangeRequest["id"],
    workspaceId: WorkspaceId,
    signal: AbortSignal,
  ) {
    if (signal.aborted) unavailable();
    return this.unitOfWork.transaction(async (transaction) => {
      const database = this.unitOfWork.get(transaction);
      const row = await database.repositoryChangeRequest.findUnique({
        where: { workspaceId_id: { workspaceId, id: requestId } },
        select: {
          id: true,
          workspaceId: true,
          analysisResultId: true,
          runtimeVersionId: true,
          repositoryId: true,
          analyzedCommit: true,
          targetBranch: true,
          state: true,
          leaseExpiresAt: true,
          createdAt: true,
          analysisResult: { select: { record: true } },
        },
      });
      if (row === null) return "not_found" as const;
      if (
        ["draft_created", "no_change", "failed", "outcome_unknown"].includes(
          row.state,
        )
      )
        return "completed" as const;
      const now = new Date();
      if (
        row.state !== "queued" &&
        (row.leaseExpiresAt === null || row.leaseExpiresAt > now)
      )
        return "already_running" as const;
      const leaseToken = randomUUID();
      const updated = await database.repositoryChangeRequest.updateMany({
        where: { id: row.id, workspaceId, state: row.state },
        data: {
          state: "planning",
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + 15 * 60_000),
        },
      });
      if (updated.count !== 1) return "already_running" as const;
      return Object.freeze({
        request: asRequest(row, row.analysisResult.record),
        leaseToken,
      } satisfies ClaimedRepositoryChange);
    });
  }

  public async markPlanning(
    claim: ClaimedRepositoryChange,
    signal: AbortSignal,
  ): Promise<void> {
    await this.transition(claim, "planning", {}, signal);
  }

  public async markAuthoring(
    claim: ClaimedRepositoryChange,
    input: {
      readonly architectSummary: string;
      readonly documentationImpact: string;
    },
    signal: AbortSignal,
  ): Promise<void> {
    await this.transition(
      claim,
      "authoring",
      {
        architectSummary: input.architectSummary,
        documentationImpact: input.documentationImpact,
      },
      signal,
    );
  }

  public async markNoChange(
    claim: ClaimedRepositoryChange,
    signal: AbortSignal,
  ): Promise<void> {
    await this.transition(
      claim,
      "no_change",
      { leaseToken: null, leaseExpiresAt: null },
      signal,
    );
  }

  public async markDraftCreated(
    claim: ClaimedRepositoryChange,
    input: { readonly pullRequestUrl: string; readonly targetCommit: string },
    signal: AbortSignal,
  ): Promise<void> {
    await this.transition(
      claim,
      "draft_created",
      {
        pullRequestUrl: input.pullRequestUrl,
        targetCommit: input.targetCommit,
        leaseToken: null,
        leaseExpiresAt: null,
      },
      signal,
    );
  }

  public async markFailed(
    claim: ClaimedRepositoryChange,
    input: { readonly code: string; readonly outcomeUnknown: boolean },
    signal: AbortSignal,
  ): Promise<void> {
    await this.transition(
      claim,
      input.outcomeUnknown ? "outcome_unknown" : "failed",
      { errorCode: input.code, leaseToken: null, leaseExpiresAt: null },
      signal,
    );
  }

  private async transition(
    claim: ClaimedRepositoryChange,
    state: RepositoryChangeRequest["state"],
    data: Record<string, string | null>,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) unavailable();
    await this.unitOfWork.transaction(async (transaction) => {
      const updated = await this.unitOfWork
        .get(transaction)
        .repositoryChangeRequest.updateMany({
          where: {
            id: claim.request.id,
            workspaceId: claim.request.workspaceId,
            leaseToken: claim.leaseToken,
          },
          data: { state, ...data },
        });
      if (updated.count !== 1) unavailable();
    });
  }
}
