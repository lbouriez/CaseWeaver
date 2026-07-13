import { randomUUID } from "node:crypto";

import type {
  AttachmentOutputStore,
  BlobHandle,
  BlobStagingHandle,
  BlobStore,
} from "@caseweaver/attachments";

interface StoredBlob {
  readonly workspaceId: string;
  readonly content: Uint8Array;
  readonly sha256: string;
}

interface StagedBlob {
  readonly workspaceId: string;
  readonly maximumBytes: number;
  readonly chunks: Uint8Array[];
  byteLength: number;
}

function assertWorkspace(
  handle: { readonly workspaceId: string },
  workspaceId: string,
): void {
  if (handle.workspaceId !== workspaceId) {
    throw new Error("Object storage workspace access was denied.");
  }
}

function content(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * Deterministic local storage adapter for tests and development composition.
 * The `caseweaver-blob:` URI is an opaque internal locator, never a public object URL.
 */
export class InMemoryBlobStore implements BlobStore, AttachmentOutputStore {
  private readonly staging = new Map<string, StagedBlob>();
  private readonly blobs = new Map<string, StoredBlob>();

  public async beginStaging(input: {
    readonly workspaceId: string;
    readonly maximumBytes: number;
    readonly signal: AbortSignal;
  }): Promise<BlobStagingHandle> {
    if (input.signal.aborted) throw new DOMException("aborted", "AbortError");
    if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1) {
      throw new RangeError("Object storage maximum bytes must be positive.");
    }
    const id = randomUUID();
    this.staging.set(id, {
      workspaceId: input.workspaceId,
      maximumBytes: input.maximumBytes,
      chunks: [],
      byteLength: 0,
    });
    return Object.freeze({ workspaceId: input.workspaceId, id });
  }

  public async append(
    staging: BlobStagingHandle,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const record = this.staging.get(staging.id);
    if (record === undefined || record.workspaceId !== staging.workspaceId) {
      throw new Error("Object storage staging handle was not found.");
    }
    if (record.byteLength + bytes.byteLength > record.maximumBytes) {
      throw new RangeError("Object storage staging limit was exceeded.");
    }
    record.chunks.push(bytes.slice());
    record.byteLength += bytes.byteLength;
  }

  public async commit(
    staging: BlobStagingHandle,
    input: { readonly sha256: string; readonly byteLength: number },
    signal: AbortSignal,
  ): Promise<BlobHandle> {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const record = this.staging.get(staging.id);
    if (
      record === undefined ||
      record.workspaceId !== staging.workspaceId ||
      record.byteLength !== input.byteLength
    ) {
      throw new Error("Object storage staging commit was invalid.");
    }
    const key = `blob:${randomUUID()}`;
    this.blobs.set(key, {
      workspaceId: staging.workspaceId,
      content: content(record.chunks),
      sha256: input.sha256,
    });
    this.staging.delete(staging.id);
    return Object.freeze({ workspaceId: staging.workspaceId, key });
  }

  public async abort(staging: BlobStagingHandle): Promise<void> {
    const record = this.staging.get(staging.id);
    if (record === undefined || record.workspaceId !== staging.workspaceId) {
      return;
    }
    this.staging.delete(staging.id);
  }

  public async privateUrl(
    handle: BlobHandle,
    workspaceId: string,
  ): Promise<string> {
    const blob = this.get(handle, workspaceId);
    return `caseweaver-blob://private/${encodeURIComponent(blob.workspaceId)}/${encodeURIComponent(handle.key)}`;
  }

  public async open(
    handle: BlobHandle,
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>> {
    const blob = this.get(handle, workspaceId);
    return (async function* () {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      yield blob.content.slice();
    })();
  }

  public async writeText(
    handle: BlobHandle,
    workspaceId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const existing = this.get(handle, workspaceId);
    this.blobs.set(handle.key, {
      workspaceId: existing.workspaceId,
      content: new TextEncoder().encode(text),
      sha256: "",
    });
  }

  public async delete(handle: BlobHandle, workspaceId: string): Promise<void> {
    this.get(handle, workspaceId);
    this.blobs.delete(handle.key);
  }

  public async createOutput(
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<BlobHandle> {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const key = `derivative:${randomUUID()}`;
    this.blobs.set(key, {
      workspaceId,
      content: new Uint8Array(),
      sha256: "",
    });
    return Object.freeze({ workspaceId, key });
  }

  public stagedCount(): number {
    return this.staging.size;
  }

  private get(handle: BlobHandle, workspaceId: string): StoredBlob {
    assertWorkspace(handle, workspaceId);
    const blob = this.blobs.get(handle.key);
    if (blob === undefined || blob.workspaceId !== workspaceId) {
      throw new Error("Object storage blob was not found.");
    }
    return blob;
  }
}
