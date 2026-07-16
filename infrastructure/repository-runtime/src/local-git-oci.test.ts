import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  DockerOciRepositorySandbox,
  LocalGitPinnedRepositoryCheckoutBroker,
  LocalPreparedRepositoryTreeStore,
} from "./index.js";

const execFileAsync = promisify(execFile);

async function git(
  directory: string,
  arguments_: readonly string[],
): Promise<string> {
  const result = await execFileAsync("git", ["-C", directory, ...arguments_], {
    encoding: "utf8",
  });
  return result.stdout;
}

async function createRepository(): Promise<{
  readonly directory: string;
  readonly commit: string;
}> {
  const directory = await mkdtemp(
    join(tmpdir(), "caseweaver-repository-source-"),
  );
  await git(directory, ["init", "--initial-branch=main"]);
  await git(directory, [
    "config",
    "user.email",
    "repository-runtime@example.invalid",
  ]);
  await git(directory, ["config", "user.name", "Repository runtime test"]);
  await mkdir(join(directory, "src"));
  await writeFile(
    join(directory, "src", "service.ts"),
    "export const answer = 42;\n",
  );
  await writeFile(join(directory, "empty.txt"), "");
  await writeFile(join(directory, "binary.bin"), Buffer.from([0, 255, 1]));
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "Initial source"]);
  const commit = (await git(directory, ["rev-parse", "HEAD"])).trim();
  return { directory, commit };
}

describe("LocalGitPinnedRepositoryCheckoutBroker", () => {
  it("materializes only the exact server-mapped commit into an opaque credential-free tree", async () => {
    const source = await createRepository();
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "caseweaver-repository-tree-"),
    );
    const trees = new LocalPreparedRepositoryTreeStore();
    const broker = new LocalGitPinnedRepositoryCheckoutBroker({
      sources: [
        { repositoryId: "support-service", directory: source.directory },
      ],
      treeStore: trees,
      temporaryDirectory,
    });
    try {
      await writeFile(
        join(source.directory, "untracked-secret.txt"),
        "must not be copied",
      );
      const tree = await broker.checkout(
        {
          repositoryId: "support-service",
          checkoutSecretReference: "vault:repository/support-service",
          pinnedCommit: source.commit,
        },
        new AbortController().signal,
      );

      expect(tree).toEqual({
        treeId: expect.any(String),
        repositoryId: "support-service",
        pinnedCommit: source.commit,
        files: expect.arrayContaining([
          { path: "src/service.ts", lineCount: 2 },
          { path: "empty.txt", lineCount: 0 },
        ]),
      });
      expect(tree).not.toHaveProperty("checkoutSecretReference");
      expect(tree).not.toHaveProperty("directory");
      expect(tree.files.map((file) => file.path)).not.toContain("binary.bin");
      expect(tree.files.map((file) => file.path)).not.toContain(
        "untracked-secret.txt",
      );

      const prepared = trees.resolve(tree);
      await expect(
        readFile(join(prepared.directory, "src", "service.ts"), "utf8"),
      ).resolves.toBe("export const answer = 42;\n");
      await expect(
        readFile(join(prepared.directory, "untracked-secret.txt"), "utf8"),
      ).rejects.toThrow();
      await trees.remove(tree.treeId);
      await expect(readFile(prepared.directory)).rejects.toThrow();
    } finally {
      await rm(source.directory, { recursive: true, force: true });
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("fails closed for a repository outside the administrator map or a commit that is not present", async () => {
    const source = await createRepository();
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "caseweaver-repository-tree-"),
    );
    const trees = new LocalPreparedRepositoryTreeStore();
    const broker = new LocalGitPinnedRepositoryCheckoutBroker({
      sources: [
        { repositoryId: "support-service", directory: source.directory },
      ],
      treeStore: trees,
      temporaryDirectory,
    });
    try {
      await expect(
        broker.checkout(
          {
            repositoryId: "other-service",
            checkoutSecretReference: "vault:repository/other-service",
            pinnedCommit: source.commit,
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "repository.runtimeConfiguration" });

      await expect(
        broker.checkout(
          {
            repositoryId: "support-service",
            checkoutSecretReference: "vault:repository/support-service",
            pinnedCommit: "a".repeat(40),
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "repository.runtimeConfiguration" });
    } finally {
      await rm(source.directory, { recursive: true, force: true });
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("DockerOciRepositorySandbox", () => {
  it("fails closed before attesting an unsupported host or non-immutable image", async () => {
    await expect(
      DockerOciRepositorySandbox.create({
        treeStore: new LocalPreparedRepositoryTreeStore(),
        image: "node:22",
      }),
    ).rejects.toMatchObject({ code: "repository.runtimeConfiguration" });
  });
});
