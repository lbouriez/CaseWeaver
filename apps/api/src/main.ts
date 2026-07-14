import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  ApprovePublication,
  CancelOperationalJob,
  type Clock,
  type IdGenerator,
  InspectDeadLetters,
  PurgeCaseSnapshot,
  QueryCostAttribution,
  QueueExpiredRetention,
  RecoverExpiredJob,
  RequestAnalysisWithPublication,
  RetryDeadLetter,
} from "@caseweaver/application";
import { utcInstant } from "@caseweaver/domain";
import {
  resolveOpenTelemetryConfig,
  startOpenTelemetry,
} from "@caseweaver/observability";
import { createPostgresPersistence } from "@caseweaver/postgres";
import { buildApi } from "./app.js";
import { parseApiConfig } from "./config.js";
import { createDatabaseReadiness } from "./database-readiness.js";
import { ConfiguredApiExecutionContextResolver } from "./execution-context.js";
import { createLogger } from "./logger.js";

function createIds(): IdGenerator {
  return {
    next: () => randomUUID(),
  };
}

const clock: Clock = {
  now: () => utcInstant(new Date()),
};

export async function startApi(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = parseApiConfig(env);
  const logger = createLogger(config);
  const databaseReadiness = createDatabaseReadiness(config);
  const persistence = createPostgresPersistence({
    databaseUrl: config.databaseUrl,
  });
  const telemetry = await startOpenTelemetry(
    resolveOpenTelemetryConfig(env, "caseweaver-api"),
  );
  const ids = createIds();
  const requestAnalysis = new RequestAnalysisWithPublication(
    persistence.unitOfWork,
    persistence.analysisRequestStore,
    persistence.publicationIntentStore,
    persistence.outboxStore,
    persistence.auditStore,
    persistence.authorizationGuard,
    ids,
    clock,
  );
  const approvePublication = new ApprovePublication(
    persistence.unitOfWork,
    persistence.publicationIntentStore,
    persistence.auditStore,
    persistence.authorizationGuard,
    ids,
    clock,
  );
  const inspectDeadLetters = new InspectDeadLetters(
    persistence.unitOfWork,
    persistence.operationsStore,
    persistence.authorizationGuard,
  );
  const retryDeadLetter = new RetryDeadLetter(
    persistence.unitOfWork,
    persistence.operationsStore,
    persistence.outboxStore,
    persistence.auditStore,
    persistence.authorizationGuard,
    ids,
    clock,
  );
  const cancelJob = new CancelOperationalJob(
    persistence.unitOfWork,
    persistence.operationsStore,
    persistence.auditStore,
    persistence.authorizationGuard,
    ids,
    clock,
  );
  const recoverExpiredJob = new RecoverExpiredJob(
    persistence.unitOfWork,
    persistence.operationsStore,
    persistence.resourceLeaseStore,
    persistence.outboxStore,
    persistence.auditStore,
    persistence.authorizationGuard,
    ids,
    clock,
  );
  const queryCosts = new QueryCostAttribution(
    persistence.unitOfWork,
    persistence.operationsStore,
    persistence.authorizationGuard,
  );
  const purgeCaseSnapshot = new PurgeCaseSnapshot(
    persistence.unitOfWork,
    persistence.operationsStore,
    persistence.outboxStore,
    persistence.auditStore,
    persistence.authorizationGuard,
    ids,
    clock,
  );
  const queueRetention = new QueueExpiredRetention(
    persistence.unitOfWork,
    persistence.operationsStore,
    persistence.outboxStore,
    persistence.auditStore,
    persistence.authorizationGuard,
    ids,
    clock,
  );
  const app = buildApi({
    config,
    logger,
    readinessProbe: databaseReadiness.readinessProbe,
    pbi012: {
      context: new ConfiguredApiExecutionContextResolver(config),
      operations: {
        requestAnalysis: (command, context) =>
          requestAnalysis.execute(command, context),
        approvePublication: (intentId, context) =>
          approvePublication.execute(intentId, context),
      },
    },
    pbi013: {
      context: new ConfiguredApiExecutionContextResolver(config),
      operations: {
        inspectDeadLetters: (limit, context) =>
          inspectDeadLetters.execute(limit, context),
        retryDeadLetter: (jobId, mutation, context) =>
          retryDeadLetter.execute(jobId, mutation, context),
        cancelJob: (jobId, mutation, context) =>
          cancelJob.execute(jobId, mutation, context),
        recoverExpiredJob: (jobId, mutation, context) =>
          recoverExpiredJob.execute(jobId, mutation, context),
        queryCosts: (query, context) => queryCosts.execute(query, context),
        purgeCaseSnapshot: (snapshotId, reason, mutation, context) =>
          purgeCaseSnapshot.execute(snapshotId, reason, mutation, context),
        queueRetention: (mutation, context, limit) =>
          queueRetention.execute(mutation, context, limit),
      },
    },
  });

  app.addHook("onClose", async () => {
    await persistence.close();
    await databaseReadiness.close();
    await telemetry?.shutdown();
  });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch {
    await app.close();
    throw new Error("API startup failed.");
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  void startApi().catch(() => {
    process.stderr.write("API startup failed.\n");
    process.exitCode = 1;
  });
}
