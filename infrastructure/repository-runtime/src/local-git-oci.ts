import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ConfiguredRepository,
  RepositoryReadOnlyTool,
} from "@caseweaver/ai-sdk";

import {
  type IsolatedRepositorySandbox,
  type PinnedRepositoryFile,
  type RepositoryCheckoutBroker,
  RepositoryRuntimeError,
  type RepositorySandboxAttestation,
  type RepositorySandboxLimits,
  type RepositorySandboxSession,
  type SanitizedPinnedTree,
} from "./contracts.js";
import {
  createPrivatePreparedRepositoryTree,
  publishPreparedRepositoryTree,
} from "./prepared-tree.js";
import { isSafeRepositoryTextFile } from "./tree-sanitizer.js";

const shaPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu;
const supportedToolNames = new Set<RepositoryReadOnlyTool>([
  "listFiles",
  "readFile",
  "searchFiles",
]);

export interface RestrictedProcessResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

/**
 * Deliberately narrow process boundary. Commands and arguments are selected by
 * the adapter, never by case content or model tool input.
 */
export interface RestrictedProcessRunner {
  run(input: {
    readonly command: string;
    readonly arguments: readonly string[];
    readonly workingDirectory?: string;
    readonly environment?: Readonly<Record<string, string>>;
    readonly standardInput?: Uint8Array;
    readonly maximumOutputBytes: number;
    readonly signal: AbortSignal;
  }): Promise<RestrictedProcessResult>;
}

function unavailable(
  code:
    | "repository.runtimeConfiguration"
    | "repository.runtimeIsolation"
    | "repository.runtimePreparation",
  message: string,
): RepositoryRuntimeError {
  return new RepositoryRuntimeError(code, message);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw unavailable(
      "repository.runtimeConfiguration",
      `${label} must be a positive integer.`,
    );
  }
}

function assertSafeIdentifier(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.length > 200 ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code === undefined || code < 32 || code === 127;
    })
  ) {
    throw unavailable(
      "repository.runtimeConfiguration",
      `${label} is invalid.`,
    );
  }
}

function assertSafeWorkspacePath(value: string): void {
  if (
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
    throw unavailable(
      "repository.runtimeIsolation",
      "Repository path is unsafe.",
    );
  }
}

function isWithin(root: string, candidate: string): boolean {
  const between = relative(root, candidate);
  return (
    between === "" || (!between.startsWith(`..${sep}`) && between !== "..")
  );
}

function lineCount(contents: Uint8Array): number | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    return undefined;
  }
  return text.length === 0 ? 0 : text.split(/\r\n|\r|\n/u).length;
}

function encodeInput(value: Readonly<Record<string, unknown>>): Uint8Array {
  try {
    return new TextEncoder().encode(JSON.stringify(value));
  } catch {
    throw unavailable(
      "repository.runtimeIsolation",
      "Repository tool input is invalid.",
    );
  }
}

function decodeSingleLine(value: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(value);
    const line = text.endsWith("\n") ? text.slice(0, -1) : text;
    return line.includes("\n") || line.includes("\r") ? undefined : line;
  } catch {
    return undefined;
  }
}

function immutableImageReference(value: string): boolean {
  return /@sha256:[a-f0-9]{64}$/iu.test(value) && !/\s/u.test(value);
}

function platformSupportsOciSandbox(): boolean {
  return process.platform === "linux";
}

