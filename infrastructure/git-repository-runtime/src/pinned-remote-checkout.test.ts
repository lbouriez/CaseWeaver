import { rm } from "node:fs/promises";

import type { GitRepository } from "@caseweaver/connector-git-markdown";
import type { PreparedRepositoryTreeRegistrar } from "@caseweaver/repository-runtime";
import { describe, expect, it, vi } from "vitest";

import { GitCliPinnedRepositoryCheckoutBroker } from "./pinned-remote-checkout.js";

const commit = "a".repeat(40);

describe("GitCliPinnedRepositoryCheckoutBroker", () => {
  it("uses injected hardened Git access, sanitizes credentials, and emits only an opaque tree", async () => {
    const inspect = vi.fn(async () => ({
      commitSha: commit,
      files: [
        { path: "src/service.ts", blobOid: "b".repeat(40) },
        { path: ".env", blobOid: "c".repeat(40) },
      ],
    }));
    const readFile = vi.fn(async (input: { readonly path: string }) => ({
      path: input.path,
      blobOid: input.path === ".env" ? "c".repeat(40) : "b".repeat(40),
      commitSha: commit,
      content:
        input.path === ".env"
          ? "TOP_SECRET=never-model-readable"
          : "export function retry(): void {}\n",
    }));
    let registered: { readonly directory: string } | undefined;
    const treeStore: PreparedRepositoryTreeRegistrar = {
      register: (tree) => {
        registered = tree;
      },
    };
    const credentialCalls: unknown[] = [];
    const broker = new GitCliPinnedRepositoryCheckoutBroker({
      repository: { inspect, readFile } as unknown as GitRepository,
      sources: [
        {
          repositoryId: "support-service",
          url: "https://git.example/support/service.git",
          ref: { kind: "branch", name: "main" },
        },
      ],
      authentication: {
        resolve: async (input) => {
          credentialCalls.push(input);
          return { kind: "token", token: "checkout-token" };
        },
      },
      treeStore,
    });

    const tree = await broker.checkout(
      {
        repositoryId: "support-service",
        checkoutSecretReference: "vault:git/support-service",
        pinnedCommit: commit,
      },
      new AbortController().signal,
    );

    expect(inspect).toHaveBeenCalledOnce();
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(credentialCalls).toEqual([
      expect.objectContaining({
        checkoutSecretReference: "vault:git/support-service",
      }),
    ]);
    expect(tree).toMatchObject({
      repositoryId: "support-service",
      pinnedCommit: commit,
      files: [{ path: "src/service.ts", lineCount: 2 }],
    });
    expect(JSON.stringify(tree)).not.toContain("git.example");
    expect(JSON.stringify(tree)).not.toContain("checkout-token");
    expect(JSON.stringify(tree)).not.toContain("vault:git");
    expect(registered).toBeDefined();
    await rm((registered as { readonly directory: string }).directory, {
      recursive: true,
      force: true,
    });
  });

  it("fails closed when Git resolves a moving ref to a different commit", async () => {
    const broker = new GitCliPinnedRepositoryCheckoutBroker({
      repository: {
        inspect: async () => ({
          commitSha: "b".repeat(40),
          files: [],
        }),
        readFile: async () => {
          throw new Error("unreachable");
        },
      } as unknown as GitRepository,
      sources: [
        {
          repositoryId: "support-service",
          url: "https://git.example/support/service.git",
          ref: { kind: "branch", name: "main" },
        },
      ],
      authentication: { resolve: async () => ({ kind: "none" }) },
      treeStore: { register: () => undefined },
    });

    await expect(
      broker.checkout(
        {
          repositoryId: "support-service",
          checkoutSecretReference: "vault:git/support-service",
          pinnedCommit: commit,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "repository.runtimePreparation" });
  });

  it("fails closed unless every blob read matches the inspected pinned manifest", async () => {
    const manifest = {
      path: "src/service.ts",
      blobOid: "b".repeat(40),
    };
    const mismatches = [
      {
        name: "a different path",
        blob: { ...manifest, path: "src/other.ts", commitSha: commit },
      },
      {
        name: "a different blob object",
        blob: { ...manifest, blobOid: "c".repeat(40), commitSha: commit },
      },
      {
        name: "a different commit",
        blob: { ...manifest, commitSha: "d".repeat(40) },
      },
    ];

    for (const mismatch of mismatches) {
      const register = vi.fn();
      const broker = new GitCliPinnedRepositoryCheckoutBroker({
        repository: {
          inspect: async () => ({ commitSha: commit, files: [manifest] }),
          readFile: async () => ({
            ...mismatch.blob,
            content: "export const safe = true;\n",
          }),
        } as unknown as GitRepository,
        sources: [
          {
            repositoryId: "support-service",
            url: "https://git.example/support/service.git",
            ref: { kind: "branch", name: "main" },
          },
        ],
        authentication: { resolve: async () => ({ kind: "none" }) },
        treeStore: { register },
      });

      await expect(
        broker.checkout(
          {
            repositoryId: "support-service",
            checkoutSecretReference: "vault:git/support-service",
            pinnedCommit: commit,
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "repository.runtimePreparation" });
      expect(register).not.toHaveBeenCalled();
    }
  });
});
