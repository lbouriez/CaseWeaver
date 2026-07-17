import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type {
  GitRepository,
  GitRepositoryAuthentication,
  GitRepositoryReference,
} from "@caseweaver/connector-git-markdown";
import {
  createPrivatePreparedRepositoryTree,
  isSafeRepositoryTextFile,
  type PinnedRepositoryFile,
  type PreparedRepositoryTreeRegistrar,
  publishPreparedRepositoryTree,
  type RepositoryCheckoutBroker,
  RepositoryRuntimeError,
  type SanitizedPinnedTree,
} from "@caseweaver/repository-runtime";

const shaPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu;

export interface RemoteGitRepositorySource {
  readonly repositoryId: string;
  /** Server-managed credential-free HTTPS remote; never emitted from checkout. */
  readonly url: string;
  /** Trusted branch/tag used only to fetch the previously resolved exact commit. */
  readonly ref: GitRepositoryReference;
}

/** Resolves checkout material only at the remote Git boundary. */
export interface GitCheckoutAuthenticationResolver {
  resolve(input: {
    readonly checkoutSecretReference: string;
    readonly signal: AbortSignal;
  }): Promise<GitRepositoryAuthentication>;
}

export interface RemotePinnedCheckoutLimits {
  readonly maximumFiles: number;
  readonly maximumFileBytes: number;
  readonly maximumTreeBytes: number;
}

export interface GitCliPinnedRepositoryCheckoutBrokerOptions {
  /** A hardened GitCliRepository configured with its worker-owned bare cache. */
  readonly repository: GitRepository;
  readonly sources: readonly RemoteGitRepositorySource[];
  readonly authentication: GitCheckoutAuthenticationResolver;
  readonly treeStore: PreparedRepositoryTreeRegistrar;
  readonly temporaryDirectory?: string;
  readonly limits?: Partial<RemotePinnedCheckoutLimits>;
}

const defaultLimits: RemotePinnedCheckoutLimits = Object.freeze({
  maximumFiles: 20_000,
  maximumFileBytes: 4 * 1024 * 1024,
  maximumTreeBytes: 64 * 1024 * 1024,
});

function unavailable(
  code:
    | "repository.runtimeConfiguration"
    | "repository.runtimeIsolation"
    | "repository.runtimePreparation",
  message: string,
): RepositoryRuntimeError {
  return new RepositoryRuntimeError(code, message);
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw unavailable(
      "repository.runtimeConfiguration",
      `${label} is invalid.`,
    );
  }
}

function safeIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    [...value].every((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && code >= 32 && code !== 127;
    })
  );
}

function safeRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
}

function safeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1_024 &&
    !isAbsolute(value) &&
    !value.startsWith("\\") &&
    !value.includes("\\") &&
    !value.includes(":") &&
    !value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  );
}

function within(root: string, candidate: string): boolean {
  const between = relative(root, candidate);
  return (
    between === "" || (!between.startsWith(`..${sep}`) && between !== "..")
  );
}

function lines(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r\n|\r|\n/u).length;
}

function normalizedLimits(
  overrides: Partial<RemotePinnedCheckoutLimits> | undefined,
): RemotePinnedCheckoutLimits {
  const limits = { ...defaultLimits, ...overrides };
  for (const [name, value] of Object.entries(limits))
    positiveInteger(value, name);
  return Object.freeze(limits);
}

function assertAuthentication(value: GitRepositoryAuthentication): void {
  if (value.kind === "none") return;
  if (
    value.kind !== "token" ||
    value.token.length === 0 ||
    [...value.token].some((character) => {
      const code = character.codePointAt(0);
      return code === undefined || code < 32 || code === 127;
    })
  ) {
    throw unavailable(
      "repository.runtimeConfiguration",
      "Repository checkout credentials are unavailable.",
    );
  }
}

/**
 * Remote checkout adapter for a server-selected commit. It delegates every
 * network, cache, AskPass, ref, and Git process concern to the existing
 * hardened GitRepository adapter, then materializes only sanitized UTF-8 text
 * into an opaque private tree for the repository sandbox.
 */
