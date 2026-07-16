import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";

import type { S3ObjectStorageEncryption } from "./config.js";
import {
  ObjectStorageCancelledError,
  throwIfAborted,
} from "./key-derivation.js";

export interface S3MultipartPart {
  readonly partNumber: number;
  readonly eTag: string;
}

export interface S3MultipartUpload {
  readonly key: string;
  readonly uploadId: string;
}

/** Narrow transport boundary keeps the storage policy independently testable. */
export interface S3ObjectStorageTransport {
  createMultipart(input: {
    readonly bucket: string;
    readonly key: string;
    readonly encryption: S3ObjectStorageEncryption;
    readonly signal: AbortSignal;
  }): Promise<Readonly<{ readonly uploadId: string }>>;
  uploadPart(input: {
    readonly bucket: string;
    readonly key: string;
    readonly uploadId: string;
    readonly partNumber: number;
    readonly body: Uint8Array;
    readonly signal: AbortSignal;
  }): Promise<Readonly<{ readonly eTag: string }>>;
  completeMultipart(input: {
    readonly bucket: string;
    readonly key: string;
    readonly uploadId: string;
    readonly parts: readonly S3MultipartPart[];
    readonly signal: AbortSignal;
  }): Promise<void>;
  abortMultipart(input: {
    readonly bucket: string;
    readonly key: string;
    readonly uploadId: string;
  }): Promise<void>;
  copyObject(input: {
    readonly bucket: string;
    readonly sourceKey: string;
    readonly targetKey: string;
    readonly encryption: S3ObjectStorageEncryption;
    readonly signal: AbortSignal;
  }): Promise<void>;
  putObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType?: string;
    /** A conditional create guard; derivative output must never be overwritten. */
    readonly ifNoneMatch?: "*";
    readonly encryption: S3ObjectStorageEncryption;
    readonly signal: AbortSignal;
  }): Promise<void>;
  openObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly signal: AbortSignal;
  }): Promise<AsyncIterable<Uint8Array>>;
  deleteObject(input: {
    readonly bucket: string;
    readonly key: string;
  }): Promise<void>;
  listObjectKeys(input: {
    readonly bucket: string;
    readonly prefix: string;
    readonly before: Date;
  }): Promise<readonly string[]>;
  listMultipartUploads(input: {
    readonly bucket: string;
    readonly prefix: string;
    readonly before: Date;
  }): Promise<readonly S3MultipartUpload[]>;
}

