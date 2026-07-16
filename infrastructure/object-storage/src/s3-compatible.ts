import { createHash } from "node:crypto";

import type {
  AttachmentOutputStore,
  BlobHandle,
  BlobStagingHandle,
  BlobStore,
} from "@caseweaver/attachments";

import type { S3ObjectStorageRuntimeConfiguration } from "./config.js";
import {
  assertSha256,
  ObjectKeyDeriver,
  ObjectStorageIntegrityError,
  throwIfAborted,
} from "./key-derivation.js";
import type {
  S3MultipartPart,
  S3ObjectStorageTransport,
} from "./s3-transport.js";

interface StagedMultipart {
  readonly staging: BlobStagingHandle;
  readonly key: string;
  readonly uploadId: string;
  readonly maximumBytes: number;
  readonly hash: ReturnType<typeof createHash>;
  readonly buffers: Uint8Array[];
  readonly parts: S3MultipartPart[];
  byteLength: number;
  bufferedBytes: number;
  completed: boolean;
}

/**
 * Private S3-compatible storage. Object keys are derived server-side and this
 * adapter has no API for returning URLs, signed or otherwise.
 */
export class S3CompatibleBlobStore implements BlobStore, AttachmentOutputStore {
  private readonly keys: ObjectKeyDeriver;
  private readonly staging = new Map<string, StagedMultipart>();

  public constructor(
    private readonly configuration: S3ObjectStorageRuntimeConfiguration,
    private readonly transport: S3ObjectStorageTransport,
  ) {
    this.keys = new ObjectKeyDeriver(configuration);
  }

