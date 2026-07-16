import type { RetentionObjectReference } from "@caseweaver/application";
import type { BlobHandle, BlobStore } from "@caseweaver/attachments";
import { describe, expect, it } from "vitest";

import {
  BlobStoreRetentionObjectStore,
  ObjectStorageCancelledError,
} from "./index.js";

describe("BlobStoreRetentionObjectStore", () => {
  it("forwards only the complete immutable object identity to BlobStore", async () => {
    const calls: Array<{
      readonly handle: BlobHandle;
      readonly workspaceId: string;
    }> = [];
    const blobs: Pick<BlobStore, "delete"> = {
      delete: async (handle, workspaceId) => {
        calls.push({ handle, workspaceId });
      },
    };
    const reference: RetentionObjectReference = {
      workspaceId: "workspace-1" as RetentionObjectReference["workspaceId"],
      storageBackendId: "storage-primary",
      key: "v1/caseweaver/opaque/content/sha256",
    };

    await new BlobStoreRetentionObjectStore(blobs).delete(
      reference,
      new AbortController().signal,
    );

    expect(calls).toEqual([
      {
        handle: reference,
        workspaceId: "workspace-1",
      },
    ]);
  });

  it("rejects a cancelled operation before it can delete an object", async () => {
    let deleted = false;
    const controller = new AbortController();
    controller.abort();
    const blobs: Pick<BlobStore, "delete"> = {
      delete: async () => {
        deleted = true;
      },
    };
    const reference: RetentionObjectReference = {
      workspaceId: "workspace-1" as RetentionObjectReference["workspaceId"],
      storageBackendId: "storage-primary",
      key: "v1/caseweaver/opaque/content/sha256",
    };

    await expect(
      new BlobStoreRetentionObjectStore(blobs).delete(
        reference,
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(ObjectStorageCancelledError);

    expect(deleted).toBe(false);
  });

  it("fails closed when a persisted reference has no usable backend identity", async () => {
    let deleted = false;
    const blobs: Pick<BlobStore, "delete"> = {
      delete: async () => {
        deleted = true;
      },
    };
    const incomplete = {
      workspaceId: "workspace-1",
      storageBackendId: "",
      key: "v1/caseweaver/opaque/content/sha256",
    } as RetentionObjectReference;

    await expect(
      new BlobStoreRetentionObjectStore(blobs).delete(
        incomplete,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "retention.objectReferenceUnavailable" });

    expect(deleted).toBe(false);
  });
});