/** Node's process API wrapped so callers cannot accidentally invoke a shell. */
export class NodeRestrictedProcessRunner implements RestrictedProcessRunner {
  public async run(input: {
    readonly command: string;
    readonly arguments: readonly string[];
    readonly workingDirectory?: string;
    readonly environment?: Readonly<Record<string, string>>;
    readonly standardInput?: Uint8Array;
    readonly maximumOutputBytes: number;
    readonly signal: AbortSignal;
  }): Promise<RestrictedProcessResult> {
    assertPositiveInteger(input.maximumOutputBytes, "Process output limit");
    if (input.signal.aborted) throw input.signal.reason;

    return new Promise<RestrictedProcessResult>((resolvePromise, reject) => {
      let settled = false;
      let outputBytes = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const child = spawn(input.command, [...input.arguments], {
        cwd: input.workingDirectory,
        env:
          input.environment === undefined
            ? undefined
            : { ...input.environment },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        input.signal.removeEventListener("abort", cancelled);
        callback();
      };
      const cancelled = () => {
        child.kill("SIGKILL");
        finish(() => reject(input.signal.reason));
      };
      const append = (target: Buffer[], chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > input.maximumOutputBytes) {
          child.kill("SIGKILL");
          finish(() =>
            reject(
              unavailable(
                "repository.runtimeIsolation",
                "Repository subprocess exceeded its output limit.",
              ),
            ),
          );
          return;
        }
        target.push(chunk);
      };

      child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
      child.once("error", () => {
        finish(() =>
          reject(
            unavailable(
              "repository.runtimeConfiguration",
              "Required repository runtime executable is unavailable.",
            ),
          ),
        );
      });
      child.once("close", (code) => {
        finish(() =>
          resolvePromise({
            exitCode: code ?? -1,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
          }),
        );
      });
      input.signal.addEventListener("abort", cancelled, { once: true });
      if (input.signal.aborted) {
        cancelled();
        return;
      }
      if (input.standardInput === undefined) {
        child.stdin.end();
      } else {
        child.stdin.end(input.standardInput);
      }
    });
  }
}

export interface LocalPreparedRepositoryTree {
  readonly treeId: string;
  readonly repositoryId: string;
  readonly pinnedCommit: string;
  readonly directory: string;
  /** Private parent retained only so cleanup can remove the complete tree. */
  readonly cleanupDirectory: string;
  readonly files: readonly PinnedRepositoryFile[];
}

/**
 * Private process-local tree lookup shared only by the local checkout broker
 * and OCI sandbox. A tree path is never present in SanitizedPinnedTree.
 */
export class LocalPreparedRepositoryTreeStore {
  private readonly entries = new Map<string, LocalPreparedRepositoryTree>();

  public register(value: LocalPreparedRepositoryTree): void {
    if (this.entries.has(value.treeId)) {
      throw unavailable(
        "repository.runtimeIsolation",
        "Repository tree identifier already exists.",
      );
    }
    this.entries.set(
      value.treeId,
      Object.freeze({ ...value, files: Object.freeze([...value.files]) }),
    );
  }

  public resolve(tree: SanitizedPinnedTree): LocalPreparedRepositoryTree {
    const value = this.entries.get(tree.treeId);
    if (
      value === undefined ||
      value.repositoryId !== tree.repositoryId ||
      value.pinnedCommit.toLowerCase() !== tree.pinnedCommit.toLowerCase()
    ) {
      throw unavailable(
        "repository.runtimeIsolation",
        "Prepared repository tree is unavailable.",
      );
    }
    return value;
  }

  public async readText(input: {
    readonly tree: SanitizedPinnedTree;
    readonly path: string;
    readonly signal: AbortSignal;
  }): Promise<string> {
    if (input.signal.aborted) throw input.signal.reason;
    const tree = this.resolve(input.tree);
    if (!tree.files.some((file) => file.path === input.path)) {
      throw unavailable(
        "repository.runtimePreparation",
        "Prepared repository evidence is unavailable.",
      );
    }
    const candidate = resolve(tree.directory, input.path);
    if (!isWithin(tree.directory, candidate)) {
      throw unavailable(
        "repository.runtimePreparation",
        "Prepared repository evidence is unavailable.",
      );
    }
    let metadata: Awaited<ReturnType<typeof stat>>;
    let bytes: Uint8Array;
    try {
      metadata = await stat(candidate);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error();
      bytes = await readFile(candidate);
    } catch {
      throw unavailable(
        "repository.runtimePreparation",
        "Prepared repository evidence is unavailable.",
      );
    }
    if (input.signal.aborted) throw input.signal.reason;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw unavailable(
        "repository.runtimePreparation",
        "Prepared repository evidence is unavailable.",
      );
    }
  }

  public async remove(treeId: string): Promise<void> {
    const value = this.entries.get(treeId);
    this.entries.delete(treeId);
    if (value !== undefined) {
      await rm(value.cleanupDirectory, {
        recursive: true,
        force: true,
        maxRetries: 2,
      });
    }
  }
}

export interface LocalGitRepositorySource {
  readonly repositoryId: string;
  /** A server-managed Git worktree root. It is never derived from case input. */
  readonly directory: string;
}

