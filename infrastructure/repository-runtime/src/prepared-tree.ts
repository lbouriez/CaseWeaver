import { chmod, lstat, mkdir, mkdtemp, rename } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { RepositoryRuntimeError } from "./contracts.js";

export interface PrivatePreparedRepositoryTree {
  /** Private, server-only parent used for lifecycle cleanup. */
  readonly parentDirectory: string;
  /** Private staging directory. It is never mounted or registered. */
  readonly stagingDirectory: string;
  /** Read-only directory mounted into the OCI tool container after publication. */
  readonly publicDirectory: string;
}

function within(root: string, candidate: string): boolean {
  const between = relative(root, candidate);
  return (
    between === "" || (!between.startsWith(`..${sep}`) && between !== "..")
  );
}

function preparationFailure(): RepositoryRuntimeError {
  return new RepositoryRuntimeError(
    "repository.runtimeIsolation",
    "Prepared repository tree is unavailable.",
  );
}

/**
 * Creates a private staging tree below a random private parent. The parent
 * remains inaccessible to the OCI user; only the final child tree is later
 * published for its read-only bind mount.
 */
export async function createPrivatePreparedRepositoryTree(
  temporaryDirectory: string,
): Promise<PrivatePreparedRepositoryTree> {
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  const parentDirectory = await mkdtemp(
    join(temporaryDirectory, "caseweaver-prepared-repository-"),
  );
  await chmod(parentDirectory, 0o700);
  const stagingDirectory = join(parentDirectory, "tree.staging");
  await mkdir(stagingDirectory, { mode: 0o700 });
  await chmod(stagingDirectory, 0o700);
  return Object.freeze({
    parentDirectory,
    stagingDirectory,
    publicDirectory: join(parentDirectory, "tree"),
  });
}

/**
 * Atomically publishes a completely materialized tree. Every regular file is
 * readable by Docker's fixed unprivileged UID and every directory is
 * traversable, while the random parent directory remains mode 0700.
 */
export async function publishPreparedRepositoryTree(
  tree: PrivatePreparedRepositoryTree,
  paths: readonly string[],
): Promise<string> {
  const directories = new Set<string>([tree.stagingDirectory]);
  for (const path of paths) {
    const candidate = resolve(tree.stagingDirectory, path);
    if (!within(tree.stagingDirectory, candidate)) throw preparationFailure();
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(candidate);
    } catch {
      throw preparationFailure();
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw preparationFailure();
    }
    await chmod(candidate, 0o444);
    for (
      let directory = dirname(candidate);
      within(tree.stagingDirectory, directory);
      directory = dirname(directory)
    ) {
      directories.add(directory);
      if (directory === tree.stagingDirectory) break;
    }
  }
  for (const directory of [...directories].sort(
    (left, right) => right.length - left.length,
  )) {
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(directory);
    } catch {
      throw preparationFailure();
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw preparationFailure();
    }
    await chmod(directory, 0o555);
  }
  try {
    await rename(tree.stagingDirectory, tree.publicDirectory);
  } catch {
    throw preparationFailure();
  }
  return tree.publicDirectory;
}
