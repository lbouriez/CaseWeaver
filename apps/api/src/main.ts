import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  ApprovePublication,
  RequestAnalysisWithPublication,
  type Clock,
  type IdGenerator,
} from "@caseweaver/application";
import { buildApi } from "./app.js";
import { parseApiConfig } from "./config.js";
import { createDatabaseReadiness } from "./database-readiness.js";
import { utcInstant } from "@caseweaver/domain";
import { ConfiguredApiExecutionContextResolver } from "./execution-context.js";
import { createLogger } from "./logger.js";
import { createPostgresPersistence } from "@caseweaver/postgres";

function createIds(): IdGenerator {
  return {
    next: (kind) => `${kind}:${randomUUID()}`,
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
  });

  app.addHook("onClose", async () => {
    await persistence.close();
    await databaseReadiness.close();
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