export interface LocalGitCheckoutLimits {
  readonly maximumFiles: number;
  readonly maximumFileBytes: number;
  readonly maximumTreeBytes: number;
  readonly maximumCommandOutputBytes: number;
}

export interface LocalGitPinnedRepositoryCheckoutBrokerOptions {
  readonly sources: readonly LocalGitRepositorySource[];
  readonly treeStore: LocalPreparedRepositoryTreeStore;
  readonly temporaryDirectory?: string;
  readonly limits?: Partial<LocalGitCheckoutLimits>;
  readonly processRunner?: RestrictedProcessRunner;
}

const defaultCheckoutLimits: LocalGitCheckoutLimits = Object.freeze({
  maximumFiles: 20_000,
  maximumFileBytes: 4 * 1024 * 1024,
  maximumTreeBytes: 64 * 1024 * 1024,
  maximumCommandOutputBytes: 16 * 1024 * 1024,
});

function checkoutLimits(
  value: Partial<LocalGitCheckoutLimits> | undefined,
): LocalGitCheckoutLimits {
  const result = { ...defaultCheckoutLimits, ...value };
  for (const [name, limit] of Object.entries(result)) {
    assertPositiveInteger(limit, `Local Git ${name}`);
  }
  return Object.freeze(result);
}

interface GitTreeEntry {
  readonly mode: string;
  readonly objectId: string;
  readonly path: string;
}

function parseGitTree(value: Uint8Array): readonly GitTreeEntry[] {
  let records: readonly string[];
  try {
    records = new TextDecoder("utf-8", { fatal: true })
      .decode(value)
      .split("\0");
  } catch {
    throw unavailable(
      "repository.runtimeIsolation",
      "Configured repository tree metadata is invalid.",
    );
  }
  const parsed: GitTreeEntry[] = [];
  for (const record of records) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    const fields = tab === -1 ? [] : record.slice(0, tab).split(" ");
    const path = tab === -1 ? "" : record.slice(tab + 1);
    const mode = fields[0];
    const type = fields[1];
    const objectId = fields[2];
    if (
      fields.length !== 3 ||
      (mode !== "100644" && mode !== "100755") ||
      type !== "blob" ||
      objectId === undefined ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(objectId)
    ) {
      throw unavailable(
        "repository.runtimeIsolation",
        "Configured repository contains unsupported Git tree entries.",
      );
    }
    assertSafeWorkspacePath(path);
    parsed.push({ mode, objectId, path });
  }
  return Object.freeze(parsed);
}

/**
 * Prepares text blobs from an administrator-mapped local Git worktree at one
 * exact commit. It deliberately has no remote URL, network, or credential
 * support. Remote/private checkout brokering remains a separate deployment
 * adapter and must not be substituted with this local-only implementation.
 */
