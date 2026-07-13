import { pathToFileURL } from "node:url";

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

export function main(): void {
  process.exitCode = runCli(process.argv.slice(2), console);
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  main();
}
