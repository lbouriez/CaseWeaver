import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  CancelOperationalJob,
  type Clock,
  type ExecutionContext,
  type IdGenerator,
  InspectDeadLetters,
  PurgeCaseSnapshot,
  QueryCostAttribution,
  QueueExpiredRetention,
  RecoverExpiredJob,
  RetryDeadLetter,
} from "@caseweaver/application";
import {
  correlationId,
  principalId,
  requestId,
  utcInstant,
  workspaceId,
} from "@caseweaver/domain";
import { createPostgresPersistence } from "@caseweaver/postgres";

import { parseCliConfig } from "./config.js";
import { isPbi013Command, runPbi013Cli } from "./modules/pbi-013.js";

export interface CliOutput {
  log(message: string): void;
  error(message: string): void;
}

export function runCli(
  arguments_: readonly string[],
  output: CliOutput,
): number {
  if (arguments_.length === 1 && arguments_[0] === "health") {
    output.log(JSON.stringify({ status: "ok" }));
    return 0;
  }

  output.error("Usage: caseweaver health");
  return 1;
}

function createIds(): IdGenerator {
  return { next: () => randomUUID() };
}

const clock: Clock = { now: () => utcInstant(new Date()) };

function createContext(
  config: ReturnType<typeof parseCliConfig>,
): ExecutionContext {
  const id = randomUUID();
  return Object.freeze({
    requestId: requestId(`cli-request:${id}`),
    workspaceId: workspaceId(config.workspaceId),
    principalId: principalId(config.principalId),
    correlationId: correlationId(`cli-correlation:${id}`),
    signal: new AbortController().signal,
  });
}

export async function startCli(
  arguments_: readonly string[] = process.argv.slice(2),
  output: CliOutput = console,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (!isPbi013Command(arguments_[0])) {
    return runCli(arguments_, output);
  }
  const config = parseCliConfig(env);
  const persistence = createPostgresPersistence({
    databaseUrl: config.databaseUrl,
  });
  const ids = createIds();
  const context = createContext(config);
  try {
    const operations = {
      context,
      inspectDeadLetters: (limit: number, commandContext: ExecutionContext) =>
        new InspectDeadLetters(
          persistence.unitOfWork,
          persistence.operationsStore,
          persistence.authorizationGuard,
        ).execute(limit, commandContext),
      retryDeadLetter: (
        jobId: Parameters<RetryDeadLetter["execute"]>[0],
        mutation: Parameters<RetryDeadLetter["execute"]>[1],
        commandContext: ExecutionContext,
      ) =>
        new RetryDeadLetter(
          persistence.unitOfWork,
          persistence.operationsStore,
          persistence.outboxStore,
          persistence.auditStore,
          persistence.authorizationGuard,
          ids,
          clock,
        ).execute(jobId, mutation, commandContext),
      cancelJob: (
        jobId: Parameters<CancelOperationalJob["execute"]>[0],
        mutation: Parameters<CancelOperationalJob["execute"]>[1],
        commandContext: ExecutionContext,
      ) =>
        new CancelOperationalJob(
          persistence.unitOfWork,
          persistence.operationsStore,
          persistence.auditStore,
          persistence.authorizationGuard,
          ids,
          clock,
        ).execute(jobId, mutation, commandContext),
      recoverExpiredJob: (
        jobId: Parameters<RecoverExpiredJob["execute"]>[0],
        mutation: Parameters<RecoverExpiredJob["execute"]>[1],
        commandContext: ExecutionContext,
      ) =>
        new RecoverExpiredJob(
          persistence.unitOfWork,
          persistence.operationsStore,
          persistence.resourceLeaseStore,
          persistence.outboxStore,
          persistence.auditStore,
          persistence.authorizationGuard,
          ids,
          clock,
        ).execute(jobId, mutation, commandContext),
      queryCosts: (
        query: Parameters<QueryCostAttribution["execute"]>[0],
        commandContext: ExecutionContext,
      ) =>
        new QueryCostAttribution(
          persistence.unitOfWork,
          persistence.operationsStore,
          persistence.authorizationGuard,
        ).execute(query, commandContext),
      purgeCaseSnapshot: (
        id: Parameters<PurgeCaseSnapshot["execute"]>[0],
        reason: Parameters<PurgeCaseSnapshot["execute"]>[1],
        mutation: Parameters<PurgeCaseSnapshot["execute"]>[2],
        commandContext: ExecutionContext,
      ) =>
        new PurgeCaseSnapshot(
          persistence.unitOfWork,
          persistence.operationsStore,
          persistence.outboxStore,
          persistence.auditStore,
          persistence.authorizationGuard,
          ids,
          clock,
        ).execute(id, reason, mutation, commandContext),
      queueRetention: (
        mutation: Parameters<QueueExpiredRetention["execute"]>[0],
        commandContext: ExecutionContext,
        limit: number,
      ) =>
        new QueueExpiredRetention(
          persistence.unitOfWork,
          persistence.operationsStore,
          persistence.outboxStore,
          persistence.auditStore,
          persistence.authorizationGuard,
          ids,
          clock,
        ).execute(mutation, commandContext, limit),
    };
    return runPbi013Cli(arguments_, output, operations);
  } finally {
    await persistence.close();
  }
}

export function main(): void {
  void startCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        error instanceof Error ? `${error.message}\n` : "CLI failed.\n",
      );
      process.exitCode = 1;
    });
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  main();
}
