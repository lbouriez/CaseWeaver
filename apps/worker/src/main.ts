import { pathToFileURL } from "node:url";

import { createPostgresPersistence } from "@caseweaver/postgres";
import { Pool } from "pg";

import {
  PostgresWorkerReadinessProbe,
  type WorkerDatabaseReadinessProbe,
} from "./database-readiness.js";
import { createDiagnosticExportOutboxWorker } from "./diagnostic-export-outbox-worker.js";
import { attachWorkerShutdownSignals, type WorkerProcess } from "./process.js";
import {
  createProductionWorkerRuntimeFromEnvironment,
  runWorkerQueueMigration,
} from "./production-bootstrap.js";

export interface WorkerOutput {
  log(message: string): void;
  error(message: string): void;
}

export async function runWorkerCommand(
  arguments_: readonly string[],
  output: WorkerOutput,
  environment: NodeJS.ProcessEnv = process.env,
  readiness?: WorkerDatabaseReadinessProbe,
): Promise<number> {
  if (arguments_.length === 1 && arguments_[0] === "health") {
    const databaseUrl = environment.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      output.error("Worker database is unavailable.");
      return 1;
    }
    const pool =
      readiness === undefined
        ? new Pool({
            connectionString: databaseUrl,
            connectionTimeoutMillis: 5_000,
            query_timeout: 5_000,
            max: 1,
          })
        : undefined;
    const probe =
      readiness ?? new PostgresWorkerReadinessProbe(pool as Pool, 5_000);
    try {
      if ((await probe.check()) !== "ready") {
        output.error("Worker database is unavailable.");
        return 1;
      }
      output.log(JSON.stringify({ status: "ok" }));
      return 0;
    } finally {
      await pool?.end();
    }
  }

  output.error("Usage: caseweaver-worker health");
  return 1;
}

export interface WorkerRuntimeBootstrap {
  create(environment: NodeJS.ProcessEnv): Promise<WorkerProcess>;
}

export function main(): void {
  void runWorker(process.argv.slice(2), console).then((exitCode) => {
    process.exitCode = exitCode;
  });
}

/**
 * `diagnostics` is intentionally a narrowly scoped durable consumer. Other
 * envelopes remain owned by their respective worker compositions; this process
 * cannot accidentally steal or discard them.
 */
export async function runWorker(
  arguments_: readonly string[],
  output: WorkerOutput,
  environment: NodeJS.ProcessEnv = process.env,
  bootstrap?: WorkerRuntimeBootstrap,
): Promise<number> {
  if (arguments_.length === 1 && arguments_[0] === "health") {
    return runWorkerCommand(arguments_, output, environment);
  }
  if (arguments_.length === 1 && arguments_[0] === "start") {
    let runtime: WorkerProcess | undefined;
    try {
      runtime = await (
        bootstrap ?? {
          create: createProductionWorkerRuntimeFromEnvironment,
        }
      ).create(environment);
      await runtime.start();
      attachWorkerShutdownSignals(runtime, process);
      return 0;
    } catch {
      if (runtime !== undefined) {
        await runtime.stop().catch(() => undefined);
      }
      output.error("Worker startup failed.");
      return 1;
    }
  }
  if (arguments_.length === 1 && arguments_[0] === "migrate-queue") {
    try {
      await runWorkerQueueMigration(environment);
      output.log("Queue migration completed.");
      return 0;
    } catch {
      output.error("Queue migration failed.");
      return 1;
    }
  }
  const continuous = arguments_.length === 1 && arguments_[0] === "diagnostics";
  const oneShot =
    arguments_.length === 1 && arguments_[0] === "diagnostics-once";
  if (!continuous && !oneShot) {
    output.error(
      "Usage: caseweaver-worker health | start | migrate-queue | diagnostics | diagnostics-once",
    );
    return 1;
  }
  const databaseUrl = environment.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    output.error("DATABASE_URL is required for diagnostic export work.");
    return 1;
  }
  const persistence = createPostgresPersistence({ databaseUrl });
  const worker = createDiagnosticExportOutboxWorker(persistence);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    do {
      const processed = await worker.runOnce(10, abort.signal);
      if (oneShot || abort.signal.aborted) break;
      if (processed === 0) await delay(1_000, abort.signal);
    } while (!abort.signal.aborted);
    return 0;
  } catch {
    output.error("Diagnostic export worker failed.");
    return 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await persistence.close();
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  main();
}