export class LocalGitPinnedRepositoryCheckoutBroker
  implements RepositoryCheckoutBroker
{
  private readonly sourceByRepository = new Map<string, string>();
  private readonly temporaryDirectory: string;
  private readonly limits: LocalGitCheckoutLimits;
  private readonly processRunner: RestrictedProcessRunner;

  public constructor(options: LocalGitPinnedRepositoryCheckoutBrokerOptions) {
    if (options.sources.length === 0) {
      throw unavailable(
        "repository.runtimeConfiguration",
        "At least one local Git source is required.",
      );
    }
    for (const source of options.sources) {
      assertSafeIdentifier(source.repositoryId, "Repository identifier");
      if (this.sourceByRepository.has(source.repositoryId)) {
        throw unavailable(
          "repository.runtimeConfiguration",
          "Repository identifiers must be unique.",
        );
      }
      this.sourceByRepository.set(
        source.repositoryId,
        resolve(source.directory),
      );
    }
    this.temporaryDirectory = resolve(options.temporaryDirectory ?? tmpdir());
    this.limits = checkoutLimits(options.limits);
    this.processRunner =
      options.processRunner ?? new NodeRestrictedProcessRunner();
    this.treeStore = options.treeStore;
  }

  private readonly treeStore: LocalPreparedRepositoryTreeStore;

  public async checkout(
    configuration: ConfiguredRepository,
    signal: AbortSignal,
  ): Promise<SanitizedPinnedTree> {
    if (signal.aborted) throw signal.reason;
    assertSafeIdentifier(configuration.repositoryId, "Repository identifier");
    if (!shaPattern.test(configuration.pinnedCommit)) {
      throw unavailable(
        "repository.runtimeConfiguration",
        "Repository commit must be an exact SHA.",
      );
    }
    const source = this.sourceByRepository.get(configuration.repositoryId);
    if (source === undefined) {
      throw unavailable(
        "repository.runtimeConfiguration",
        "Configured repository is unavailable.",
      );
    }

    const sourceDirectory = await this.validateWorktree(source, signal);
    const preparedTree = await createPrivatePreparedRepositoryTree(
      this.temporaryDirectory,
    );
    try {
      await this.verifyCommit(
        sourceDirectory,
        configuration.pinnedCommit,
        signal,
      );
      const entries = await this.listEntries(
        sourceDirectory,
        configuration.pinnedCommit,
        signal,
      );
      const files = await this.materializeTextBlobs(
        sourceDirectory,
        entries,
        preparedTree.stagingDirectory,
        signal,
      );
      const directory = await publishPreparedRepositoryTree(
        preparedTree,
        files.map((file) => file.path),
      );
      const treeId = randomUUID();
      const tree: SanitizedPinnedTree = Object.freeze({
        treeId,
        repositoryId: configuration.repositoryId,
        pinnedCommit: configuration.pinnedCommit.toLowerCase(),
        files: Object.freeze(files),
      });
      this.treeStore.register({
        ...tree,
        directory,
        cleanupDirectory: preparedTree.parentDirectory,
      });
      return tree;
    } catch (error) {
      await rm(preparedTree.parentDirectory, {
        recursive: true,
        force: true,
        maxRetries: 2,
      });
      throw error;
    }
  }

  private async validateWorktree(
    directory: string,
    signal: AbortSignal,
  ): Promise<string> {
    let canonicalDirectory: string;
    try {
      canonicalDirectory = await realpath(directory);
    } catch {
      throw unavailable(
        "repository.runtimeConfiguration",
        "Configured local repository is unavailable.",
      );
    }
    const result = await this.git(
      canonicalDirectory,
      ["rev-parse", "--show-toplevel"],
      signal,
    );
    const topLevel =
      result.exitCode === 0 ? decodeSingleLine(result.stdout) : undefined;
    if (topLevel === undefined) {
      throw unavailable(
        "repository.runtimeConfiguration",
        "Configured local repository is unavailable.",
      );
    }
    let canonicalTopLevel: string;
    try {
      canonicalTopLevel = await realpath(topLevel);
    } catch {
      throw unavailable(
        "repository.runtimeConfiguration",
        "Configured local repository is unavailable.",
      );
    }
    if (canonicalDirectory !== canonicalTopLevel) {
      throw unavailable(
        "repository.runtimeConfiguration",
        "Configured local repository must be the Git worktree root.",
      );
    }
    return canonicalDirectory;
  }

  private async verifyCommit(
    directory: string,
    commit: string,
    signal: AbortSignal,
  ): Promise<void> {
    const result = await this.git(
      directory,
      ["rev-parse", "--verify", `${commit}^{commit}`],
      signal,
    );
    const resolved =
      result.exitCode === 0 ? decodeSingleLine(result.stdout) : undefined;
    if (
      resolved === undefined ||
      resolved.toLowerCase() !== commit.toLowerCase()
    ) {
      throw unavailable(
        "repository.runtimeConfiguration",
        "Configured pinned commit is unavailable.",
      );
    }
  }

  private async listEntries(
    directory: string,
    commit: string,
    signal: AbortSignal,
  ): Promise<readonly GitTreeEntry[]> {
    const result = await this.git(
      directory,
      ["ls-tree", "-r", "-z", "--full-tree", commit],
      signal,
    );
    if (result.exitCode !== 0) {
      throw unavailable(
        "repository.runtimeConfiguration",
        "Configured pinned commit is unavailable.",
      );
    }
    const entries = parseGitTree(result.stdout);
    if (entries.length > this.limits.maximumFiles) {
      throw unavailable(
        "repository.runtimeIsolation",
        "Configured repository exceeds its file limit.",
      );
    }
    return entries;
  }

  private async materializeTextBlobs(
    directory: string,
    entries: readonly GitTreeEntry[],
    target: string,
    signal: AbortSignal,
  ): Promise<readonly PinnedRepositoryFile[]> {
    const files: PinnedRepositoryFile[] = [];
    let totalBytes = 0;
    for (const entry of entries) {
      if (signal.aborted) throw signal.reason;
      const sizeResult = await this.git(
        directory,
        ["cat-file", "-s", entry.objectId],
        signal,
      );
      const sizeText =
        sizeResult.exitCode === 0
          ? decodeSingleLine(sizeResult.stdout)
          : undefined;
      const size = sizeText === undefined ? Number.NaN : Number(sizeText);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw unavailable(
          "repository.runtimeIsolation",
          "Configured repository blob metadata is invalid.",
        );
      }
      if (size > this.limits.maximumFileBytes) continue;
      if (totalBytes + size > this.limits.maximumTreeBytes) {
        throw unavailable(
          "repository.runtimeIsolation",
          "Configured repository exceeds its tree limit.",
        );
      }
      const blob = await this.git(
        directory,
        ["cat-file", "blob", entry.objectId],
        signal,
      );
      if (blob.exitCode !== 0 || blob.stdout.byteLength !== size) {
        throw unavailable(
          "repository.runtimeIsolation",
          "Configured repository blob is unavailable.",
        );
      }
      if (!isSafeRepositoryTextFile(entry.path, blob.stdout)) continue;
      const lines = lineCount(blob.stdout);
      if (lines === undefined) continue;
      totalBytes += size;
      const output = resolve(target, entry.path);
      if (!isWithin(target, output)) {
        throw unavailable(
          "repository.runtimeIsolation",
          "Configured repository path escapes its tree.",
        );
      }
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      await writeFile(output, blob.stdout, { mode: 0o400, flag: "wx" });
      files.push(Object.freeze({ path: entry.path, lineCount: lines }));
    }
    return Object.freeze(files);
  }

  private async git(
    directory: string,
    arguments_: readonly string[],
    signal: AbortSignal,
  ): Promise<RestrictedProcessResult> {
    return this.processRunner.run({
      command: "git",
      arguments: ["-C", directory, ...arguments_],
      maximumOutputBytes: this.limits.maximumCommandOutputBytes,
      signal,
    });
  }
}