export class GitCliPinnedRepositoryCheckoutBroker
  implements RepositoryCheckoutBroker
{
  private readonly sources = new Map<string, RemoteGitRepositorySource>();
  private readonly temporaryDirectory: string;
  private readonly limits: RemotePinnedCheckoutLimits;

  public constructor(
    private readonly options: GitCliPinnedRepositoryCheckoutBrokerOptions,
  ) {
    if (options.sources.length === 0) {
      throw unavailable(
        "repository.runtimeConfiguration",
        "At least one remote Git repository source is required.",
      );
    }
    for (const source of options.sources) {
      if (
        !safeIdentifier(source.repositoryId) ||
        !safeRemoteUrl(source.url) ||
        this.sources.has(source.repositoryId)
      ) {
        throw unavailable(
          "repository.runtimeConfiguration",
          "Remote Git repository configuration is invalid.",
        );
      }
      this.sources.set(source.repositoryId, Object.freeze({ ...source }));
    }
    this.temporaryDirectory = resolve(options.temporaryDirectory ?? tmpdir());
    this.limits = normalizedLimits(options.limits);
  }

  public async checkout(
    configuration: {
      readonly repositoryId: string;
      readonly checkoutSecretReference: string;
      readonly pinnedCommit: string;
    },
    signal: AbortSignal,
  ): Promise<SanitizedPinnedTree> {
    if (signal.aborted) throw signal.reason;
    if (
      !safeIdentifier(configuration.repositoryId) ||
      !safeIdentifier(configuration.checkoutSecretReference) ||
      !shaPattern.test(configuration.pinnedCommit)
    ) {
      throw unavailable(
        "repository.runtimeConfiguration",
        "Remote Git checkout configuration is invalid.",
      );
    }
    const source = this.sources.get(configuration.repositoryId);
    if (source === undefined) {
      throw unavailable(
        "repository.runtimeConfiguration",
        "Configured remote repository is unavailable.",
      );
    }
    const authentication = await this.options.authentication.resolve({
      checkoutSecretReference: configuration.checkoutSecretReference,
      signal,
    });
    assertAuthentication(authentication);
    const preparedTree = await createPrivatePreparedRepositoryTree(
      this.temporaryDirectory,
    );
    try {
      const request = {
        repository: { kind: "remote" as const, url: source.url },
        allowedLocalRoots: [],
        ref: source.ref,
        authentication,
        signal,
      };
      const snapshot = await this.options.repository.inspect(request);
      if (
        snapshot.commitSha.toLowerCase() !==
          configuration.pinnedCommit.toLowerCase() ||
        snapshot.files.length > this.limits.maximumFiles
      ) {
        throw unavailable(
          "repository.runtimePreparation",
          "Configured pinned repository is unavailable.",
        );
      }
      const files: PinnedRepositoryFile[] = [];
      const manifest = new Map<string, string>();
      let totalBytes = 0;
      for (const entry of snapshot.files) {
        if (signal.aborted) throw signal.reason;
        if (
          !safeRelativePath(entry.path) ||
          !shaPattern.test(entry.blobOid) ||
          manifest.has(entry.path)
        ) {
          throw unavailable(
            "repository.runtimeIsolation",
            "Prepared repository path is unsafe.",
          );
        }
        manifest.set(entry.path, entry.blobOid);
        const blob = await this.options.repository.readFile({
          ...request,
          path: entry.path,
          commitSha: configuration.pinnedCommit.toLowerCase(),
        });
        if (
          blob.path !== entry.path ||
          !shaPattern.test(blob.blobOid) ||
          blob.blobOid.toLowerCase() !== entry.blobOid.toLowerCase() ||
          !shaPattern.test(blob.commitSha) ||
          blob.commitSha.toLowerCase() !==
            configuration.pinnedCommit.toLowerCase()
        ) {
          throw unavailable(
            "repository.runtimePreparation",
            "Configured pinned repository is unavailable.",
          );
        }
        const bytes = new TextEncoder().encode(blob.content);
        if (bytes.byteLength > this.limits.maximumFileBytes) continue;
        if (totalBytes + bytes.byteLength > this.limits.maximumTreeBytes) {
          throw unavailable(
            "repository.runtimeIsolation",
            "Configured repository exceeds its prepared-tree limit.",
          );
        }
        if (!isSafeRepositoryTextFile(blob.path, bytes)) continue;
        const output = resolve(preparedTree.stagingDirectory, blob.path);
        if (!within(preparedTree.stagingDirectory, output)) {
          throw unavailable(
            "repository.runtimeIsolation",
            "Prepared repository path is unsafe.",
          );
        }
        await mkdir(dirname(output), { recursive: true, mode: 0o700 });
        await writeFile(output, bytes, {
          encoding: "utf8",
          mode: 0o400,
          flag: "wx",
        });
        totalBytes += bytes.byteLength;
        files.push(
          Object.freeze({ path: blob.path, lineCount: lines(blob.content) }),
        );
      }
      const directory = await publishPreparedRepositoryTree(
        preparedTree,
        files.map((file) => file.path),
      );
      const tree: SanitizedPinnedTree = Object.freeze({
        treeId: randomUUID(),
        repositoryId: configuration.repositoryId,
        pinnedCommit: configuration.pinnedCommit.toLowerCase(),
        files: Object.freeze(files),
      });
      this.options.treeStore.register({
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
      if (signal.aborted) throw signal.reason;
      if (error instanceof RepositoryRuntimeError) throw error;
      throw unavailable(
        "repository.runtimePreparation",
        "Configured pinned repository is unavailable.",
      );
    }
  }
}
