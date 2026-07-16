import { createHmac, randomUUID } from "node:crypto";

import type { BlobHandle, BlobStagingHandle } from "@caseweaver/attachments";

import type { ObjectStorageRuntimeConfigurationBase } from "./config.js";

export class ObjectStorageAccessError extends Error {
  public readonly code = "objectStorage.accessDenied";
  public readonly retryable = false;

  public constructor() {
    super("Object storage access was denied.");
    this.name = "ObjectStorageAccessError";
  }
}

export class ObjectStorageIntegrityError extends Error {
  public readonly code = "objectStorage.integrityMismatch";
  public readonly retryable = false;

  public constructor() {
    super("Object storage content did not match its recorded identity.");
    this.name = "ObjectStorageIntegrityError";
  }
}

export class ObjectStorageCancelledError extends Error {
  public readonly code = "objectStorage.cancelled";
  public readonly retryable = false;

  public constructor() {
    super("Object storage operation was cancelled.");
    this.name = "ObjectStorageCancelledError";
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ObjectStorageCancelledError();
}

export function assertSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new ObjectStorageIntegrityError();
  }
}

export class ObjectKeyDeriver {
  private readonly root: string;

  public constructor(
    private readonly configuration: ObjectStorageRuntimeConfigurationBase,
  ) {
    this.root = `v1/${configuration.keyPrefix}/${configuration.storageBackendId}`;
  }

  public content(workspaceId: string, sha256: string): BlobHandle {
    assertSha256(sha256);
    return this.handle(workspaceId, `content/${sha256}`);
  }

  public output(workspaceId: string): BlobHandle {
    return this.handle(workspaceId, `derivative/${randomUUID()}`);
  }

  public staging(workspaceId: string): BlobStagingHandle {
    return Object.freeze({
      workspaceId,
      storageBackendId: this.configuration.storageBackendId,
      id: randomUUID(),
    });
  }

  public stagingKey(staging: BlobStagingHandle): string {
    this.assertStaging(staging);
    return `${this.workspaceRoot(staging.workspaceId)}/staging/${staging.id}`;
  }

  public assertHandle(handle: BlobHandle, workspaceId: string): void {
    if (
      handle.workspaceId !== workspaceId ||
      handle.storageBackendId !== this.configuration.storageBackendId ||
      !this.isObjectKeyForWorkspace(handle.key, workspaceId)
    ) {
      throw new ObjectStorageAccessError();
    }
  }

  public assertOutputHandle(handle: BlobHandle, workspaceId: string): void {
    this.assertHandle(handle, workspaceId);
    if (
      !handle.key.startsWith(`${this.workspaceRoot(workspaceId)}/derivative/`)
    ) {
      throw new ObjectStorageAccessError();
    }
  }

  public workspacePrefix(workspaceId: string): string {
    return `${this.workspaceRoot(workspaceId)}/`;
  }

  public storagePrefix(): string {
    return `${this.root}/`;
  }

  private handle(workspaceId: string, suffix: string): BlobHandle {
    assertWorkspaceId(workspaceId);
    return Object.freeze({
      workspaceId,
      storageBackendId: this.configuration.storageBackendId,
      key: `${this.workspaceRoot(workspaceId)}/${suffix}`,
    });
  }

  private assertStaging(staging: BlobStagingHandle): void {
    if (
      staging.storageBackendId !== this.configuration.storageBackendId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        staging.id,
      )
    ) {
      throw new ObjectStorageAccessError();
    }
    assertWorkspaceId(staging.workspaceId);
  }

  private isObjectKeyForWorkspace(key: string, workspaceId: string): boolean {
    const prefix = `${this.workspaceRoot(workspaceId)}/`;
    return (
      key.startsWith(prefix) &&
      /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u.test(key) &&
      !key.includes("..") &&
      !key.includes("//")
    );
  }

  private workspaceRoot(workspaceId: string): string {
    assertWorkspaceId(workspaceId);
    const scope = createHmac("sha256", this.configuration.keyDerivationSecret)
      .update(workspaceId, "utf8")
      .digest("base64url");
    return `${this.root}/${scope}`;
  }
}

function assertWorkspaceId(value: string): void {
  if (
    value.length === 0 ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new ObjectStorageAccessError();
  }
}
