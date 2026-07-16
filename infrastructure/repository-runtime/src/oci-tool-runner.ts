import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

type ToolName = "listFiles" | "readFile" | "searchFiles";

interface RunnerOptions {
  readonly tool: ToolName;
  readonly maximumOutputBytes: number;
}

class ToolRunnerError extends Error {}

function fail(message: string): never {
  throw new ToolRunnerError(message);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    return fail(`${label} is invalid.`);
  }
  return value;
}

function optionalPositiveInteger(
  value: unknown,
  fallback: number,
  label: string,
  maximum: number,
): number {
  return value === undefined
    ? fallback
    : positiveInteger(value, label, maximum);
}

function safeRelativePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    isAbsolute(value) ||
    value.startsWith("\\") ||
    value.includes("\\") ||
    value.includes(":") ||
    /^[a-z]:/iu.test(value) ||
    value
      .split(/[\\/]/u)
      .some((part) => part.length === 0 || part === "." || part === "..") ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code === undefined || code < 32 || code === 127;
    })
  ) {
    return fail(`${label} is invalid.`);
  }
  return value;
}

function within(root: string, candidate: string): boolean {
  const between = relative(root, candidate);
  return (
    between === "" || (!between.startsWith(`..${sep}`) && between !== "..")
  );
}

function rootDirectory(): string {
  const root = resolve(process.cwd());
  if (!within(root, root)) fail("Repository root is invalid.");
  return root;
}

function filePath(root: string, path: string): string {
  const candidate = resolve(root, path);
  if (!within(root, candidate)) fail("Repository path escapes its tree.");
  return candidate;
}

async function textFile(
  root: string,
  path: string,
  maximumBytes: number,
): Promise<string> {
  const candidate = filePath(root, path);
  const metadata = await lstat(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    fail("Repository path is unavailable.");
  if (metadata.size > maximumBytes)
    fail("Repository file exceeds the tool output limit.");
  let bytes: Uint8Array;
  try {
    bytes = await readFile(candidate);
  } catch {
    fail("Repository path is unavailable.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("Repository file is not UTF-8 text.");
  }
}

async function allFiles(
  root: string,
  prefix: string | undefined,
  maximum: number,
): Promise<readonly string[]> {
  const startingDirectory =
    prefix === undefined ? root : filePath(root, prefix);
  let initial: Awaited<ReturnType<typeof lstat>>;
  try {
    initial = await lstat(startingDirectory);
  } catch {
    fail("Repository prefix is unavailable.");
  }
  if (!initial.isDirectory() || initial.isSymbolicLink()) {
    fail("Repository prefix is not a directory.");
  }
  const files: string[] = [];
  const pending = [startingDirectory];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) continue;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = resolve(directory, entry.name);
      if (!within(root, candidate) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(candidate);
        continue;
      }
      if (!entry.isFile()) continue;
      const path = relative(root, candidate).split(sep).join("/");
      safeRelativePath(path, "Repository path");
      files.push(path);
      if (files.length > maximum)
        fail("Repository listing exceeds the tool limit.");
    }
  }
  return Object.freeze(files.sort((left, right) => left.localeCompare(right)));
}

async function listFiles(
  root: string,
  input: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const prefix =
    input.prefix === undefined
      ? undefined
      : safeRelativePath(input.prefix, "Repository prefix");
  const maximumEntries = optionalPositiveInteger(
    input.maximumEntries,
    250,
    "maximumEntries",
    1_000,
  );
  return Object.freeze({ files: await allFiles(root, prefix, maximumEntries) });
}

