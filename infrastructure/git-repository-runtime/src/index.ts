import {
  type ChildProcessWithoutNullStreams,
  spawn as nodeSpawn,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  assertActive,
  type DiffGitRepositoryRequest,
  type GitRepository,
  type GitRepositoryAuthentication,
  type GitRepositoryBinaryFile,
  type GitRepositoryDelta,
  type GitRepositoryFile,
  type GitRepositoryReference,
  type GitRepositorySnapshot,
  type GitRepositoryTarget,
  type InspectGitRepositoryRequest,
  type ReadGitRepositoryBinaryRequest,
  type ReadGitRepositoryFileRequest,
  requireGitObjectId,
  requireRepositoryPath,
} from "@caseweaver/connector-git-markdown";
import {
  ConnectorCancelledError,
  ConnectorConfigurationError,
  ConnectorProtocolError,
  ConnectorRemoteError,
} from "@caseweaver/connector-sdk";

export * from "./pinned-remote-checkout.js";

const defaultLimits = Object.freeze({
  commandTimeoutMs: 15_000,
  maximumControlOutputBytes: 16 * 1_024,
  maximumTreeOutputBytes: 32 * 1_024 * 1_024,
  maximumFileBytes: 5 * 1_024 * 1_024,
  maximumStderrBytes: 64 * 1_024,
  maximumTreeEntries: 100_000,
});

const gitAskPassTokenVariable = "CASEWEAVER_GIT_ASKPASS_TOKEN";
const gitAskPassUsernameVariable = "CASEWEAVER_GIT_ASKPASS_USERNAME";
const emptyAskPassUsername = "x-access-token";

export interface GitRepositoryRuntimeLimits {
  readonly commandTimeoutMs: number;
  readonly maximumControlOutputBytes: number;
  readonly maximumTreeOutputBytes: number;
  readonly maximumFileBytes: number;
  readonly maximumStderrBytes: number;
  readonly maximumTreeEntries: number;
}

export interface GitProcessRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd?: string;
  /** Server-private process environment. It must never be logged by a runner. */
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maximumStdoutBytes: number;
  readonly maximumStderrBytes: number;
}

export interface GitProcessResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

/** Shell-free, bounded, cancellable Git process boundary. */
export interface GitProcessRunner {
  run(input: GitProcessRequest): Promise<GitProcessResult>;
  /**
   * Optional bounded stdout stream used for binary blobs. Implementations that do
   * not provide it remain compatible during rollout; `GitCliRepository` falls
   * back to the existing bounded result path for those test/legacy runners.
   */
  stream?(input: GitProcessRequest): AsyncIterable<Uint8Array>;
}

export class GitProcessFailure extends Error {
  public constructor(
    public readonly reason:
      | "cancelled"
      | "timeout"
      | "outputLimit"
      | "startup"
      | "exit",
  ) {
    super("Git process execution failed.");
    this.name = "GitProcessFailure";
  }
}

export interface NodeGitProcessRunnerOptions {
  /** Injectable for process-boundary tests. Production uses node:child_process spawn. */
  readonly spawn?: (
    executable: string,
    arguments_: readonly string[],
    options: Readonly<{
      readonly cwd?: string;
      readonly env: NodeJS.ProcessEnv;
      readonly shell: false;
      readonly windowsHide: true;
    }>,
  ) => ChildProcessWithoutNullStreams;
}

/** Production runner: no shell, bounded streams, timeout, and cancellation termination. */
export class NodeGitProcessRunner implements GitProcessRunner {
  private readonly spawn: NonNullable<NodeGitProcessRunnerOptions["spawn"]>;

  public constructor(options: NodeGitProcessRunnerOptions = {}) {
    this.spawn = options.spawn ?? nodeSpawn;
  }

  public async run(input: GitProcessRequest): Promise<GitProcessResult> {
    if (input.signal.aborted) throw new GitProcessFailure("cancelled");
    assertPositiveLimit(input.timeoutMs);
    assertPositiveLimit(input.maximumStdoutBytes);
    assertPositiveLimit(input.maximumStderrBytes);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawn(input.executable, [...input.arguments], {
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        env: { ...input.environment },
        shell: false,
        windowsHide: true,
      });
    } catch {
      throw new GitProcessFailure("startup");
    }

