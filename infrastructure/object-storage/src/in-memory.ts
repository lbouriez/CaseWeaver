import { createHash } from "node:crypto";

import type {
  AttachmentOutputStore,
  BlobHandle,
  BlobStagingHandle,
  BlobStore,
} from "@caseweaver/attachments";

import {
  assertSha256,
  ObjectKeyDeriver,
  ObjectStorageIntegrityError,
  throwIfAborted,
} from "./key-derivation.js";

interface StoredBlob {
  readonly workspaceId: string;
  readonly content: Uint8Array;
}

interface StagedBlob {
  readonly staging: BlobStagingHandle;
  readonly maximumBytes: number;
  readonly chunks: Uint8Array[];
  readonly hash: ReturnType<typeof createHash>;
  byteLength: number;
}

/** Deterministic test fixture. Production composition must reject this adapter. */
export class InMemoryBlobStore implements BlobStore, AttachmentOutputStore {
  private readonly keys: ObjectKeyDeriver;
  private readonly staging = new Map<string, StagedBlob>();
  private readonly blobs = new Map<string, StoredBlob>();

  public constructor(storageBackendId = "test-memory") {
    this.keys = new ObjectKeyDeriver({
      storageBackendId,
      keyDerivationSecret: "test-object-storage-key-derivation-secret",
      keyPrefix: "caseweaver",
    });
  }

  public async beginStaging(input: {
    readonly workspaceId: string;
    readonly maximumBytes: number;
    readonly signal: AbortSignal;
  }): Promise<BlobStagingHandle> {
    throwIfAborted(input.signal);
    if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1) {
      throw new RangeError("Object storage maximum bytes must be positive.");
    }
    const staging = this.keys.staging(input.workspaceId);
    this.staging.set(staging.id, {
      staging,
      maximumBytes: input.maximumBytes,
      chunks: [],
      hash: createHash("sha256"),
      byteLength: 0,
    });
    return staging;
  }

  public async append(
    staging: BlobStagingHandle,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const record = this.staged(staging);
    if (record.byteLength + bytes.byteLength > record.maximumBytes) {
      throw new RangeError("Object storage staging limit was exceeded.");
    }
    const copied = bytes.slice();
    record.chunks.push(copied);
    record.hash.update(copied);
    record.byteLength += copied.byteLength;
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
    const handle = this.keys.content(staging.workspaceId, input.sha256);
    this.blobs.set(handle.key, {
      workspaceId: handle.workspaceId,
      content: join(record.chunks),
    });
    this.staging.delete(staging.id);
    return handle;
  }

  public async abort(staging: BlobStagingHandle): Promise<void> {
    this.staging.delete(staging.id);
  }

  public async open(
    handle: BlobHandle,
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>> {
    this.keys.assertHandle(handle, workspaceId);
    const blob = this.blobs.get(handle.key);
    if (blob === undefined || blob.workspaceId !== workspaceId) {
      throw new Error("Object storage blob was not found.");
    }
    return (async function* () {
      throwIfAborted(signal);
      yield blob.content.slice();
    })();
  }

  public async writeText(
    handle: BlobHandle,
    workspaceId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    this.keys.assertOutputHandle(handle, workspaceId);
    if (this.blobs.has(handle.key)) {
      throw new ObjectStorageIntegrityError();
    }
    this.blobs.set(handle.key, {
      workspaceId,
      content: new TextEncoder().encode(text),
    });
  }

  public async delete(handle: BlobHandle, workspaceId: string): Promise<void> {
    this.keys.assertHandle(handle, workspaceId);
    const blob = this.blobs.get(handle.key);
    if (blob !== undefined && blob.workspaceId !== workspaceId) {
      throw new Error("Object storage blob was not found.");
    }
    this.blobs.delete(handle.key);
  }

  public async createOutput(
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<BlobHandle> {
    throwIfAborted(signal);
    return this.keys.output(workspaceId);
  }

  public stagedCount(): number {
    return this.staging.size;
  }

  private staged(staging: BlobStagingHandle): StagedBlob {
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
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
