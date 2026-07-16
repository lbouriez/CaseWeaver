import { pathToFileURL } from "node:url";

import {
  attachStandaloneShutdownSignals,
  createStandaloneRuntimeFromEnvironment,
  type StandaloneHostRuntime,
} from "./index.js";

export interface StandaloneOutput {
  log(message: string): void;
  error(message: string): void;
}

export function runStandaloneCommand(
  arguments_: readonly string[],
  output: StandaloneOutput,
): number {
  if (arguments_.length === 1 && arguments_[0] === "health") {
    output.log('{"status":"ok"}');
    return 0;
  }
  output.error("Usage: caseweaver-standalone health | start");
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
): Promise<number> {
  if (arguments_.length === 1 && arguments_[0] === "health") {
    return runStandaloneCommand(arguments_, output);
  }
  if (arguments_.length !== 1 || arguments_[0] !== "start") {
    output.error("Usage: caseweaver-standalone health | start");
    return 1;
  }
  let runtime: StandaloneHostRuntime | undefined;
  try {
    runtime = await createRuntime(environment);
    await runtime.start();
    attachStandaloneShutdownSignals(runtime, process);
    return 0;
  } catch {
    await runtime?.stop().catch(() => undefined);
    output.error("Standalone startup failed.");
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