    return new Promise<GitProcessResult>((resolveResult, rejectResult) => {
      const stdout: Uint8Array[] = [];
      const stderr: Uint8Array[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failure: GitProcessFailure["reason"] | undefined;
      let settled = false;
      const kill = () => {
        if (!child.killed) child.kill("SIGTERM");
        const hardStop = setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 1_000);
        hardStop.unref();
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        input.signal.removeEventListener("abort", cancelled);
        callback();
      };
      const cancelled = () => {
        failure = "cancelled";
        kill();
      };
      const timeout = setTimeout(() => {
        failure = "timeout";
        kill();
      }, input.timeoutMs);

      const accumulate = (
        target: Uint8Array[],
        currentBytes: number,
        maximumBytes: number,
        chunk: Uint8Array,
      ): number => {
        const nextBytes = currentBytes + chunk.byteLength;
        if (nextBytes > maximumBytes) {
          failure = "outputLimit";
          kill();
          return currentBytes;
        }
        target.push(chunk);
        return nextBytes;
      };

      child.stdout.on("data", (chunk: Uint8Array) => {
        stdoutBytes = accumulate(
          stdout,
          stdoutBytes,
          input.maximumStdoutBytes,
          chunk,
        );
      });
      child.stderr.on("data", (chunk: Uint8Array) => {
        stderrBytes = accumulate(
          stderr,
          stderrBytes,
          input.maximumStderrBytes,
          chunk,
        );
      });
      child.once("error", () => {
        finish(() => rejectResult(new GitProcessFailure("startup")));
      });
      child.once("close", (exitCode) => {
        finish(() => {
          if (failure !== undefined) {
            rejectResult(new GitProcessFailure(failure));
            return;
          }
          resolveResult(
            Object.freeze({
              exitCode: exitCode ?? 1,
              stdout: concat(stdout, stdoutBytes),
              stderr: concat(stderr, stderrBytes),
            }),
          );
        });
      });
      input.signal.addEventListener("abort", cancelled, { once: true });
      // `spawn` is injectable and may synchronously trigger cancellation. A
      // listener alone would miss that already-fired event and allow the child
      // to complete successfully after its caller has cancelled.
      if (input.signal.aborted) cancelled();
    });
  }

  /**
   * Runs one Git command without accumulating stdout. The yielded bytes remain
   * bounded by the caller's limit and a non-zero process exit is surfaced while
   * the consumer reads the stream. Stderr is intentionally never yielded.
   */
  public async *stream(input: GitProcessRequest): AsyncIterable<Uint8Array> {
    if (input.signal.aborted) throw new GitProcessFailure("cancelled");
    assertPositiveLimit(input.timeoutMs);
    assertPositiveLimit(input.maximumStdoutBytes);
    assertPositiveLimit(input.maximumStderrBytes);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawn(input.executable, [...input.arguments], {
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        env: { ...input.environment },
        shell: false,
        windowsHide: true,
      });
    } catch {
      throw new GitProcessFailure("startup");
    }

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: GitProcessFailure["reason"] | undefined;
    let closed = false;
    let exitCode: number | null = null;
    let startupFailure = false;
    const kill = () => {
      if (!child.killed) child.kill("SIGTERM");
      const hardStop = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1_000);
      hardStop.unref();
    };
    const cancelled = () => {
      failure = "cancelled";
      kill();
    };
    const timeout = setTimeout(() => {
      failure = "timeout";
      kill();
    }, input.timeoutMs);
    const completed = new Promise<void>((resolveCompleted) => {
      child.once("close", (code) => {
        closed = true;
        exitCode = code;
        resolveCompleted();
      });
    });
    child.once("error", () => {
      startupFailure = true;
      kill();
    });
    child.stderr.on("data", (chunk: Uint8Array) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > input.maximumStderrBytes) {
        failure = "outputLimit";
        kill();
      }
    });
    input.signal.addEventListener("abort", cancelled, { once: true });
    if (input.signal.aborted) cancelled();

    try {
      for await (const chunk of child.stdout) {
        if (failure !== undefined) break;
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > input.maximumStdoutBytes) {
          failure = "outputLimit";
          kill();
          break;
        }
        yield new Uint8Array(chunk);
      }
      await completed;
      if (startupFailure) throw new GitProcessFailure("startup");
      if (failure !== undefined) throw new GitProcessFailure(failure);
      if (exitCode !== 0) throw new GitProcessFailure("exit");
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", cancelled);
      if (!closed) kill();
    }
  }
}

export interface GitCliRepositoryOptions {
  /** Worker-owned directory for credential-free bare HTTPS caches. */
  readonly remoteCacheDirectory?: string;
  /** Worker-owned temporary root for empty Git config and short-lived AskPass files. */
  readonly temporaryDirectory?: string;
  readonly executable?: string;
  readonly runner?: GitProcessRunner;
  /** Only non-secret process settings needed to locate Git and validate TLS are retained. */
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly limits?: Partial<GitRepositoryRuntimeLimits>;
}

