import { pathToFileURL } from "node:url";

import { buildApi } from "./app.js";
import { parseApiConfig } from "./config.js";
import { createDatabaseReadiness } from "./database-readiness.js";
import { createLogger } from "./logger.js";

export async function startApi(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = parseApiConfig(env);
  const logger = createLogger(config);
  const databaseReadiness = createDatabaseReadiness(config);
  const app = buildApi({
    config,
    logger,
    readinessProbe: databaseReadiness.readinessProbe,
  });

  app.addHook("onClose", async () => {
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
