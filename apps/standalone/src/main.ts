import { pathToFileURL } from "node:url";

import { runWorkerQueueMigration } from "@caseweaver/worker";

import {
  attachStandaloneShutdownSignals,
  createStandaloneRuntimeFromEnvironment,
  StandaloneStartupError,
  type StandaloneHostRuntime,
} from "./index.js";

export interface StandaloneOutput {
  log(message: string): void;
  error(message: string): void;
}

/**
 * Startup errors can contain connection URLs, provider responses, or other
 * deployment secrets. Keep the command's diagnostic intentionally finite and
 * owned by this process: it is useful to an operator without turning stderr
 * into a disclosure channel.
 */
function safeStartupFailureCode(error: unknown): string | undefined {
  if (error instanceof StandaloneStartupError) return error.code;
  if (!(error instanceof Error)) return undefined;
  const codesByErrorName: Readonly<Record<string, string>> = {
    AiConfigurationError: "ai.invalidConfiguration",
    ApiConfigurationError: "api.invalidConfiguration",
    ObjectStorageConfigurationError: "objectStorage.invalidConfiguration",
    SchedulerConfigurationError: "scheduler.invalidConfiguration",
    WebhookConfigurationError: "webhook.invalidConfiguration",
    WorkerConfigurationError: "worker.invalidConfiguration",
  };
  return codesByErrorName[error.name];
}

export function runStandaloneCommand(
  arguments_: readonly string[],
  output: StandaloneOutput,
): number {
  if (arguments_.length === 1 && arguments_[0] === "health") {
    output.log('{"status":"ok"}');
    return 0;
  }
  output.error("Usage: caseweaver-standalone health | migrate-queue | start");
  return 1;
}

export function main(): void {
  void runStandalone(process.argv.slice(2), console).then((exitCode) => {
    process.exitCode = exitCode;
  });
}

export async function runStandalone(
  arguments_: readonly string[],
  output: StandaloneOutput,
  environment: NodeJS.ProcessEnv = process.env,
  createRuntime: (
    environment: NodeJS.ProcessEnv,
  ) => Promise<StandaloneHostRuntime> = createStandaloneRuntimeFromEnvironment,
  migrateQueue: (
    environment: NodeJS.ProcessEnv,
  ) => Promise<void> = runWorkerQueueMigration,
): Promise<number> {
  if (arguments_.length === 1 && arguments_[0] === "health") {
    return runStandaloneCommand(arguments_, output);
  }
  if (arguments_.length !== 1 || arguments_[0] !== "start") {
    if (arguments_.length === 1 && arguments_[0] === "migrate-queue") {
      try {
        await migrateQueue(environment);
        output.log("Queue migration completed.");
        return 0;
      } catch {
        output.error("Queue migration failed.");
        return 1;
      }
    }
    output.error("Usage: caseweaver-standalone health | migrate-queue | start");
    return 1;
  }
  let runtime: StandaloneHostRuntime | undefined;
  try {
    runtime = await createRuntime(environment);
    await runtime.start();
    attachStandaloneShutdownSignals(runtime, process);
    return 0;
  } catch (error) {
    await runtime?.stop().catch(() => undefined);
    const diagnosticCode = safeStartupFailureCode(error);
    output.error(
      diagnosticCode === undefined
        ? "Standalone startup failed."
        : `Standalone startup failed (${diagnosticCode}).`,
    );
    return 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  main();
}