interface GitCommandSession {
  readonly directory: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly hooksDirectory: string;
}

interface ResolvedRepository {
  readonly directory: string;
  readonly ref: string;
}

/**
 * Git CLI adapter for a configured repository. It never checks out a remote tree and
 * never accepts a credential-bearing URL, ref, path, or process command from callers.
 */
export class GitCliRepository implements GitRepository {
  private readonly runner: GitProcessRunner;
  private readonly executable: string;
  private readonly temporaryDirectory: string;
  private readonly remoteCacheDirectory?: string;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;
  private readonly limits: GitRepositoryRuntimeLimits;

  public constructor(options: GitCliRepositoryOptions = {}) {
    this.runner = options.runner ?? new NodeGitProcessRunner();
    this.executable = options.executable ?? "git";
    this.temporaryDirectory = resolve(options.temporaryDirectory ?? tmpdir());
    this.remoteCacheDirectory =
      options.remoteCacheDirectory === undefined
        ? undefined
        : resolve(options.remoteCacheDirectory);
    this.environment = safeBaseEnvironment(options.environment ?? process.env);
    this.limits = parseLimits(options.limits);
    if (
      this.executable.length === 0 ||
      containsControlCharacter(this.executable)
    ) {
      throw new TypeError("Git executable configuration is invalid.");
    }
  }

  public async inspect(
    request: InspectGitRepositoryRequest,
  ): Promise<GitRepositorySnapshot> {
    assertActive(request.signal);
    return this.withSession(
      request.authentication,
      request.signal,
      async (session) => {
        const repository = await this.resolveRepository(request, session);
        const commitSha = await this.resolveCurrentCommit(
          repository.directory,
          repository.ref,
          session,
          request.signal,
        );
        const files = await this.readTree(
          repository.directory,
          commitSha,
          session,
          request.signal,
        );
        return { commitSha, files: [...files] };
      },
    );
  }

  public async readFile(
    request: ReadGitRepositoryFileRequest,
  ): Promise<GitRepositoryFile> {
    assertActive(request.signal);
    const commitSha = requireGitObjectId(request.commitSha);
    const path = requireRepositoryPath(request.path);
    return this.withSession(
      request.authentication,
      request.signal,
      async (session) => {
        const repository = await this.resolveRepository(request, session);
        await this.verifyPinnedCommit(
          repository.directory,
          commitSha,
          session,
          request.signal,
        );
        const entry = await this.readTreePath(
          repository.directory,
          commitSha,
          path,
          session,
          request.signal,
        );
        if (entry === undefined || entry.path !== path) {
          throw new ConnectorProtocolError(
            "The configured Git document is unavailable at its pinned commit.",
          );
        }
        const result = await this.runGit(
          repository.directory,
          ["show", "--no-textconv", "--format=", `${commitSha}:${path}`],
          session,
          request.signal,
          this.limits.maximumFileBytes,
          "read",
        );
        if (result.exitCode !== 0) {
          throw remoteUnavailable("read");
        }
        return Object.freeze({
          path,
          blobOid: entry.blobOid,
          commitSha,
          content: decodeUtf8(result.stdout, "Git document"),
        });
      },
    );
  }

  public async readBinary(
    request: ReadGitRepositoryBinaryRequest,
  ): Promise<GitRepositoryBinaryFile> {
    assertActive(request.signal);
    const commitSha = requireGitObjectId(request.commitSha);
    const path = requireRepositoryPath(request.path);
    return Object.freeze({
      path,
      commitSha,
      // The session is created lazily by the iterator and remains alive until its
      // consumer completes or cancels. This retains the private AskPass/config
      // boundary for the actual Git process rather than deleting it before reads.
      content: this.readBinaryContent(request, commitSha, path),
    });
  }