export interface DockerOciRepositorySandboxOptions {
  readonly treeStore: LocalPreparedRepositoryTreeStore;
  /** Immutable, administrator-pinned image containing a compatible Node runtime. */
  readonly image: string;
  /** Local Unix-socket path of the Docker Engine. Remote engines are forbidden. */
  readonly socketPath?: string;
  readonly processRunner?: RestrictedProcessRunner;
}

interface DockerOciRepositorySandboxDependencies {
  readonly treeStore: LocalPreparedRepositoryTreeStore;
  readonly image: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly processRunner: RestrictedProcessRunner;
  readonly toolRunnerPath: string;
}

const strictAttestation: RepositorySandboxAttestation = Object.freeze({
  networkDisabled: true,
  credentialsUnavailable: true,
  readOnlyFilesystem: true,
  disposableFilesystem: true,
  toolAllowlistEnforced: true,
  quotasEnforced: true,
  unprivilegedUser: true,
  immutableImage: true,
  readOnlyRepositoryMount: true,
});

/**
 * Linux OCI implementation of the read-only repository tool boundary. Create
 * it with `DockerOciRepositorySandbox.create`; direct construction is blocked
 * so an unavailable/non-Linux OCI host cannot be attested.
 */
export class DockerOciRepositorySandbox implements IsolatedRepositorySandbox {
  public readonly attestation: RepositorySandboxAttestation = strictAttestation;

  private constructor(
    private readonly dependencies: DockerOciRepositorySandboxDependencies,
  ) {}

