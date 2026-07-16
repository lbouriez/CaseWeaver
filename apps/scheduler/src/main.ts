import { pathToFileURL } from "node:url";

import {
  attachSchedulerShutdownSignals,
  createSchedulerRuntimeFromEnvironment,
  type SchedulerProcess,
} from "./index.js";

export interface SchedulerOutput {
  log(message: string): void;
  error(message: string): void;
}

export function runSchedulerCommand(
  arguments_: readonly string[],
  output: SchedulerOutput,
): number {
  if (arguments_.length === 1 && arguments_[0] === "health") {
    output.log('{"status":"ok"}');
    return 0;
  }
  output.error("Usage: caseweaver-scheduler health | start");
  return 1;
}

export function main(): void {
  void runScheduler(process.argv.slice(2), console).then((exitCode) => {
    process.exitCode = exitCode;
  });
}

export async function runScheduler(
  arguments_: readonly string[],
  output: SchedulerOutput,
  environment: NodeJS.ProcessEnv = process.env,
  createRuntime: (
    environment: NodeJS.ProcessEnv,
  ) => Promise<SchedulerProcess> = createSchedulerRuntimeFromEnvironment,
): Promise<number> {
  if (arguments_.length === 1 && arguments_[0] === "health") {
    return runSchedulerCommand(arguments_, output);
  }
  if (arguments_.length !== 1 || arguments_[0] !== "start") {
    output.error("Usage: caseweaver-scheduler health | start");
    return 1;
  }
  let runtime: SchedulerProcess | undefined;
  try {
    runtime = await createRuntime(environment);
    await runtime.start();
    attachSchedulerShutdownSignals(runtime, process);
    return 0;
  } catch {
    await runtime?.stop().catch(() => undefined);
    output.error("Scheduler startup failed.");
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