  public async diff(
    request: DiffGitRepositoryRequest,
  ): Promise<GitRepositoryDelta> {
    assertActive(request.signal);
    const fromCommitSha = requireGitObjectId(request.fromCommitSha);
    return this.withSession(
      request.authentication,
      request.signal,
      async (session) => {
        const repository = await this.resolveRepository(request, session);
        await this.verifyPinnedCommit(
          repository.directory,
          fromCommitSha,
          session,
          request.signal,
        );
        const commitSha = await this.resolveCurrentCommit(
          repository.directory,
          repository.ref,
          session,
          request.signal,
        );
        const [previous, current] = await Promise.all([
          this.readTree(
            repository.directory,
            fromCommitSha,
            session,
            request.signal,
          ),
          this.readTree(
            repository.directory,
            commitSha,
            session,
            request.signal,
          ),
        ]);
        const oldFiles = new Map(previous.map((file) => [file.path, file]));
        const newFiles = new Map(current.map((file) => [file.path, file]));
        const changes = [
          ...current.flatMap((file) => {
            const previousFile = oldFiles.get(file.path);
            return previousFile?.blobOid === file.blobOid
              ? []
              : [
                  {
                    kind: "upsert" as const,
                    path: file.path,
                    blobOid: file.blobOid,
                  },
                ];
          }),
          ...previous.flatMap((file) =>
            newFiles.has(file.path)
              ? []
              : [{ kind: "tombstone" as const, path: file.path }],
          ),
        ].sort((left, right) => left.path.localeCompare(right.path));
        return { fromCommitSha, commitSha, changes };
      },
    );
  }

  private async withSession<T>(
    authentication: GitRepositoryAuthentication,
    signal: AbortSignal,
    operation: (session: GitCommandSession) => Promise<T>,
  ): Promise<T> {
    assertActive(signal);
    let session: GitCommandSession | undefined;
    try {
      session = await this.createSession(authentication, signal);
      return await operation(session);
    } catch (error) {
      return this.throwSessionFailure(error, signal);
    } finally {
      if (session !== undefined) await this.disposeSession(session);
    }
  }