  public static async create(
    options: DockerOciRepositorySandboxOptions,
  ): Promise<DockerOciRepositorySandbox> {
    if (!platformSupportsOciSandbox()) {
      throw unavailable(
        "repository.runtimeConfiguration",
        "OCI repository sandbox requires a Linux worker host.",
      );
    }
    if (!immutableImageReference(options.image)) {
      throw unavailable(
        "repository.runtimeConfiguration",
        "OCI repository sandbox image must be pinned by SHA-256 digest.",
      );
    }
    const socketPath = options.socketPath ?? "/var/run/docker.sock";
    if (!isAbsolute(socketPath) || socketPath.includes("\0")) {
      throw unavailable(
        "repository.runtimeConfiguration",
        "Docker socket path is invalid.",
      );
    }
    const environment = Object.freeze({
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: "/tmp",
      DOCKER_CONFIG: "/tmp/caseweaver-empty-docker-config",
      DOCKER_HOST: `unix://${socketPath}`,
    });
    const processRunner =
      options.processRunner ?? new NodeRestrictedProcessRunner();
    const toolRunnerPath = fileURLToPath(
      new URL("./oci-tool-runner.js", import.meta.url),
    );
    try {
      const runnerMetadata = await stat(toolRunnerPath);
      if (!runnerMetadata.isFile()) throw new Error("not a file");
    } catch {
      throw unavailable(
        "repository.runtimeConfiguration",
        "OCI repository tool runner is unavailable.",
      );
    }
    const controller = new AbortController();
    const probe = await processRunner.run({
      command: "docker",
      arguments: ["version", "--format", "{{.Server.Os}}"],
      maximumOutputBytes: 1_024,
      signal: controller.signal,
      environment,
    });
    if (probe.exitCode !== 0 || decodeSingleLine(probe.stdout) !== "linux") {
      throw unavailable(
        "repository.runtimeConfiguration",
        "Local Linux OCI runtime is unavailable.",
      );
    }
    const image = await processRunner.run({
      command: "docker",
      arguments: ["image", "inspect", "--format", "{{.Id}}", options.image],
      maximumOutputBytes: 1_024,
      signal: controller.signal,
      environment,
    });
    if (
      image.exitCode !== 0 ||
      !/^sha256:[a-f0-9]{64}$/iu.test(decodeSingleLine(image.stdout) ?? "")
    ) {
      throw unavailable(
        "repository.runtimeConfiguration",
        "Pinned OCI repository sandbox image is unavailable.",
      );
    }
    return new DockerOciRepositorySandbox({
      treeStore: options.treeStore,
      image: options.image,
      environment,
      processRunner,
      toolRunnerPath,
    });
  }

  public async open(input: {
    readonly tree: SanitizedPinnedTree;
    readonly allowedTools: readonly RepositoryReadOnlyTool[];
    readonly limits: RepositorySandboxLimits;
    readonly signal: AbortSignal;
  }): Promise<RepositorySandboxSession> {
    if (input.signal.aborted) throw input.signal.reason;
    assertOciLimits(input.limits);
    const tree = this.dependencies.treeStore.resolve(input.tree);
    const tools = new Set(input.allowedTools);
    if (
      tools.size === 0 ||
      tools.size !== input.allowedTools.length ||
      [...tools].some((tool) => !supportedToolNames.has(tool))
    ) {
      throw unavailable(
        "repository.runtimeIsolation",
        "Repository tool allowlist is invalid.",
      );
    }
    let terminated = false;
    const active = new Set<AbortController>();
    return {
      execute: async (tool, value, signal) => {
        if (terminated || !tools.has(tool)) {
          throw unavailable(
            "repository.runtimeIsolation",
            "Repository tool is unavailable.",
          );
        }
        if (signal.aborted) throw signal.reason;
        const controller = new AbortController();
        const cancel = () => controller.abort(signal.reason);
        signal.addEventListener("abort", cancel, { once: true });
        active.add(controller);
        try {
          return await this.executeTool({
            directory: tree.directory,
            tool,
            input: value,
            limits: input.limits,
            signal: controller.signal,
          });
        } finally {
          active.delete(controller);
          signal.removeEventListener("abort", cancel);
        }
      },
      terminate: async () => {
        terminated = true;
        for (const controller of active) controller.abort();
      },
    };
  }

  public async cleanup(treeId: string): Promise<void> {
    await this.dependencies.treeStore.remove(treeId);
  }

