import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LocalGitPinnedRepositoryCheckoutBroker,
  LocalPreparedRepositoryTreeStore,
  NodeRestrictedProcessRunner,
  type RestrictedProcessResult,
  type RestrictedProcessRunner,
} from "./index.js";

const commit = "a".repeat(40);
const checkoutSecretReference = "vault:repository/never-disclose-this-value";

function processResult(stdout = ""): RestrictedProcessResult {
  return Object.freeze({
    exitCode: 0,
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
  });
}

class ScriptedGitRunner implements RestrictedProcessRunner {
  public readonly calls: Array<
    Readonly<{
      arguments: readonly string[];
      environment: Readonly<Record<string, string>> | undefined;
    }>
  > = [];

  public constructor(
    private readonly sourceDirectory: string,
    private readonly onVerify: (input: {
      readonly signal: AbortSignal;
    }) => Promise<RestrictedProcessResult>,
    private readonly tree?: string,
  ) {}

  public async run(input: {
    readonly command: string;
    readonly arguments: readonly string[];
    readonly workingDirectory?: string;
    readonly environment?: Readonly<Record<string, string>>;
    readonly standardInput?: Uint8Array;
    readonly maximumOutputBytes: number;
    readonly signal: AbortSignal;
  }): Promise<RestrictedProcessResult> {
    this.calls.push({
      arguments: Object.freeze([...input.arguments]),
      environment: input.environment,
    });
    const command = input.arguments.slice(2);
    if (command[0] === "rev-parse" && command[1] === "--show-toplevel") {
      return processResult(`${this.sourceDirectory}\n`);
    }
    if (command[0] === "rev-parse" && command[1] === "--verify") {
      return this.onVerify({ signal: input.signal });
    }
    if (command[0] === "ls-tree") return processResult(this.tree ?? "");
    throw new Error(`Unexpected Git invocation: ${command.join(" ")}`);
  }
}

function broker(input: {
  readonly sourceDirectory: string;
  readonly temporaryDirectory: string;
  readonly processRunner: RestrictedProcessRunner;
}): LocalGitPinnedRepositoryCheckoutBroker {
  return new LocalGitPinnedRepositoryCheckoutBroker({
    sources: [
      { repositoryId: "support-service", directory: input.sourceDirectory },
    ],
    treeStore: new LocalPreparedRepositoryTreeStore(),
    temporaryDirectory: input.temporaryDirectory,
    processRunner: input.processRunner,
  });
}

describe("repository runtime security automation", () => {
  it("cancels a checkout, removes its newly-created tree, and never sends the checkout secret to Git", async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), "caseweaver-source-"));
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "caseweaver-tree-"),
    );
    const canonicalSource = await realpath(sourceDirectory);
    let verificationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      verificationStarted = resolve;
    });
    const runner = new ScriptedGitRunner(
      canonicalSource,
      async ({ signal }) =>
        new Promise<RestrictedProcessResult>((_resolve, reject) => {
          verificationStarted();
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const controller = new AbortController();
    try {
      const pending = broker({
        sourceDirectory,
        temporaryDirectory,
        processRunner: runner,
      }).checkout(
        {
          repositoryId: "support-service",
          checkoutSecretReference,
          pinnedCommit: commit,
        },
        controller.signal,
      );
      await started;
      const cancellation = new Error("test cancellation");
      controller.abort(cancellation);

      await expect(pending).rejects.toBe(cancellation);
      await expect(readdir(temporaryDirectory)).resolves.toEqual([]);
      expect(JSON.stringify(runner.calls)).not.toContain(
        checkoutSecretReference,
      );
    } finally {
      await rm(sourceDirectory, { recursive: true, force: true });
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rejects a symlink Git entry and removes the prepared directory on failure", async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), "caseweaver-source-"));
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "caseweaver-tree-"),
    );
    const canonicalSource = await realpath(sourceDirectory);
    const runner = new ScriptedGitRunner(
      canonicalSource,
      async () => processResult(`${commit}\n`),
      `120000 blob ${commit}\tcredential-link\0`,
    );
    try {
      await expect(
        broker({
          sourceDirectory,
          temporaryDirectory,
          processRunner: runner,
        }).checkout(
          {
            repositoryId: "support-service",
            checkoutSecretReference,
            pinnedCommit: commit,
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "repository.runtimeIsolation" });
      await expect(readdir(temporaryDirectory)).resolves.toEqual([]);
      expect(JSON.stringify(runner.calls)).not.toContain(
        checkoutSecretReference,
      );
    } finally {
      await rm(sourceDirectory, { recursive: true, force: true });
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("bounds subprocess output and terminates an aborted process without a shell", async () => {
    const runner = new NodeRestrictedProcessRunner();
    await expect(
      runner.run({
        command: process.execPath,
        arguments: ["-e", "process.stdout.write('x'.repeat(2048))"],
        maximumOutputBytes: 1_024,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "repository.runtimeIsolation" });

    const controller = new AbortController();
    const cancellation = new Error("test cancellation");
    const pending = runner.run({
      command: process.execPath,
      arguments: ["-e", "setInterval(() => {}, 1000)"],
      maximumOutputBytes: 1_024,
      signal: controller.signal,
    });
    controller.abort(cancellation);
    await expect(pending).rejects.toBe(cancellation);
  });
});
