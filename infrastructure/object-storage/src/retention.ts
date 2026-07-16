import {
  assertRetentionObjectReference,
  type RetentionObjectReference,
  type RetentionObjectStore,
} from "@caseweaver/application";
import type { BlobStore } from "@caseweaver/attachments";

import { throwIfAborted } from "./key-derivation.js";

/**
 * Adapts the application retention port to a BlobStore without introducing a
 * backend default. The supplied immutable reference is the only identity used
 * for deletion; BlobStore performs its own backend and workspace validation.
 */
export class BlobStoreRetentionObjectStore implements RetentionObjectStore {
  public constructor(private readonly blobs: Pick<BlobStore, "delete">) {}

  public async delete(
    objectReference: RetentionObjectReference,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const reference = assertRetentionObjectReference(objectReference);
    await this.blobs.delete(
      {
        workspaceId: reference.workspaceId,
        storageBackendId: reference.storageBackendId,
        key: reference.key,
      },
      reference.workspaceId,
    );
    throwIfAborted(signal);
  }
}
