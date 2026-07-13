import { describe, expect, it } from "vitest";

import { InMemoryBlobStore } from "./index.js";

describe("InMemoryBlobStore", () => {
  it("enforces workspace-scoped blob access and never emits public object URLs", async () => {
    const store = new InMemoryBlobStore();
    const staging = await store.beginStaging({
      workspaceId: "workspace-a",
      maximumBytes: 10,
      signal: new AbortController().signal,
    });
    await store.append(
      staging,
      new TextEncoder().encode("safe"),
      new AbortController().signal,
    );
    const blob = await store.commit(
      staging,
      { sha256: "hash", byteLength: 4 },
      new AbortController().signal,
    );

    await expect(store.privateUrl(blob, "workspace-b")).rejects.toThrow(
      "workspace access was denied",
    );
    await expect(store.privateUrl(blob, "workspace-a")).resolves.toMatch(
      /^caseweaver-blob:\/\/private\//u,
    );
  });

  it("does not allow a forged handle to overwrite another workspace's blob", async () => {
    const store = new InMemoryBlobStore();
    const staging = await store.beginStaging({
      workspaceId: "workspace-b",
      maximumBytes: 10,
      signal: new AbortController().signal,
    });
    await store.append(
      staging,
      new TextEncoder().encode("safe"),
      new AbortController().signal,
    );
    const blob = await store.commit(
      staging,
      { sha256: "hash", byteLength: 4 },
      new AbortController().signal,
    );

    await expect(
      store.writeText(
        { workspaceId: "workspace-a", key: blob.key },
        "workspace-a",
        "attacker data",
        new AbortController().signal,
      ),
    ).rejects.toThrow("blob was not found");
    await expect(
      store.delete(
        { workspaceId: "workspace-a", key: blob.key },
        "workspace-a",
      ),
    ).rejects.toThrow("blob was not found");

    const chunks: Uint8Array[] = [];
    for await (const chunk of await store.open(
      blob,
      "workspace-b",
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }
    expect(new TextDecoder().decode(chunks.at(0))).toBe("safe");
  });
});
