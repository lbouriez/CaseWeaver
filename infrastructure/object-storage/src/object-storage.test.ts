import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { S3Client } from "@aws-sdk/client-s3";

import { describe, expect, it } from "vitest";

import {
  AwsSdkS3ObjectStorageTransport,
  InMemoryBlobStore,
  LocalFilesystemBlobStore,
  loadObjectStorageRuntimeConfiguration,
  S3CompatibleBlobStore,
  type S3MultipartPart,
  type S3MultipartUpload,
  type S3ObjectStorageTransport,
} from "./index.js";

const secret = "test-object-storage-key-derivation-secret";

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

const localConfiguration = (rootDirectory: string) => ({
  kind: "local" as const,
  storageBackendId: "local-dev",
  keyDerivationSecret: secret,
  keyPrefix: "caseweaver",
  rootDirectory,
});

const s3Configuration = {
  kind: "s3" as const,
  storageBackendId: "s3-prod",
  keyDerivationSecret: secret,
  keyPrefix: "caseweaver",
  bucket: "caseweaver-test-bucket",
  region: "ca-central-1",
  forcePathStyle: true,
  multipartPartSizeBytes: 5 * 1024 * 1024,
  encryption: { algorithm: "AES256" } as const,
};

class FakeS3Transport implements S3ObjectStorageTransport {
  public readonly objects = new Map<string, Uint8Array>();
  public readonly uploads = new Map<
    string,
    { readonly key: string; readonly parts: Uint8Array[] }
  >();
  public readonly deleted: string[] = [];

  public async createMultipart(input: {
    readonly key: string;
  }): Promise<Readonly<{ readonly uploadId: string }>> {
    const uploadId = randomUUID();
    this.uploads.set(uploadId, { key: input.key, parts: [] });
    return { uploadId };
  }

  public async uploadPart(input: {
    readonly uploadId: string;
    readonly body: Uint8Array;
  }): Promise<Readonly<{ readonly eTag: string }>> {
    const upload = this.uploads.get(input.uploadId);
    if (upload === undefined) throw new Error("missing upload");
    upload.parts.push(input.body.slice());
    return { eTag: `etag-${upload.parts.length}` };
  }

  public async completeMultipart(input: {
    readonly key: string;
    readonly uploadId: string;
    readonly parts: readonly S3MultipartPart[];
  }): Promise<void> {
    const upload = this.uploads.get(input.uploadId);
    if (
      upload === undefined ||
      upload.key !== input.key ||
      upload.parts.length !== input.parts.length
    ) {
      throw new Error("invalid multipart completion");
    }
    this.objects.set(input.key, joinBytes(upload.parts));
    this.uploads.delete(input.uploadId);
  }

  public async abortMultipart(input: {
    readonly uploadId: string;
  }): Promise<void> {
    this.uploads.delete(input.uploadId);
  }

  public async copyObject(input: {
    readonly sourceKey: string;
    readonly targetKey: string;
  }): Promise<void> {
    const value = this.objects.get(input.sourceKey);
    if (value === undefined) throw new Error("missing copy source");
    this.objects.set(input.targetKey, value.slice());
  }

  public async putObject(input: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly ifNoneMatch?: "*";
  }): Promise<void> {
    if (input.ifNoneMatch === "*" && this.objects.has(input.key)) {
      throw new Error("conditional object creation failed");
    }
    this.objects.set(input.key, input.body.slice());
  }

  public async openObject(input: {
    readonly key: string;
  }): Promise<AsyncIterable<Uint8Array>> {
    const value = this.objects.get(input.key);
    if (value === undefined) throw new Error("missing object");
    return (async function* () {
      yield value.slice();
    })();
  }

  public async deleteObject(input: { readonly key: string }): Promise<void> {
    this.deleted.push(input.key);
    this.objects.delete(input.key);
  }

  public async listObjectKeys(input: {
    readonly prefix: string;
  }): Promise<readonly string[]> {
    return [...this.objects.keys()].filter((key) =>
      key.startsWith(input.prefix),
    );
  }

  public async listMultipartUploads(input: {
    readonly prefix: string;
  }): Promise<readonly S3MultipartUpload[]> {
    return [...this.uploads.entries()]
      .filter(([, upload]) => upload.key.startsWith(input.prefix))
      .map(([uploadId, upload]) => ({ key: upload.key, uploadId }));
  }
}

