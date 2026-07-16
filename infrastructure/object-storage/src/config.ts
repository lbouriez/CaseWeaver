import { isAbsolute, resolve } from "node:path";

export type ObjectStorageRuntimeConfiguration =
  | LocalObjectStorageRuntimeConfiguration
  | S3ObjectStorageRuntimeConfiguration;

export interface ObjectStorageRuntimeConfigurationBase {
  /** Safe deployment identifier persisted with opaque object keys. */
  readonly storageBackendId: string;
  /** Server-private HMAC material. Never place this object in logs or DTOs. */
  readonly keyDerivationSecret: string;
  readonly keyPrefix: string;
}

export interface LocalObjectStorageRuntimeConfiguration
  extends ObjectStorageRuntimeConfigurationBase {
  readonly kind: "local";
  readonly rootDirectory: string;
}

export interface S3ObjectStorageRuntimeConfiguration
  extends ObjectStorageRuntimeConfigurationBase {
  readonly kind: "s3";
  readonly bucket: string;
  readonly region: string;
  readonly endpoint?: string;
  readonly forcePathStyle: boolean;
  readonly multipartPartSizeBytes: number;
  /** Required server-side encryption applied to every object write. */
  readonly encryption: S3ObjectStorageEncryption;
}

export type S3ObjectStorageEncryption =
  | Readonly<{ readonly algorithm: "AES256" }>
  | Readonly<{
      readonly algorithm: "aws:kms";
      /** Server-private KMS key reference; never include it in DTOs or logs. */
      readonly kmsKeyId: string;
    }>;

export interface ObjectStorageConfigurationEnvironment {
  readonly NODE_ENV?: string;
  readonly OBJECT_STORAGE_KIND?: string;
  readonly OBJECT_STORAGE_BACKEND_ID?: string;
  readonly OBJECT_STORAGE_KEY_DERIVATION_SECRET?: string;
  readonly OBJECT_STORAGE_KEY_PREFIX?: string;
  readonly OBJECT_STORAGE_LOCAL_ROOT?: string;
  readonly OBJECT_STORAGE_S3_BUCKET?: string;
  readonly OBJECT_STORAGE_S3_REGION?: string;
  readonly OBJECT_STORAGE_S3_ENDPOINT?: string;
  readonly OBJECT_STORAGE_S3_FORCE_PATH_STYLE?: string;
  readonly OBJECT_STORAGE_S3_MULTIPART_PART_SIZE_BYTES?: string;
  readonly OBJECT_STORAGE_S3_ENCRYPTION?: string;
  readonly OBJECT_STORAGE_S3_KMS_KEY_ID?: string;
}

const defaultKeyPrefix = "caseweaver";
const minimumMultipartPartSizeBytes = 5 * 1024 * 1024;
const defaultMultipartPartSizeBytes = 8 * 1024 * 1024;

export class ObjectStorageConfigurationError extends Error {
  public readonly code = "objectStorage.invalidConfiguration";
  public readonly retryable = false;

  public constructor() {
    super("Object storage configuration is invalid.");
    this.name = "ObjectStorageConfigurationError";
  }
}

/**
 * Parses deployment-only configuration. The result is intentionally useful
 * only to trusted composition and must never be serialized or logged.
 */