  public async beginStaging(input: {
    readonly workspaceId: string;
    readonly maximumBytes: number;
    readonly signal: AbortSignal;
  }): Promise<BlobStagingHandle> {
    throwIfAborted(input.signal);
    assertMaximumBytes(input.maximumBytes);
    const staging = this.keys.staging(input.workspaceId);
    const key = this.keys.stagingKey(staging);
    const created = await this.transport.createMultipart({
      bucket: this.configuration.bucket,
      key,
      encryption: this.configuration.encryption,
      signal: input.signal,
    });
    this.staging.set(staging.id, {
      staging,
      key,
      uploadId: created.uploadId,
      maximumBytes: input.maximumBytes,
      hash: createHash("sha256"),
      buffers: [],
      parts: [],
      byteLength: 0,
      bufferedBytes: 0,
      completed: false,
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
    record.hash.update(content);
    record.byteLength += content.byteLength;
    let offset = 0;
    try {
      while (offset < content.byteLength) {
        const available =
          this.configuration.multipartPartSizeBytes - record.bufferedBytes;
        const nextOffset = Math.min(offset + available, content.byteLength);
        const portion = content.slice(offset, nextOffset);
        record.buffers.push(portion);
        record.bufferedBytes += portion.byteLength;
        offset = nextOffset;
        if (
          record.bufferedBytes === this.configuration.multipartPartSizeBytes
        ) {
          await this.uploadBufferedPart(
            record,
            this.configuration.multipartPartSizeBytes,
            signal,
          );
        }
      }
    } catch (error) {
      await this.abort(staging).catch(() => undefined);
      throw error;
    }
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
    try {
      if (record.bufferedBytes > 0) {
        await this.uploadBufferedPart(record, record.bufferedBytes, signal);
      }
      if (record.parts.length === 0) {
        await this.transport.abortMultipart({
          bucket: this.configuration.bucket,
          key: record.key,
          uploadId: record.uploadId,
        });
        await this.transport.putObject({
          bucket: this.configuration.bucket,
          key: target.key,
          body: new Uint8Array(),
          encryption: this.configuration.encryption,
          signal,
        });
      } else {
        await this.transport.completeMultipart({
          bucket: this.configuration.bucket,
          key: record.key,
          uploadId: record.uploadId,
          parts: record.parts,
          signal,
        });
        record.completed = true;
        await this.transport.copyObject({
          bucket: this.configuration.bucket,
          sourceKey: record.key,
          targetKey: target.key,
          encryption: this.configuration.encryption,
          signal,
        });
        await this.transport.deleteObject({
          bucket: this.configuration.bucket,
          key: record.key,
        });
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
    this.keys.stagingKey(staging);
    this.staging.delete(staging.id);
    if (!record.completed) {
      await this.transport
        .abortMultipart({
          bucket: this.configuration.bucket,
          key: record.key,
          uploadId: record.uploadId,
        })
        .catch(() => undefined);
    }
    await this.transport
      .deleteObject({ bucket: this.configuration.bucket, key: record.key })
      .catch(() => undefined);
  }

  public async open(
    handle: BlobHandle,
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>> {
    throwIfAborted(signal);
    this.keys.assertHandle(handle, workspaceId);
    return this.transport.openObject({
      bucket: this.configuration.bucket,
      key: handle.key,
      signal,
    });
  }

  public async writeText(
    handle: BlobHandle,
    workspaceId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    this.keys.assertOutputHandle(handle, workspaceId);
    await this.transport.putObject({
      bucket: this.configuration.bucket,
      key: handle.key,
      body: new TextEncoder().encode(text),
      contentType: "text/plain; charset=utf-8",
      encryption: this.configuration.encryption,
      ifNoneMatch: "*",
      signal,
    });
  }

  public async delete(handle: BlobHandle, workspaceId: string): Promise<void> {
    this.keys.assertHandle(handle, workspaceId);
    await this.transport.deleteObject({
      bucket: this.configuration.bucket,
      key: handle.key,
    });
  }

  public async createOutput(
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<BlobHandle> {
    throwIfAborted(signal);
    return this.keys.output(workspaceId);
  }

  /** Deletes abandoned server-created staging objects, never production data. */
  public async cleanupStaging(before: Date): Promise<number> {
    const prefix = this.keys.storagePrefix();
    const keys = await this.transport.listObjectKeys({
      bucket: this.configuration.bucket,
      prefix,
      before,
    });
    const uploads = await this.transport.listMultipartUploads({
      bucket: this.configuration.bucket,
      prefix,
      before,
    });
    const stagingKeys = keys.filter((key) => key.includes("/staging/"));
    const stagingUploads = uploads.filter((upload) =>
      upload.key.includes("/staging/"),
    );
    for (const key of stagingKeys) {
      await this.transport.deleteObject({
        bucket: this.configuration.bucket,
        key,
      });
    }
    for (const upload of stagingUploads) {
      await this.transport.abortMultipart({
        bucket: this.configuration.bucket,
        key: upload.key,
        uploadId: upload.uploadId,
      });
    }
    return stagingKeys.length + stagingUploads.length;
  }

  private staged(staging: BlobStagingHandle): StagedMultipart {
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

  private async uploadBufferedPart(
    record: StagedMultipart,
    byteLength: number,
    signal: AbortSignal,
  ): Promise<void> {
    const body = takeBytes(record.buffers, byteLength);
    record.bufferedBytes -= body.byteLength;
    const partNumber = record.parts.length + 1;
    if (partNumber > 10_000) {
      throw new RangeError(
        "Object storage multipart upload exceeded 10000 parts.",
      );
    }
    const uploaded = await this.transport.uploadPart({
      bucket: this.configuration.bucket,
      key: record.key,
      uploadId: record.uploadId,
      partNumber,
      body,
      signal,
    });
    record.parts.push(Object.freeze({ partNumber, eTag: uploaded.eTag }));
  }
}

function assertMaximumBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Object storage maximum bytes must be positive.");
  }
}

function takeBytes(chunks: Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const current = chunks[0];
    if (current === undefined) {
      throw new ObjectStorageIntegrityError();
    }
    const remaining = length - offset;
    if (current.byteLength <= remaining) {
      result.set(current, offset);
      offset += current.byteLength;
      chunks.shift();
      continue;
    }
    result.set(current.subarray(0, remaining), offset);
    chunks[0] = current.subarray(remaining);
    offset += remaining;
  }
  return result;
}