class DestroyableBody implements AsyncIterable<Uint8Array> {
  public destroyed = false;
  public returned = false;

  public async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    try {
      yield Uint8Array.of(1);
      await new Promise<never>(() => undefined);
    } finally {
      this.returned = true;
    }
  }

  public destroy(): void {
    this.destroyed = true;
  }
}

describe("object-storage runtime configuration", () => {
  it("keeps deployment configuration private and rejects unsafe local/S3 production settings", () => {
    expect(() =>
      loadObjectStorageRuntimeConfiguration({
        NODE_ENV: "production",
        OBJECT_STORAGE_KIND: "local",
        OBJECT_STORAGE_BACKEND_ID: "local-dev",
        OBJECT_STORAGE_KEY_DERIVATION_SECRET: secret,
        OBJECT_STORAGE_LOCAL_ROOT: "C:\\storage",
      }),
    ).toThrow("invalid");
    expect(() =>
      loadObjectStorageRuntimeConfiguration({
        NODE_ENV: "production",
        OBJECT_STORAGE_KIND: "s3",
        OBJECT_STORAGE_BACKEND_ID: "s3-prod",
        OBJECT_STORAGE_KEY_DERIVATION_SECRET: secret,
        OBJECT_STORAGE_S3_BUCKET: "caseweaver-test-bucket",
        OBJECT_STORAGE_S3_REGION: "ca-central-1",
        OBJECT_STORAGE_S3_ENDPOINT: "http://minio.example.test",
      }),
    ).toThrow("invalid");
    expect(
      loadObjectStorageRuntimeConfiguration({
        NODE_ENV: "production",
        OBJECT_STORAGE_KIND: "s3",
        OBJECT_STORAGE_BACKEND_ID: "s3-prod",
        OBJECT_STORAGE_KEY_DERIVATION_SECRET: secret,
        OBJECT_STORAGE_S3_BUCKET: "caseweaver-test-bucket",
        OBJECT_STORAGE_S3_REGION: "ca-central-1",
      }),
    ).toMatchObject({
      kind: "s3",
      storageBackendId: "s3-prod",
      encryption: { algorithm: "AES256" },
    });
    expect(() =>
      loadObjectStorageRuntimeConfiguration({
        NODE_ENV: "production",
        OBJECT_STORAGE_KIND: "s3",
        OBJECT_STORAGE_BACKEND_ID: "s3-prod",
        OBJECT_STORAGE_KEY_DERIVATION_SECRET: secret,
        OBJECT_STORAGE_S3_BUCKET: "caseweaver-test-bucket",
        OBJECT_STORAGE_S3_REGION: "ca-central-1",
        OBJECT_STORAGE_S3_ENCRYPTION: "aws:kms",
      }),
    ).toThrow("invalid");
    expect(
      loadObjectStorageRuntimeConfiguration({
        NODE_ENV: "production",
        OBJECT_STORAGE_KIND: "s3",
        OBJECT_STORAGE_BACKEND_ID: "s3-prod",
        OBJECT_STORAGE_KEY_DERIVATION_SECRET: secret,
        OBJECT_STORAGE_S3_BUCKET: "caseweaver-test-bucket",
        OBJECT_STORAGE_S3_REGION: "ca-central-1",
        OBJECT_STORAGE_S3_ENCRYPTION: "aws:kms",
        OBJECT_STORAGE_S3_KMS_KEY_ID: "alias/caseweaver-production",
      }),
    ).toMatchObject({
      encryption: {
        algorithm: "aws:kms",
        kmsKeyId: "alias/caseweaver-production",
      },
    });
  });
});