  private async createSession(
    authentication: GitRepositoryAuthentication,
    signal: AbortSignal,
  ): Promise<GitCommandSession> {
    let directory: string | undefined;
    try {
      await mkdir(this.temporaryDirectory, { recursive: true, mode: 0o700 });
      const temporaryRoot = await realpath(this.temporaryDirectory);
      directory = await mkdtemp(join(temporaryRoot, "caseweaver-git-"));
      const emptyConfig = join(directory, "empty.gitconfig");
      const hooksDirectory = join(directory, "hooks");
      await Promise.all([
        writeFile(emptyConfig, "", { encoding: "utf8", mode: 0o600 }),
        mkdir(hooksDirectory, { mode: 0o700 }),
      ]);
      assertActive(signal);
      const environment: NodeJS.ProcessEnv = {
        ...this.environment,
        HOME: directory,
        XDG_CONFIG_HOME: directory,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
      };
      if (authentication.kind === "token") {
        await this.configureAskPass(
          directory,
          environment,
          authentication.token,
        );
      }
      return Object.freeze({
        directory,
        environment: Object.freeze(environment),
        hooksDirectory,
      });
    } catch (error) {
      if (directory !== undefined) {
        await rm(directory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  private async disposeSession(session: GitCommandSession): Promise<void> {
    await rm(session.directory, { recursive: true, force: true });
  }

  private throwSessionFailure(error: unknown, signal: AbortSignal): never {
    if (
      error instanceof ConnectorCancelledError ||
      error instanceof ConnectorProtocolError ||
      error instanceof ConnectorConfigurationError ||
      error instanceof ConnectorRemoteError
    ) {
      throw error;
    }
    if (signal.aborted) throw new ConnectorCancelledError();
    throw new ConnectorConfigurationError(
      "Git repository runtime configuration is unavailable.",
    );
  }

  private async configureAskPass(
    directory: string,
    environment: NodeJS.ProcessEnv,
    token: string,
  ): Promise<void> {
    if (token.length === 0 || containsControlCharacter(token)) {
      throw new ConnectorConfigurationError(
        "The configured Git credential is unavailable.",
      );
    }
    const script = join(directory, "askpass.mjs");
    await writeFile(script, askPassProgram, { encoding: "utf8", mode: 0o700 });
    await chmod(script, 0o700);
    if (process.platform === "win32") {
      const command = join(directory, "askpass.cmd");
      await writeFile(command, windowsAskPassProgram, {
        encoding: "utf8",
        mode: 0o700,
      });
      environment.GIT_ASKPASS = command;
      environment.CASEWEAVER_GIT_NODE_EXECUTABLE = process.execPath;
    } else {
      environment.GIT_ASKPASS = script;
    }
    environment.GIT_ASKPASS_REQUIRE = "force";
    environment[gitAskPassUsernameVariable] = emptyAskPassUsername;
    environment[gitAskPassTokenVariable] = token;
  }

  private async resolveRepository(
    request: InspectGitRepositoryRequest,
    session: GitCommandSession,
  ): Promise<ResolvedRepository> {
    const repository = request.repository;
    if (repository.kind === "local") {
      if (request.authentication.kind !== "none") {
        throw new ConnectorConfigurationError(
          "Git repository runtime configuration is unavailable.",
        );
      }
      return Object.freeze({
        directory: await this.resolveLocalRepository(
          repository,
          request.allowedLocalRoots,
          session,
          request.signal,
        ),
        ref: qualifiedReference(request.ref),
      });
    }
    return Object.freeze({
      directory: await this.resolveRemoteRepository(
        repository,
        request.ref,
        session,
        request.signal,
      ),
      ref: cacheReference(request.ref),
    });
  }

  private async resolveLocalRepository(
    repository: Extract<GitRepositoryTarget, { readonly kind: "local" }>,
    allowedLocalRoots: readonly string[],
    session: GitCommandSession,
    signal: AbortSignal,
  ): Promise<string> {
    const directory = await canonicalExistingDirectory(repository.path);
    const roots = await Promise.all(
      allowedLocalRoots.map(canonicalExistingDirectory),
    );
    if (!roots.some((root) => isWithin(root, directory))) {
      throw new ConnectorConfigurationError(
        "Git repository runtime configuration is unavailable.",
      );
    }
    const inside = await this.runGit(
      directory,
      ["rev-parse", "--is-inside-work-tree"],
      session,
      signal,
      this.limits.maximumControlOutputBytes,
      "local-check",
    );
    if (
      inside.exitCode !== 0 ||
      decodeUtf8(inside.stdout, "Git repository") !== "true\n"
    ) {
      throw new ConnectorConfigurationError(
        "Git repository runtime configuration is unavailable.",
      );
    }
    const topLevel = await this.runGit(
      directory,
      ["rev-parse", "--show-toplevel"],
      session,
      signal,
      this.limits.maximumControlOutputBytes,
      "local-check",
    );
    if (topLevel.exitCode !== 0) {
      throw new ConnectorConfigurationError(
        "Git repository runtime configuration is unavailable.",
      );
    }
    const canonicalTopLevel = await canonicalExistingDirectory(
      stripSingleLine(topLevel.stdout, "Git repository"),
    );
    if (!roots.some((root) => isWithin(root, canonicalTopLevel))) {
      throw new ConnectorConfigurationError(
        "Git repository runtime configuration is unavailable.",
      );
    }
    return canonicalTopLevel;
  }

  private async resolveRemoteRepository(
    repository: Extract<GitRepositoryTarget, { readonly kind: "remote" }>,
    reference: GitRepositoryReference,
    session: GitCommandSession,
    signal: AbortSignal,
  ): Promise<string> {
    if (this.remoteCacheDirectory === undefined) {
      throw new ConnectorConfigurationError(
        "Git repository runtime configuration is unavailable.",
      );
    }
    const url = canonicalRemoteUrl(repository.url);
    await mkdir(this.remoteCacheDirectory, { recursive: true, mode: 0o700 });
    const cacheRoot = await canonicalExistingDirectory(
      this.remoteCacheDirectory,
    );
    const cacheDirectory = resolve(
      cacheRoot,
      createHash("sha256").update(url).digest("hex"),
    );
    if (!isWithin(cacheRoot, cacheDirectory)) {
      throw new ConnectorConfigurationError(
        "Git repository runtime configuration is unavailable.",
      );
    }
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    const canonicalCacheDirectory =
      await canonicalExistingDirectory(cacheDirectory);
    if (!isWithin(cacheRoot, canonicalCacheDirectory)) {
      throw new ConnectorConfigurationError(
        "Git repository runtime configuration is unavailable.",
      );
    }
    const bare = await this.runGit(
      canonicalCacheDirectory,
      ["rev-parse", "--is-bare-repository"],
      session,
      signal,
      this.limits.maximumControlOutputBytes,
      "cache-check",
    );
    if (bare.exitCode !== 0) {
      const initialized = await this.runGit(
        canonicalCacheDirectory,
        ["init", "--bare", "--quiet"],
        session,
        signal,
        this.limits.maximumControlOutputBytes,
        "cache-init",
      );
      if (initialized.exitCode !== 0) throw remoteUnavailable("cache-init");
    } else if (decodeUtf8(bare.stdout, "Git repository") !== "true\n") {
      throw new ConnectorConfigurationError(
        "Git repository runtime configuration is unavailable.",
      );
    }
    await this.ensureRemoteUrl(canonicalCacheDirectory, url, session, signal);
    const fetched = await this.runGit(
      canonicalCacheDirectory,
      [
        "fetch",
        "--no-tags",
        "--force",
        "origin",
        `+${qualifiedReference(reference)}:${cacheReference(reference)}`,
      ],
      session,
      signal,
      this.limits.maximumControlOutputBytes,
      "fetch",
    );
    if (fetched.exitCode !== 0) throw remoteUnavailable("fetch");
    return canonicalCacheDirectory;
  }

  private async ensureRemoteUrl(
    directory: string,
    url: string,
    session: GitCommandSession,
    signal: AbortSignal,
  ): Promise<void> {
    const existing = await this.runGit(
      directory,
      ["remote", "get-url", "origin"],
      session,
      signal,
      this.limits.maximumControlOutputBytes,
      "remote-check",
    );
    if (existing.exitCode !== 0) {
      const added = await this.runGit(
        directory,
        ["remote", "add", "origin", url],
        session,
        signal,
        this.limits.maximumControlOutputBytes,
        "remote-configure",
      );
      if (added.exitCode !== 0) throw remoteUnavailable("remote-configure");
      return;
    }
    if (
      canonicalRemoteUrl(stripSingleLine(existing.stdout, "Git remote")) !== url
    ) {
      throw new ConnectorConfigurationError(
        "Git repository runtime configuration is unavailable.",
      );
    }
  }

  private async resolveCurrentCommit(
    directory: string,
    reference: string,
    session: GitCommandSession,
    signal: AbortSignal,
  ): Promise<string> {
    const resolved = await this.runGit(
      directory,
      ["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`],
      session,
      signal,
      this.limits.maximumControlOutputBytes,
      "resolve",
    );
    if (resolved.exitCode !== 0) throw remoteUnavailable("resolve");
    return requireGitObjectId(stripSingleLine(resolved.stdout, "Git commit"));
  }

  private async verifyPinnedCommit(
    directory: string,
    commitSha: string,
    session: GitCommandSession,
    signal: AbortSignal,
  ): Promise<void> {
    const result = await this.runGit(
      directory,
      ["rev-parse", "--verify", "--end-of-options", `${commitSha}^{commit}`],
      session,
      signal,
      this.limits.maximumControlOutputBytes,
      "verify",
    );
    if (
      result.exitCode !== 0 ||
      stripSingleLine(result.stdout, "Git commit") !== commitSha
    ) {
      throw new ConnectorProtocolError(
        "The Git commit pin is unavailable or invalid.",
      );
    }
  }

  private async readTree(
    directory: string,
    commitSha: string,
    session: GitCommandSession,
    signal: AbortSignal,
  ): Promise<
    readonly Readonly<{ readonly path: string; readonly blobOid: string }>[]
  > {
    const result = await this.runGit(
      directory,
      ["ls-tree", "-r", "-z", "--full-tree", commitSha],
      session,
      signal,
      this.limits.maximumTreeOutputBytes,
      "tree",
    );
    if (result.exitCode !== 0) throw remoteUnavailable("tree");
    return parseTreeEntries(result.stdout, this.limits.maximumTreeEntries);
  }

  private async readTreePath(
    directory: string,
    commitSha: string,
    path: string,
    session: GitCommandSession,
    signal: AbortSignal,
  ): Promise<
    Readonly<{ readonly path: string; readonly blobOid: string }> | undefined
  > {
    const result = await this.runGit(
      directory,
      ["ls-tree", "-z", commitSha, "--", path],
      session,
      signal,
      this.limits.maximumControlOutputBytes,
      "tree-path",
    );
    if (result.exitCode !== 0) throw remoteUnavailable("tree-path");
    const entries = parseTreeEntries(result.stdout, 1);
    if (entries.length > 1) {
      throw new ConnectorProtocolError(
        "The Git repository returned an invalid tree.",
      );
    }
    return entries[0];
  }

  private async runGit(
    directory: string,
    command: readonly string[],
    session: GitCommandSession,
    signal: AbortSignal,
    maximumStdoutBytes: number,
    operation: string,
  ): Promise<GitProcessResult> {
    assertActive(signal);
    try {
      return await this.runner.run({
        executable: this.executable,
        arguments: this.gitArguments(directory, command, session),
        environment: session.environment,
        signal,
        timeoutMs: this.limits.commandTimeoutMs,
        maximumStdoutBytes,
        maximumStderrBytes: this.limits.maximumStderrBytes,
      });
    } catch (error) {
      if (error instanceof ConnectorCancelledError) throw error;
      if (
        signal.aborted ||
        (error instanceof GitProcessFailure && error.reason === "cancelled")
      ) {
        throw new ConnectorCancelledError();
      }
      if (error instanceof GitProcessFailure && error.reason === "timeout") {
        throw new ConnectorRemoteError("Git repository operation timed out.", {
          category: "timeout",
          operation,
          retryable: true,
        });
      }
      if (
        error instanceof GitProcessFailure &&
        error.reason === "outputLimit"
      ) {
        throw new ConnectorProtocolError(
          "Git repository output exceeded its configured limit.",
          { operation },
        );
      }
      throw remoteUnavailable(operation);
    }
  }

  private async *readBinaryContent(
    request: ReadGitRepositoryBinaryRequest,
    commitSha: string,
    path: string,
  ): AsyncIterable<Uint8Array> {
    let session: GitCommandSession | undefined;
    try {
      session = await this.createSession(
        request.authentication,
        request.signal,
      );
      const repository = await this.resolveRepository(request, session);
      await this.verifyPinnedCommit(
        repository.directory,
        commitSha,
        session,
        request.signal,
      );
      const entry = await this.readTreePath(
        repository.directory,
        commitSha,
        path,
        session,
        request.signal,
      );
      if (entry === undefined || entry.path !== path) {
        throw new ConnectorProtocolError(
          "The configured Git attachment is unavailable at its pinned commit.",
        );
      }
      yield* this.readPinnedBinary(
        repository.directory,
        commitSha,
        path,
        session,
        request.signal,
      );
    } catch (error) {
      this.throwSessionFailure(error, request.signal);
    } finally {
      if (session !== undefined) await this.disposeSession(session);
    }
  }

  private async *readPinnedBinary(
    directory: string,
    commitSha: string,
    path: string,
    session: GitCommandSession,
    signal: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    assertActive(signal);
    const command = [
      "show",
      "--no-textconv",
      "--format=",
      `${commitSha}:${path}`,
    ];
    const stream = this.runner.stream;
    if (stream === undefined) {
      const buffered = await this.runGit(
        directory,
        command,
        session,
        signal,
        this.limits.maximumFileBytes,
        "read-binary",
      );
      if (buffered.exitCode !== 0) throw remoteUnavailable("read-binary");
      assertActive(signal);
      yield buffered.stdout;
      return;
    }

    try {
      for await (const chunk of stream.call(this.runner, {
        executable: this.executable,
        arguments: this.gitArguments(directory, command, session),
        environment: session.environment,
        signal,
        timeoutMs: this.limits.commandTimeoutMs,
        maximumStdoutBytes: this.limits.maximumFileBytes,
        maximumStderrBytes: this.limits.maximumStderrBytes,
      })) {
        assertActive(signal);
        yield new Uint8Array(chunk);
      }
    } catch (error) {
      if (error instanceof ConnectorCancelledError) throw error;
      if (
        signal.aborted ||
        (error instanceof GitProcessFailure && error.reason === "cancelled")
      ) {
        throw new ConnectorCancelledError();
      }
      if (error instanceof GitProcessFailure && error.reason === "timeout") {
        throw new ConnectorRemoteError("Git repository operation timed out.", {
          category: "timeout",
          operation: "read-binary",
          retryable: true,
        });
      }
      if (
        error instanceof GitProcessFailure &&
        error.reason === "outputLimit"
      ) {
        throw new ConnectorProtocolError(
          "Git repository output exceeded its configured limit.",
          { operation: "read-binary" },
        );
      }
      throw remoteUnavailable("read-binary");
    }
  }

  private gitArguments(
    directory: string,
    command: readonly string[],
    session: GitCommandSession,
  ): readonly string[] {
    return [
      "--no-pager",
      "-c",
      "credential.helper=",
      "-c",
      "credential.useHttpPath=true",
      "-c",
      `core.hooksPath=${session.hooksDirectory}`,
      "-c",
      "protocol.file.allow=never",
      "-c",
      "protocol.ext.allow=never",
      "-C",
      directory,
      ...command,
    ];
  }
}

function parseLimits(
  overrides: Partial<GitRepositoryRuntimeLimits> | undefined,
): GitRepositoryRuntimeLimits {
  const limits = { ...defaultLimits, ...overrides };
  for (const value of Object.values(limits)) assertPositiveLimit(value);
  return Object.freeze(limits);
}

function assertPositiveLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      "Git repository runtime limits must be positive integers.",
    );
  }
}

function safeBaseEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): Readonly<NodeJS.ProcessEnv> {
  const names = [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ] as const;
  const selected = Object.fromEntries(
    names.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  return Object.freeze(selected);
}

function qualifiedReference(reference: GitRepositoryReference): string {
  if (reference.kind === "commit") {
    return requireGitObjectId(reference.sha);
  }
  assertSafeReferenceName(reference.name);
  return reference.kind === "branch"
    ? `refs/heads/${reference.name}`
    : `refs/tags/${reference.name}`;
}

function cacheReference(reference: GitRepositoryReference): string {
  if (reference.kind === "commit") {
    return `refs/caseweaver/commits/${requireGitObjectId(reference.sha)}`;
  }
  assertSafeReferenceName(reference.name);
  return `refs/caseweaver/${reference.kind}s/${reference.name}`;
}

function assertSafeReferenceName(name: string): void {
  if (
    name.length === 0 ||
    name.startsWith("-") ||
    name.includes("@{") ||
    name.includes("//") ||
    name
      .split("/")
      .some((part) => part.length === 0 || part === "." || part === "..") ||
    containsControlCharacter(name)
  ) {
    throw new ConnectorConfigurationError(
      "Git repository runtime configuration is unavailable.",
    );
  }
}

function canonicalRemoteUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      throw new Error();
    }
    return url.toString();
  } catch {
    throw new ConnectorConfigurationError(
      "Git repository runtime configuration is unavailable.",
    );
  }
}

