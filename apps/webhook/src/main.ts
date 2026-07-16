import { pathToFileURL } from "node:url";

import {
  attachWebhookShutdownSignals,
  createWebhookRuntimeFromEnvironment,
  type WebhookRuntime,
} from "./index.js";

export interface WebhookOutput {
  log(message: string): void;
  error(message: string): void;
}

export function runWebhookCommand(
  arguments_: readonly string[],
  output: WebhookOutput,
): number {
  if (arguments_.length === 1 && arguments_[0] === "health") {
    output.log('{"status":"ok"}');
    return 0;
  }
  output.error("Usage: caseweaver-webhook health | start");
  return 1;
}

export function main(): void {
  void runWebhook(process.argv.slice(2), console).then((exitCode) => {
    process.exitCode = exitCode;
  });
}

export async function runWebhook(
  arguments_: readonly string[],
  output: WebhookOutput,
  environment: NodeJS.ProcessEnv = process.env,
  createRuntime: (
    environment: NodeJS.ProcessEnv,
  ) => Promise<WebhookRuntime> = createWebhookRuntimeFromEnvironment,
): Promise<number> {
  if (arguments_.length === 1 && arguments_[0] === "health") {
    return runWebhookCommand(arguments_, output);
  }
  if (arguments_.length !== 1 || arguments_[0] !== "start") {
    output.error("Usage: caseweaver-webhook health | start");
    return 1;
  }
  let runtime: WebhookRuntime | undefined;
  try {
    runtime = await createRuntime(environment);
    await runtime.start();
    attachWebhookShutdownSignals(runtime, process);
    return 0;
  } catch {
    await runtime?.stop().catch(() => undefined);
    output.error("Webhook startup failed.");
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