  private async executeTool(input: {
    readonly directory: string;
    readonly tool: RepositoryReadOnlyTool;
    readonly input: Readonly<Record<string, unknown>>;
    readonly limits: RepositorySandboxLimits;
    readonly signal: AbortSignal;
  }): Promise<unknown> {
    const containerName = `caseweaver-repository-tool-${randomUUID()}`;
    try {
      const result = await this.dependencies.processRunner.run({
        command: "docker",
        arguments: dockerArguments({
          image: this.dependencies.image,
          treeDirectory: input.directory,
          toolRunnerPath: this.dependencies.toolRunnerPath,
          tool: input.tool,
          limits: input.limits,
          containerName,
        }),
        standardInput: encodeInput(input.input),
        maximumOutputBytes: input.limits.maximumOutputBytes,
        signal: input.signal,
        environment: this.dependencies.environment,
      });
      if (result.exitCode !== 0) {
        throw unavailable(
          "repository.runtimeIsolation",
          "Repository tool sandbox failed.",
        );
      }
      let response: unknown;
      try {
        response = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(result.stdout),
        );
      } catch {
        throw unavailable(
          "repository.runtimeIsolation",
          "Repository tool sandbox returned invalid output.",
        );
      }
      if (
        typeof response !== "object" ||
        response === null ||
        !("ok" in response) ||
        response.ok !== true ||
        !("value" in response)
      ) {
        throw unavailable(
          "repository.runtimeIsolation",
          "Repository tool sandbox rejected the request.",
        );
      }
      return response.value;
    } finally {
      await this.forceRemoveContainer(containerName);
    }
  }

  private async forceRemoveContainer(containerName: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      await this.dependencies.processRunner.run({
        command: "docker",
        arguments: ["rm", "--force", "--volumes", containerName],
        maximumOutputBytes: 1_024,
        signal: controller.signal,
        environment: this.dependencies.environment,
      });
    } catch {
      // A successful `docker run --rm` removes its own container. If the CLI
      // was cancelled, this best-effort force removal is the final cleanup
      // boundary and must not replace the original tool failure.
    } finally {
      clearTimeout(timeout);
    }
  }
}

function assertOciLimits(limits: RepositorySandboxLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    assertPositiveInteger(value, `OCI ${name}`);
  }
  if (limits.maximumCpuMilliseconds % 1_000 !== 0) {
    throw unavailable(
      "repository.runtimeConfiguration",
      "OCI CPU limit must be an exact whole number of seconds.",
    );
  }
  if (limits.maximumMemoryBytes < 1_048_576) {
    throw unavailable(
      "repository.runtimeConfiguration",
      "OCI memory limit must be at least one MiB.",
    );
  }
}

function dockerArguments(input: {
  readonly image: string;
  readonly treeDirectory: string;
  readonly toolRunnerPath: string;
  readonly tool: RepositoryReadOnlyTool;
  readonly limits: RepositorySandboxLimits;
  readonly containerName: string;
}): readonly string[] {
  const cpuSeconds = input.limits.maximumCpuMilliseconds / 1_000;
  const temporaryBytes = Math.max(
    65_536,
    Math.min(Math.floor(input.limits.maximumMemoryBytes / 8), 16 * 1024 * 1024),
  );
  return Object.freeze([
    "run",
    "--rm",
    "--interactive",
    `--name=${input.containerName}`,
    "--pull=never",
    "--network=none",
    "--read-only",
    "--workdir=/workspace",
    "--user=65532:65532",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=64",
    `--memory=${input.limits.maximumMemoryBytes}`,
    `--cpus=${cpuSeconds}`,
    `--ulimit=cpu=${cpuSeconds}:${cpuSeconds}`,
    `--tmpfs=/tmp:rw,noexec,nosuid,size=${temporaryBytes}`,
    `--mount=type=bind,src=${input.treeDirectory},dst=/workspace,readonly`,
    `--mount=type=bind,src=${input.toolRunnerPath},dst=/opt/caseweaver/repository-tool-runner.mjs,readonly`,
    "--env=HOME=/tmp",
    "--env=PATH=/usr/local/bin:/usr/bin:/bin",
    input.image,
    "/usr/bin/env",
    "-i",
    "HOME=/tmp",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "node",
    "/opt/caseweaver/repository-tool-runner.mjs",
    "--tool",
    input.tool,
    "--maximum-output-bytes",
    String(input.limits.maximumOutputBytes),
  ]);
}