async function canonicalExistingDirectory(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch {
    throw new ConnectorConfigurationError(
      "Git repository runtime configuration is unavailable.",
    );
  }
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot.length === 0 ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

function parseTreeEntries(
  value: Uint8Array,
  maximumEntries: number,
): readonly Readonly<{ readonly path: string; readonly blobOid: string }>[] {
  const entries: Array<
    Readonly<{ readonly path: string; readonly blobOid: string }>
  > = [];
  const seen = new Set<string>();
  let offset = 0;
  while (offset < value.byteLength) {
    const end = value.indexOf(0, offset);
    if (end === -1) {
      throw new ConnectorProtocolError(
        "The Git repository returned an invalid tree.",
      );
    }
    const entry = value.slice(offset, end);
    offset = end + 1;
    if (entry.byteLength === 0) continue;
    if (entries.length >= maximumEntries) {
      throw new ConnectorProtocolError(
        "Git repository tree exceeds its configured limit.",
      );
    }
    const tab = entry.indexOf(9);
    if (tab === -1) {
      throw new ConnectorProtocolError(
        "The Git repository returned an invalid tree.",
      );
    }
    const metadata = decodeUtf8(entry.slice(0, tab), "Git tree entry").split(
      " ",
    );
    if (metadata.length !== 3 || metadata[1] !== "blob") continue;
    const blobOid = requireGitObjectId(metadata[2] ?? "");
    const path = requireRepositoryPath(
      decodeUtf8(entry.slice(tab + 1), "Git tree path"),
    );
    if (seen.has(path)) {
      throw new ConnectorProtocolError(
        "The Git repository returned an invalid tree.",
      );
    }
    seen.add(path);
    entries.push(Object.freeze({ path, blobOid }));
  }
  return Object.freeze(entries);
}

function decodeUtf8(value: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new ConnectorProtocolError(`${label} is not valid UTF-8.`);
  }
}

function stripSingleLine(value: Uint8Array, label: string): string {
  const text = decodeUtf8(value, label);
  if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) {
    throw new ConnectorProtocolError(`${label} is invalid.`);
  }
  return text.slice(0, -1);
}

function concat(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}

function remoteUnavailable(operation: string): ConnectorRemoteError {
  return new ConnectorRemoteError("Git repository operation failed.", {
    category: "remote",
    operation,
    retryable: true,
  });
}

const askPassProgram = `#!/usr/bin/env node
const prompt = process.argv[2] ?? "";
const name = /username/i.test(prompt)
  ? "${gitAskPassUsernameVariable}"
  : /password/i.test(prompt)
    ? "${gitAskPassTokenVariable}"
    : undefined;
const value = name === undefined ? undefined : process.env[name];
if (value === undefined || value.length === 0) process.exit(1);
process.stdout.write(value);
`;

const windowsAskPassProgram = `@echo off
setlocal DisableDelayedExpansion
"%${"CASEWEAVER_GIT_NODE_EXECUTABLE"}%" "%~dp0askpass.mjs" "%~1"
`;

export * from "./git-markdown-attachments.js";