async function readTextFile(
  root: string,
  input: Readonly<Record<string, unknown>>,
  maximumOutputBytes: number,
): Promise<unknown> {
  const path = safeRelativePath(input.path, "Repository path");
  const text = await textFile(root, path, maximumOutputBytes);
  const lines = text.length === 0 ? [] : text.split(/\r\n|\r|\n/u);
  const startLine = optionalPositiveInteger(
    input.startLine,
    1,
    "startLine",
    1_000_000,
  );
  const endLine = optionalPositiveInteger(
    input.endLine,
    lines.length || 1,
    "endLine",
    1_000_000,
  );
  if (endLine < startLine || startLine > lines.length)
    fail("Requested line range is unavailable.");
  return Object.freeze({
    path,
    startLine,
    endLine: Math.min(endLine, lines.length),
    content: lines.slice(startLine - 1, endLine).join("\n"),
  });
}

async function searchFiles(
  root: string,
  input: Readonly<Record<string, unknown>>,
  maximumOutputBytes: number,
): Promise<unknown> {
  if (
    typeof input.query !== "string" ||
    input.query.length === 0 ||
    input.query.length > 512
  ) {
    fail("Search query is invalid.");
  }
  const maximumResults = optionalPositiveInteger(
    input.maximumResults,
    100,
    "maximumResults",
    500,
  );
  const prefix =
    input.prefix === undefined
      ? undefined
      : safeRelativePath(input.prefix, "Repository prefix");
  const matches: Array<
    Readonly<{ path: string; line: number; content: string }>
  > = [];
  for (const path of await allFiles(root, prefix, 10_000)) {
    let metadata: Awaited<ReturnType<typeof stat>>;
    try {
      metadata = await stat(filePath(root, path));
    } catch {
      continue;
    }
    if (metadata.size > Math.min(maximumOutputBytes, 1_048_576)) continue;
    let text: string;
    try {
      text = await textFile(
        root,
        path,
        Math.min(maximumOutputBytes, 1_048_576),
      );
    } catch {
      continue;
    }
    const lines = text.split(/\r\n|\r|\n/u);
    for (const [index, line] of lines.entries()) {
      if (!line.includes(input.query)) continue;
      matches.push(Object.freeze({ path, line: index + 1, content: line }));
      if (matches.length >= maximumResults) {
        return Object.freeze({ matches: Object.freeze(matches) });
      }
    }
  }
  return Object.freeze({ matches: Object.freeze(matches) });
}

function parseOptions(arguments_: readonly string[]): RunnerOptions {
  if (
    arguments_.length !== 4 ||
    arguments_[0] !== "--tool" ||
    arguments_[2] !== "--maximum-output-bytes"
  ) {
    return fail("Repository tool runner arguments are invalid.");
  }
  const tool = arguments_[1];
  if (tool !== "listFiles" && tool !== "readFile" && tool !== "searchFiles") {
    return fail("Repository tool is invalid.");
  }
  const maximumOutputBytes = Number(arguments_[3]);
  return Object.freeze({
    tool,
    maximumOutputBytes: positiveInteger(
      maximumOutputBytes,
      "maximumOutputBytes",
      16 * 1024 * 1024,
    ),
  });
}

async function standardInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
    if (Buffer.concat(chunks).byteLength > 1_048_576)
      fail("Repository tool input is too large.");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return fail("Repository tool input is invalid.");
  }
}

function emit(value: unknown, maximumOutputBytes: number): void {
  const output = JSON.stringify(value);
  if (new TextEncoder().encode(output).byteLength > maximumOutputBytes) {
    throw new ToolRunnerError("Repository tool output exceeds its limit.");
  }
  process.stdout.write(output);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const input = await standardInput();
  if (!isRecord(input)) fail("Repository tool input is invalid.");
  const root = rootDirectory();
  let value: unknown;
  switch (options.tool) {
    case "listFiles":
      value = await listFiles(root, input);
      break;
    case "readFile":
      value = await readTextFile(root, input, options.maximumOutputBytes);
      break;
    case "searchFiles":
      value = await searchFiles(root, input, options.maximumOutputBytes);
      break;
  }
  emit({ ok: true, value }, options.maximumOutputBytes);
}

void main().catch(() => {
  process.stdout.write(JSON.stringify({ ok: false }));
  process.exitCode = 1;
});
