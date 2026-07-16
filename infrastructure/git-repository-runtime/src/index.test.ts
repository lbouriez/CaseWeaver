import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  GitCliRepository,
  type GitProcessRequest,
  type GitProcessResult,
  type GitProcessRunner,
  NodeGitProcessRunner,
} from "./index.js";

const commit = "a".repeat(40);
const blob = "b".repeat(40);
const token = "remote-git-token-not-an-argument";

function output(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

class ScriptedRunner implements GitProcessRunner {
  public readonly calls: GitProcessRequest[] = [];

  public constructor(private readonly failFetch = false) {}

  public async run(input: GitProcessRequest): Promise<GitProcessResult> {
    this.calls.push(input);
    const command = commandName(input);
    if (command === "rev-parse") {
      if (input.arguments.includes("--is-bare-repository")) {
        return result(1);
      }
      return result(0, `${commit}\n`);
    }
    if (command === "fetch" && this.failFetch) {
      return {
        exitCode: 1,
        stdout: new Uint8Array(),
        stderr: output(`fatal: ${token}`),
      };
    }
    if (command === "init" || command === "fetch" || command === "show") {
      return result(0, command === "show" ? "# Pinned document\n" : "");
    }
    if (command === "remote") {
      return result(input.arguments.includes("get-url") ? 1 : 0);
    }
    if (command === "ls-tree") {
      return result(0, `100644 blob ${blob}\tdocs/pinned.md\0`);
    }
    throw new Error(`Unexpected Git command: ${command ?? "none"}`);
  }
}

function commandName(input: GitProcessRequest): string | undefined {
  const directoryIndex = input.arguments.indexOf("-C");
  return input.arguments[directoryIndex + 2];
}

function result(exitCode: number, stdout = ""): GitProcessResult {
  return { exitCode, stdout: output(stdout), stderr: new Uint8Array() };
}

function remoteRequest() {
  return {
    repository: {
      kind: "remote" as const,
      url: "https://github.example.test/acme/documentation.git",
    },
    allowedLocalRoots: [],
    ref: { kind: "branch" as const, name: "main" },
    authentication: { kind: "token" as const, token },
    signal: new AbortController().signal,
  };
}

describe("GitCliRepository", () => {
  it("uses a credential-free HTTPS cache command shape and resolves the mutable ref to a commit", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "caseweaver-git-test-"),
    );
    const runner = new ScriptedRunner();
    try {
      const repository = new GitCliRepository({
        runner,
        remoteCacheDirectory: join(temporaryDirectory, "cache"),
        temporaryDirectory,
      });

      await expect(repository.inspect(remoteRequest())).resolves.toEqual({
        commitSha: commit,
        files: [{ path: "docs/pinned.md", blobOid: blob }],
      });

      const argumentText = runner.calls
        .flatMap((call) => call.arguments)
        .join(" ");
      expect(argumentText).not.toContain(token);
      expect(argumentText).not.toContain(`https://token@`);
      expect(
        runner.calls.some((call) => call.arguments.includes("fetch")),
      ).toBe(true);
      expect(
        runner.calls.some(
          (call) =>
            call.environment.GIT_TERMINAL_PROMPT === "0" &&
            call.environment.GIT_CONFIG_NOSYSTEM === "1" &&
            call.environment.GIT_ASKPASS !== undefined &&
            call.environment.CASEWEAVER_GIT_ASKPASS_TOKEN === token,
        ),
      ).toBe(true);
      expect(
        runner.calls.every((call) =>
          call.arguments.includes("credential.helper="),
        ),
      ).toBe(true);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("reads the exact discovered commit rather than resolving the branch again", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "caseweaver-git-test-"),
    );
    const runner = new ScriptedRunner();
    try {
      const repository = new GitCliRepository({
        runner,
        remoteCacheDirectory: join(temporaryDirectory, "cache"),
        temporaryDirectory,
      });

      await expect(
        repository.readFile({
          ...remoteRequest(),
          path: "docs/pinned.md",
          commitSha: commit,
        }),
      ).resolves.toEqual({
        path: "docs/pinned.md",
        blobOid: blob,
        commitSha: commit,
        content: "# Pinned document\n",
      });

      const show = runner.calls.find((call) => commandName(call) === "show");
      expect(show?.arguments).toContain(`${commit}:docs/pinned.md`);
      expect(show?.arguments).not.toContain("refs/heads/main");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("does not disclose a remote credential when Git returns it in stderr", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "caseweaver-git-test-"),
    );
    const runner = new ScriptedRunner(true);
    try {
      const repository = new GitCliRepository({
        runner,
        remoteCacheDirectory: join(temporaryDirectory, "cache"),
        temporaryDirectory,
      });

      let failure: unknown;
      try {
        await repository.inspect(remoteRequest());
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({
        code: "connector.remote",
        category: "remote",
      });
      expect(String(failure)).not.toContain(token);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("re-canonicalizes a local worktree root and fails when Git resolves it outside its allowed root", async () => {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "caseweaver-git-test-"),
    );
    const allowedRoot = join(temporaryDirectory, "allowed");
    const repositoryPath = join(allowedRoot, "repository");
    const outside = join(temporaryDirectory, "outside");
    await Promise.all([
      mkdir(repositoryPath, { recursive: true }),
      mkdir(outside),
    ]);
    const runner: GitProcessRunner = {
      run: vi.fn(async (input: GitProcessRequest) => {
        if (input.arguments.includes("--is-inside-work-tree")) {
          return result(0, "true\n");
        }
        if (input.arguments.includes("--show-toplevel")) {
          return result(0, `${outside}\n`);
        }
        throw new Error("Unexpected command");
      }),
    };
    try {
      const repository = new GitCliRepository({
        runner,
        temporaryDirectory,
      });

      await expect(
        repository.inspect({
          repository: { kind: "local", path: repositoryPath },
          allowedLocalRoots: [allowedRoot],
          ref: { kind: "branch", name: "main" },
          authentication: { kind: "none" },
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "connector.configuration" });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe("NodeGitProcessRunner", () => {
  it("always requests a hidden shell-free child process", async () => {
    const spawn = vi.fn(
      (
        _executable: string,
        _arguments: readonly string[],
        _options: Readonly<Record<string, unknown>>,
      ) => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          killed: false,
          kill: vi.fn(() => true),
        }) as unknown as ChildProcessWithoutNullStreams;
        queueMicrotask(() => {
          child.stdout.end("ok");
          child.stderr.end();
          child.emit("close", 0);
        });
        return child;
      },
    );
    const runner = new NodeGitProcessRunner({ spawn });

    await expect(
      runner.run({
        executable: "git",
        arguments: ["--version"],
        environment: {},
        signal: new AbortController().signal,
        timeoutMs: 1_000,
        maximumStdoutBytes: 1_024,
        maximumStderrBytes: 1_024,
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(spawn).toHaveBeenCalledWith(
      "git",
      ["--version"],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it("terminates a child that exceeds the configured stdout bound", async () => {
    let child!: ChildProcessWithoutNullStreams;
    const kill = vi.fn(() => {
      queueMicrotask(() => child.emit("close", null));
      return true;
    });
    const runner = new NodeGitProcessRunner({
      spawn: () => {
        child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          killed: false,
          kill,
        }) as unknown as ChildProcessWithoutNullStreams;
        queueMicrotask(() => child.stdout.write("too many bytes"));
        return child;
      },
    });

    await expect(
      runner.run({
        executable: "git",
        arguments: ["--version"],
        environment: {},
        signal: new AbortController().signal,
        timeoutMs: 1_000,
        maximumStdoutBytes: 1,
        maximumStderrBytes: 1_024,
      }),
    ).rejects.toMatchObject({ reason: "outputLimit" });
    expect(kill).toHaveBeenCalled();
  });

  it("does not miss an abort that races child-process startup", async () => {
    const controller = new AbortController();
    const kill = vi.fn(() => true);
    const runner = new NodeGitProcessRunner({
      spawn: () => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          killed: false,
          kill,
        }) as unknown as ChildProcessWithoutNullStreams;
        controller.abort();
        queueMicrotask(() => child.emit("close", 0));
        return child;
      },
    });

    await expect(
      runner.run({
        executable: "git",
        arguments: ["--version"],
        environment: {},
        signal: controller.signal,
        timeoutMs: 1_000,
        maximumStdoutBytes: 1_024,
        maximumStderrBytes: 1_024,
      }),
    ).rejects.toMatchObject({ reason: "cancelled" });

    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });
});