describe("AWS S3 transport", () => {
  it("sets server-side encryption on multipart, copied, and direct writes", async () => {
    const inputs: unknown[] = [];
    const client = {
      send: async (command: { readonly input: unknown }) => {
        inputs.push(command.input);
        return { UploadId: "upload-1" };
      },
    } as unknown as S3Client;
    const transport = new AwsSdkS3ObjectStorageTransport(client);
    const signal = new AbortController().signal;
    const encryption = {
      algorithm: "aws:kms" as const,
      kmsKeyId: "alias/caseweaver-production",
    };

    await transport.createMultipart({
      bucket: "caseweaver-test-bucket",
      key: "staging",
      encryption,
      signal,
    });
    await transport.copyObject({
      bucket: "caseweaver-test-bucket",
      sourceKey: "staging",
      targetKey: "content",
      encryption,
      signal,
    });
    await transport.putObject({
      bucket: "caseweaver-test-bucket",
      key: "derivative",
      body: new Uint8Array(),
      encryption,
      signal,
    });

    expect(inputs).toHaveLength(3);
    for (const input of inputs) {
      expect(input).toMatchObject({
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: "alias/caseweaver-production",
      });
    }
  });

  it("destroys an opened body and reports cancellation while iterating after headers", async () => {
    const body = new DestroyableBody();
    const client = {
      send: async () => ({ Body: body }),
    } as unknown as S3Client;
    const transport = new AwsSdkS3ObjectStorageTransport(client);
    const controller = new AbortController();
    const stream = await transport.openObject({
      bucket: "caseweaver-test-bucket",
      key: "content",
      signal: controller.signal,
    });
    const iterator = stream[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: Uint8Array.of(1),
    });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({
      code: "objectStorage.cancelled",
    });
    expect(body.destroyed).toBe(true);
    expect(body.returned).toBe(true);
  });
});

describe("in-memory object storage fixture", () => {
  it("verifies bytes and denies forged workspace/backend handles without exposing a URL API", async () => {
    const store = new InMemoryBlobStore();
    const bytes = new TextEncoder().encode("safe");
    const signal = new AbortController().signal;
    const staging = await store.beginStaging({
      workspaceId: "workspace-a",
      maximumBytes: 10,
      signal,
    });
    await store.append(staging, bytes, signal);
    const blob = await store.commit(
      staging,
      { sha256: hash(bytes), byteLength: bytes.byteLength },
      signal,
    );

    const mismatchedStaging = await store.beginStaging({
      workspaceId: "workspace-a",
      maximumBytes: 10,
      signal,
    });
    await store.append(mismatchedStaging, bytes, signal);
    await expect(
      store.commit(
        mismatchedStaging,
        { sha256: "a".repeat(64), byteLength: bytes.byteLength },
        signal,
      ),
    ).rejects.toMatchObject({ code: "objectStorage.integrityMismatch" });
    expect(store.stagedCount()).toBe(0);

    expect("privateUrl" in store).toBe(false);
    expect(blob.key).not.toContain("workspace-a");
    await expect(store.open(blob, "workspace-b", signal)).rejects.toMatchObject(
      {
        code: "objectStorage.accessDenied",
      },
    );
    await expect(
      store.open(
        { ...blob, storageBackendId: "forged" },
        "workspace-a",
        signal,
      ),
    ).rejects.toMatchObject({ code: "objectStorage.accessDenied" });
  });
});

