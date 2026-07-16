import { S3Client } from "@aws-sdk/client-s3";
import type { AttachmentOutputStore, BlobStore } from "@caseweaver/attachments";

import type { ObjectStorageRuntimeConfiguration } from "./config.js";
import { LocalFilesystemBlobStore } from "./local-filesystem.js";
import { S3CompatibleBlobStore } from "./s3-compatible.js";
import { AwsSdkS3ObjectStorageTransport } from "./s3-transport.js";

export * from "./config.js";
export * from "./in-memory.js";
export * from "./key-derivation.js";
export * from "./local-filesystem.js";
export * from "./retention.js";
export * from "./s3-compatible.js";
export * from "./s3-transport.js";

export type ProductionBlobStore = BlobStore & AttachmentOutputStore;

/** Trusted deployment composition only; no browser/API code receives this configuration. */
export async function createProductionBlobStore(
  configuration: ObjectStorageRuntimeConfiguration,
): Promise<ProductionBlobStore> {
  if (configuration.kind === "local") {
    return LocalFilesystemBlobStore.create(configuration);
  }
  const client = new S3Client({
    region: configuration.region,
    ...(configuration.endpoint === undefined
      ? {}
      : { endpoint: configuration.endpoint }),
    forcePathStyle: configuration.forcePathStyle,
  });
  return new S3CompatibleBlobStore(
    configuration,
    new AwsSdkS3ObjectStorageTransport(client),
  );
}