export class AwsSdkS3ObjectStorageTransport
  implements S3ObjectStorageTransport
{
  public constructor(private readonly client: S3Client) {}

  public async createMultipart(input: {
    readonly bucket: string;
    readonly key: string;
    readonly encryption: S3ObjectStorageEncryption;
    readonly signal: AbortSignal;
  }): Promise<Readonly<{ readonly uploadId: string }>> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        ...encryptionHeaders(input.encryption),
      }),
      { abortSignal: input.signal },
    );
    if (result.UploadId === undefined || result.UploadId.length === 0) {
      throw new Error("Object storage did not return a multipart upload ID.");
    }
    return Object.freeze({ uploadId: result.UploadId });
  }

  public async uploadPart(input: {
    readonly bucket: string;
    readonly key: string;
    readonly uploadId: string;
    readonly partNumber: number;
    readonly body: Uint8Array;
    readonly signal: AbortSignal;
  }): Promise<Readonly<{ readonly eTag: string }>> {
    const result = await this.client.send(
      new UploadPartCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.uploadId,
        PartNumber: input.partNumber,
        Body: input.body,
      }),
      { abortSignal: input.signal },
    );
    if (result.ETag === undefined || result.ETag.length === 0) {
      throw new Error("Object storage did not return a multipart part ETag.");
    }
    return Object.freeze({ eTag: result.ETag });
  }

  public async completeMultipart(input: {
    readonly bucket: string;
    readonly key: string;
    readonly uploadId: string;
    readonly parts: readonly S3MultipartPart[];
    readonly signal: AbortSignal;
  }): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.uploadId,
        MultipartUpload: {
          Parts: input.parts.map((part) => ({
            ETag: part.eTag,
            PartNumber: part.partNumber,
          })),
        },
      }),
      { abortSignal: input.signal },
    );
  }

  public async abortMultipart(input: {
    readonly bucket: string;
    readonly key: string;
    readonly uploadId: string;
  }): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.uploadId,
      }),
    );
  }

  public async copyObject(input: {
    readonly bucket: string;
    readonly sourceKey: string;
    readonly targetKey: string;
    readonly encryption: S3ObjectStorageEncryption;
    readonly signal: AbortSignal;
  }): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: input.bucket,
        Key: input.targetKey,
        CopySource: `/${input.bucket}/${input.sourceKey
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
        ...encryptionHeaders(input.encryption),
      }),
      { abortSignal: input.signal },
    );
  }

  public async putObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType?: string;
    readonly ifNoneMatch?: "*";
    readonly encryption: S3ObjectStorageEncryption;
    readonly signal: AbortSignal;
  }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body: input.body,
        ...encryptionHeaders(input.encryption),
        ...(input.contentType === undefined
          ? {}
          : { ContentType: input.contentType }),
        ...(input.ifNoneMatch === undefined
          ? {}
          : { IfNoneMatch: input.ifNoneMatch }),
      }),
      { abortSignal: input.signal },
    );
  }

  public async openObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly signal: AbortSignal;
  }): Promise<AsyncIterable<Uint8Array>> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
      { abortSignal: input.signal },
    );
    if (result.Body === undefined || !isAsyncIterable(result.Body)) {
      throw new Error("Object storage returned an unreadable object body.");
    }
    throwIfAborted(input.signal);
    return byteStream(result.Body, input.signal);
  }

  public async deleteObject(input: {
    readonly bucket: string;
    readonly key: string;
  }): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }),
    );
  }

  public async listObjectKeys(input: {
    readonly bucket: string;
    readonly prefix: string;
    readonly before: Date;
  }): Promise<readonly string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: input.bucket,
          Prefix: input.prefix,
          ...(continuationToken === undefined
            ? {}
            : { ContinuationToken: continuationToken }),
        }),
      );
      for (const item of result.Contents ?? []) {
        if (
          item.Key !== undefined &&
          item.LastModified !== undefined &&
          item.LastModified <= input.before
        ) {
          keys.push(item.Key);
        }
      }
      continuationToken = result.IsTruncated
        ? result.NextContinuationToken
        : undefined;
    } while (continuationToken !== undefined);
    return Object.freeze(keys);
  }

  public async listMultipartUploads(input: {
    readonly bucket: string;
    readonly prefix: string;
    readonly before: Date;
  }): Promise<readonly S3MultipartUpload[]> {
    const uploads: S3MultipartUpload[] = [];
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    do {
      const result = await this.client.send(
        new ListMultipartUploadsCommand({
          Bucket: input.bucket,
          Prefix: input.prefix,
          ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
          ...(uploadIdMarker === undefined
            ? {}
            : { UploadIdMarker: uploadIdMarker }),
        }),
      );
      for (const upload of result.Uploads ?? []) {
        if (
          upload.Key !== undefined &&
          upload.UploadId !== undefined &&
          upload.Initiated !== undefined &&
          upload.Initiated <= input.before
        ) {
          uploads.push(
            Object.freeze({ key: upload.Key, uploadId: upload.UploadId }),
          );
        }
      }
      keyMarker = result.IsTruncated ? result.NextKeyMarker : undefined;
      uploadIdMarker = result.IsTruncated
        ? result.NextUploadIdMarker
        : undefined;
    } while (keyMarker !== undefined);
    return Object.freeze(uploads);
  }
}

function encryptionHeaders(encryption: S3ObjectStorageEncryption): Readonly<{
  readonly ServerSideEncryption: "AES256" | "aws:kms";
  readonly SSEKMSKeyId?: string;
}> {
  return encryption.algorithm === "AES256"
    ? Object.freeze({ ServerSideEncryption: encryption.algorithm })
    : Object.freeze({
        ServerSideEncryption: encryption.algorithm,
        SSEKMSKeyId: encryption.kmsKeyId,
      });
}

interface AbortableAsyncIterable extends AsyncIterable<unknown> {
  destroy?(error?: Error): void;
}

function isAsyncIterable(value: unknown): value is AbortableAsyncIterable {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}

async function* byteStream(
  source: AbortableAsyncIterable,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  const abort = () => {
    source.destroy?.(new ObjectStorageCancelledError());
    void iterator.return?.().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const next = await iterator.next();
      throwIfAborted(signal);
      if (next.done) return;
      if (next.value instanceof Uint8Array) {
        yield next.value;
        continue;
      }
      throw new Error("Object storage returned a non-binary object chunk.");
    }
  } catch (error) {
    if (signal.aborted) throw new ObjectStorageCancelledError();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    await iterator.return?.();
  }
}