describe("immutable derivative output creation", () => {
  it("rejects a second in-memory derivative write", async () => {
    const store = new InMemoryBlobStore();
    const signal = new AbortController().signal;
    const output = await store.createOutput("workspace-output", signal);
    await store.writeText(output, "workspace-output", "first", signal);
    await expect(
      store.writeText(output, "workspace-output", "second", signal),
    ).rejects.toThrow();
  });

  it("rejects a second local derivative write", async () => {
    const root = await mkdtemp(join(tmpdir(), "caseweaver-output-"));
    const signal = new AbortController().signal;
    try {
      const store = await LocalFilesystemBlobStore.create(
        localConfiguration(root),
      );
      const output = await store.createOutput("workspace-output", signal);
      await store.writeText(output, "workspace-output", "first", signal);
      await expect(
        store.writeText(output, "workspace-output", "second", signal),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("atomically allows only one concurrent local derivative writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "caseweaver-output-race-"));
    const signal = new AbortController().signal;
    try {
      const store = await LocalFilesystemBlobStore.create(
        localConfiguration(root),
      );
      const output = await store.createOutput("workspace-output", signal);
      const writes = await Promise.allSettled([
        store.writeText(output, "workspace-output", "first", signal),
        store.writeText(output, "workspace-output", "second", signal),
      ]);
      expect(
        writes.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        writes.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sends an S3 conditional create guard for derivative output", async () => {
    const transport = new FakeS3Transport();
    const store = new S3CompatibleBlobStore(s3Configuration, transport);
    const signal = new AbortController().signal;
    const output = await store.createOutput("workspace-output", signal);
    await store.writeText(output, "workspace-output", "first", signal);
    await expect(
      store.writeText(output, "workspace-output", "second", signal),
    ).rejects.toThrow("conditional object creation failed");
  });
});

describe("local filesystem object storage", () => {
  it("uses atomic, workspace-scoped, cancellable files and idempotent deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "caseweaver-storage-"));
    try {
      const store = await LocalFilesystemBlobStore.create(
        localConfiguration(root),
      );
      const signal = new AbortController().signal;
      const bytes = new TextEncoder().encode("local content");
      const staging = await store.beginStaging({
        workspaceId: "workspace-local",
        maximumBytes: 64,
        signal,
      });
      await store.append(staging, bytes, signal);
      const blob = await store.commit(
        staging,
        { sha256: hash(bytes), byteLength: bytes.byteLength },
        signal,
      );
      expect(blob.key).not.toContain("workspace-local");
      expect(
        new TextDecoder().decode(
          await collect(await store.open(blob, "workspace-local", signal)),
        ),
      ).toBe("local content");
      await expect(
        store.open(
          { ...blob, workspaceId: "workspace-other" },
          "workspace-other",
          signal,
        ),
      ).rejects.toMatchObject({ code: "objectStorage.accessDenied" });
      await store.delete(blob, "workspace-local");
      await store.delete(blob, "workspace-local");

      const cancelled = new AbortController();
      const discarded = await store.beginStaging({
        workspaceId: "workspace-local",
        maximumBytes: 64,
        signal: cancelled.signal,
      });
      cancelled.abort();
      await expect(
        store.append(discarded, bytes, cancelled.signal),
      ).rejects.toMatchObject({
        code: "objectStorage.cancelled",
      });
      await store.abort(discarded);
      expect(await store.cleanupStaging(new Date(Date.now() + 1_000))).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("S3-compatible object storage", () => {
  it("uses bounded multipart staging, cleans staging, and preserves workspace/backend isolation", async () => {
    const transport = new FakeS3Transport();
    const store = new S3CompatibleBlobStore(s3Configuration, transport);
    const signal = new AbortController().signal;
    const bytes = new Uint8Array(5 * 1024 * 1024 + 3);
    bytes.fill(7);
    const staging = await store.beginStaging({
      workspaceId: "workspace-s3",
      maximumBytes: bytes.byteLength,
      signal,
    });
    await store.append(staging, bytes.subarray(0, 5 * 1024 * 1024), signal);
    await store.append(staging, bytes.subarray(5 * 1024 * 1024), signal);
    const blob = await store.commit(
      staging,
      { sha256: hash(bytes), byteLength: bytes.byteLength },
      signal,
    );
    expect(blob.key).not.toContain("workspace-s3");
    expect(transport.uploads.size).toBe(0);
    expect(transport.deleted.some((key) => key.includes("/staging/"))).toBe(
      true,
    );
    expect(
      hash(await collect(await store.open(blob, "workspace-s3", signal))),
    ).toBe(hash(bytes));
    await expect(store.delete(blob, "workspace-other")).rejects.toMatchObject({
      code: "objectStorage.accessDenied",
    });

    const abandoned = await store.beginStaging({
      workspaceId: "workspace-s3",
      maximumBytes: 5 * 1024 * 1024,
      signal,
    });
    await store.append(abandoned, bytes.subarray(0, 5 * 1024 * 1024), signal);
    expect(transport.uploads.size).toBe(1);
    expect(await store.cleanupStaging(new Date(Date.now() + 1_000))).toBe(1);
    expect(transport.uploads.size).toBe(0);
  });
});

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
