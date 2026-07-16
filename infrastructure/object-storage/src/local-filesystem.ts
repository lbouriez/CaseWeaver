import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open as openFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type {
  AttachmentOutputStore,
  BlobHandle,
  BlobStagingHandle,
  BlobStore,
} from "@caseweaver/attachments";

import type { LocalObjectStorageRuntimeConfiguration } from "./config.js";
import {
  assertSha256,
  ObjectKeyDeriver,
  ObjectStorageIntegrityError,
  throwIfAborted,
} from "./key-derivation.js";

interface StagedFile {
  readonly staging: BlobStagingHandle;
  readonly path: string;
  readonly maximumBytes: number;
  readonly hash: ReturnType<typeof createHash>;
  readonly file: Awaited<ReturnType<typeof openFile>>;
  byteLength: number;
  closed: boolean;
}

/** Secure filesystem storage for local development; production composition rejects it. */
export class LocalFilesystemBlobStore
  implements BlobStore, AttachmentOutputStore
{
  private readonly keys: ObjectKeyDeriver;
  private readonly staging = new Map<string, StagedFile>();

  private constructor(
    configuration: LocalObjectStorageRuntimeConfiguration,
    private readonly rootDirectory: string,
  ) {
    this.keys = new ObjectKeyDeriver(configuration);
  }

  public static async create(
    configuration: LocalObjectStorageRuntimeConfiguration,
  ): Promise<LocalFilesystemBlobStore> {
    if (!isAbsolute(configuration.rootDirectory)) {
      throw new Error("Local object storage root must be absolute.");
    }
    await mkdir(configuration.rootDirectory, { recursive: true, mode: 0o700 });
    await chmod(configuration.rootDirectory, 0o700);
    const canonicalRoot = await realpath(configuration.rootDirectory);
    if (canonicalRoot !== resolve(configuration.rootDirectory)) {
      throw new Error("Local object storage root must not be a symbolic link.");
    }
    const metadata = await lstat(canonicalRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Local object storage root is invalid.");
    }
    return new LocalFilesystemBlobStore(configuration, canonicalRoot);
  }

  public async beginStaging(input: {
    readonly workspaceId: string;
    readonly maximumBytes: number;
    readonly signal: AbortSignal;
  }): Promise<BlobStagingHandle> {
    throwIfAborted(input.signal);
    assertMaximumBytes(input.maximumBytes);
    const staging = this.keys.staging(input.workspaceId);
    const path = this.pathFor(this.keys.stagingKey(staging));
    await this.ensureParent(path);
    const file = await openFile(path, "wx", 0o600);
    this.staging.set(staging.id, {
      staging,
      path,
      maximumBytes: input.maximumBytes,
      hash: createHash("sha256"),
      file,
      byteLength: 0,
      closed: false,
    });
    return staging;
  }

  public async append(
    staging: BlobStagingHandle,
    content: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const record = this.staged(staging);
    if (record.byteLength + content.byteLength > record.maximumBytes) {
      throw new RangeError("Object storage staging limit was exceeded.");
    }
    await record.file.write(content);
    record.hash.update(content);
    record.byteLength += content.byteLength;
  }

  public async commit(
    staging: BlobStagingHandle,
    input: { readonly sha256: string; readonly byteLength: number },
    signal: AbortSignal,
  ): Promise<BlobHandle> {
    throwIfAborted(signal);
    assertSha256(input.sha256);
    const record = this.staged(staging);
    if (
      record.byteLength !== input.byteLength ||
      record.hash.digest("hex") !== input.sha256
    ) {
      await this.abort(staging);
      throw new ObjectStorageIntegrityError();
    }
    const target = this.keys.content(staging.workspaceId, input.sha256);
    const targetPath = this.pathFor(target.key);
    try {
      await record.file.sync();
      await record.file.close();
      record.closed = true;
      await this.ensureParent(targetPath);
      if (await existsRegularFile(targetPath)) {
        await unlink(record.path);
      } else {
        await rename(record.path, targetPath);
        await chmod(targetPath, 0o600);
      }
      this.staging.delete(staging.id);
      return target;
    } catch (error) {
      await this.abort(staging).catch(() => undefined);
      throw error;
    }
  }

  public async abort(staging: BlobStagingHandle): Promise<void> {
    const record = this.staging.get(staging.id);
    if (record === undefined) return;
    this.staging.delete(staging.id);
    if (!record.closed) await record.file.close().catch(() => undefined);
    await rm(record.path, { force: true }).catch(() => undefined);
  }

  public async open(
    handle: BlobHandle,
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>> {
    throwIfAborted(signal);
    this.keys.assertHandle(handle, workspaceId);
    const path = this.pathFor(handle.key);
    await assertRegularFile(path);
    return readBytes(path, signal);
  }

  public async writeText(
    handle: BlobHandle,
    workspaceId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    this.keys.assertOutputHandle(handle, workspaceId);
    const targetPath = this.pathFor(handle.key);
    const temporaryPath = `${targetPath}.tmp-${randomUUID()}`;
    await this.ensureParent(targetPath);
    const file = await openFile(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
      await file.close();
      throwIfAborted(signal);
      // `rename` may replace an existing destination on POSIX. A hard-link
      // creation is atomic within this filesystem and fails with EEXIST, so a
      // concurrent writer cannot overwrite a sealed derivative output.
      await link(temporaryPath, targetPath);
      await unlink(temporaryPath);
      await chmod(targetPath, 0o600);
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  public async delete(handle: BlobHandle, workspaceId: string): Promise<void> {
    this.keys.assertHandle(handle, workspaceId);
    const path = this.pathFor(handle.key);
    const existing = await lstat(path).catch(() => undefined);
    if (existing === undefined) return;
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("Local object storage object is invalid.");
    }
    await unlink(path);
  }

  public async createOutput(
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<BlobHandle> {
    throwIfAborted(signal);
    return this.keys.output(workspaceId);
  }

  public async cleanupStaging(before: Date): Promise<number> {
    // Staging is workspace-scoped, so traverse only generated directories below root.
    return this.cleanupDirectory(this.rootDirectory, before);
  }

  private async cleanupDirectory(
    directory: string,
    before: Date,
  ): Promise<number> {
    const entries = await readdir(directory, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (!withinRoot(this.rootDirectory, path)) continue;
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) {
        removed += await this.cleanupDirectory(path, before);
        continue;
      }
      if (
        metadata.isFile() &&
        path.includes(`${sep}staging${sep}`) &&
        metadata.mtime <= before
      ) {
        await unlink(path);
        removed += 1;
      }
    }
    return removed;
  }

  private staged(staging: BlobStagingHandle): StagedFile {
    const record = this.staging.get(staging.id);
    if (
      record === undefined ||
      record.staging.workspaceId !== staging.workspaceId ||
      record.staging.storageBackendId !== staging.storageBackendId
    ) {
      throw new Error("Object storage staging handle was not found.");
    }
    return record;
  }

  private pathFor(key: string): string {
    const parts = key.split("/");
    if (parts.some((part) => !/^[A-Za-z0-9._-]+$/u.test(part))) {
      throw new Error("Local object storage key is invalid.");
    }
    const path = resolve(this.rootDirectory, ...parts);
    if (!withinRoot(this.rootDirectory, path)) {
      throw new Error("Local object storage path escaped its root.");
    }
    return path;
  }

  private async ensureParent(path: string): Promise<void> {
    const parent = dirname(path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await assertSafeDirectoryTree(this.rootDirectory, parent);
  }
}

function assertMaximumBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Object storage maximum bytes must be positive.");
  }
}

function withinRoot(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

async function assertSafeDirectoryTree(
  root: string,
  directory: string,
): Promise<void> {
  let current = root;
  const relativePath = relative(root, directory);
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Local object storage directory is unsafe.");
    }
  }
}

async function existsRegularFile(path: string): Promise<boolean> {
  const metadata = await lstat(path).catch(() => undefined);
  if (metadata === undefined) return false;
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Local object storage object is invalid.");
  }
  return true;
}

async function assertRegularFile(path: string): Promise<void> {
  if (!(await existsRegularFile(path))) {
    throw new Error("Object storage blob was not found.");
  }
}

async function* readBytes(
  path: string,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  const file = await openFile(path, "r");
  try {
    const buffer = new Uint8Array(64 * 1024);
    while (true) {
      throwIfAborted(signal);
      const read = await file.read(buffer, 0, buffer.byteLength, null);
      if (read.bytesRead === 0) return;
      yield buffer.slice(0, read.bytesRead);
    }
  } finally {
    await file.close();
  }
}