export function loadObjectStorageRuntimeConfiguration(
  environment: ObjectStorageConfigurationEnvironment,
): ObjectStorageRuntimeConfiguration {
  const kind = environment.OBJECT_STORAGE_KIND;
  const storageBackendId = requiredIdentifier(
    environment.OBJECT_STORAGE_BACKEND_ID,
  );
  const keyDerivationSecret = requiredSecret(
    environment.OBJECT_STORAGE_KEY_DERIVATION_SECRET,
  );
  const keyPrefix = parseKeyPrefix(environment.OBJECT_STORAGE_KEY_PREFIX);
  if (kind === "local") {
    if (environment.NODE_ENV === "production") {
      throw new ObjectStorageConfigurationError();
    }
    const rootDirectory = environment.OBJECT_STORAGE_LOCAL_ROOT;
    if (rootDirectory === undefined || !isAbsolute(rootDirectory)) {
      throw new ObjectStorageConfigurationError();
    }
    return Object.freeze({
      kind,
      storageBackendId,
      keyDerivationSecret,
      keyPrefix,
      rootDirectory: resolve(rootDirectory),
    });
  }
  if (kind !== "s3") throw new ObjectStorageConfigurationError();
  const endpoint = parseEndpoint(
    environment.OBJECT_STORAGE_S3_ENDPOINT,
    environment.NODE_ENV,
  );
  const multipartPartSizeBytes = parseMultipartPartSize(
    environment.OBJECT_STORAGE_S3_MULTIPART_PART_SIZE_BYTES,
  );
  const encryption = parseEncryption(
    environment.OBJECT_STORAGE_S3_ENCRYPTION,
    environment.OBJECT_STORAGE_S3_KMS_KEY_ID,
  );
  return Object.freeze({
    kind,
    storageBackendId,
    keyDerivationSecret,
    keyPrefix,
    bucket: parseBucket(environment.OBJECT_STORAGE_S3_BUCKET),
    region: requiredIdentifier(environment.OBJECT_STORAGE_S3_REGION),
    ...(endpoint === undefined ? {} : { endpoint }),
    forcePathStyle: parseBoolean(
      environment.OBJECT_STORAGE_S3_FORCE_PATH_STYLE,
    ),
    multipartPartSizeBytes,
    encryption,
  });
}

function requiredIdentifier(value: string | undefined): string {
  if (
    value === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(value)
  ) {
    throw new ObjectStorageConfigurationError();
  }
  return value;
}

function requiredSecret(value: string | undefined): string {
  if (value === undefined || value.length < 32 || value.length > 4096) {
    throw new ObjectStorageConfigurationError();
  }
  return value;
}

function parseKeyPrefix(value: string | undefined): string {
  const prefix = value ?? defaultKeyPrefix;
  if (
    !/^[a-z0-9][a-z0-9._/-]{0,199}$/u.test(prefix) ||
    prefix.includes("//") ||
    prefix.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new ObjectStorageConfigurationError();
  }
  return prefix.replace(/\/+$/u, "");
}

function parseBucket(value: string | undefined): string {
  if (
    value === undefined ||
    !/^(?!\d+\.\d+\.\d+\.\d+$)(?=.{3,63}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(
      value,
    ) ||
    value.includes("..")
  ) {
    throw new ObjectStorageConfigurationError();
  }
  return value;
}

function parseEndpoint(
  value: string | undefined,
  nodeEnvironment: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ObjectStorageConfigurationError();
  }
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && nodeEnvironment !== "production")) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new ObjectStorageConfigurationError();
  }
  return url.toString().replace(/\/$/u, "");
}

function parseBoolean(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new ObjectStorageConfigurationError();
}

function parseMultipartPartSize(value: string | undefined): number {
  if (value === undefined) return defaultMultipartPartSizeBytes;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimumMultipartPartSizeBytes ||
    parsed > 512 * 1024 * 1024
  ) {
    throw new ObjectStorageConfigurationError();
  }
  return parsed;
}

function parseEncryption(
  value: string | undefined,
  kmsKeyId: string | undefined,
): S3ObjectStorageEncryption {
  const algorithm = value ?? "AES256";
  if (algorithm === "AES256" && kmsKeyId === undefined) {
    return Object.freeze({ algorithm });
  }
  if (
    algorithm === "aws:kms" &&
    kmsKeyId !== undefined &&
    /^[A-Za-z0-9:/_.-]{1,2048}$/u.test(kmsKeyId)
  ) {
    return Object.freeze({ algorithm, kmsKeyId });
  }
  throw new ObjectStorageConfigurationError();
}
