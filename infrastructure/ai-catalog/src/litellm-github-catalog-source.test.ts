import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  GitHubLiteLlmCatalogSource,
  TrustedAiCatalogSourceError,
} from "./litellm-github-catalog-source.js";

describe("GitHubLiteLlmCatalogSource", () => {
  it("pins a resolved revision and returns SHA-addressed bounded bytes", async () => {
    const revision = "a".repeat(40);
    const catalog = new TextEncoder().encode('{"data":{}}');
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ object: { sha: revision } })),
      )
      .mockResolvedValueOnce(new Response(catalog));
    const source = new GitHubLiteLlmCatalogSource({
      fetchImplementation,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });

    const artifact = await source.load();

    const hash = createHash("sha256").update(catalog).digest("hex");
    expect(artifact).toMatchObject({
      snapshotId: `litellm-${hash}`,
      upstreamCommitSha: revision,
      upstreamUrl: `https://raw.githubusercontent.com/BerriAI/litellm/${revision}/model_prices_and_context_window.json`,
      verifiedSha256: hash,
      fetchedAt: "2026-07-17T12:00:00.000Z",
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/BerriAI/litellm/git/ref/heads/main",
    );
  });

  it("uses only an explicitly valid deployment pin", async () => {
    expect(
      () => new GitHubLiteLlmCatalogSource({ pinnedCommitSha: "main" }),
    ).toThrow(TrustedAiCatalogSourceError);

    const source = new GitHubLiteLlmCatalogSource({
      pinnedCommitSha: "b".repeat(40),
      fetchImplementation: vi.fn().mockResolvedValue(new Response("{}")),
    });
    await source.load();
    expect(source).toBeDefined();
  });

  it("fails closed for oversized or malformed trusted responses", async () => {
    const source = new GitHubLiteLlmCatalogSource({
      pinnedCommitSha: "c".repeat(40),
      maximumBytes: 1,
      fetchImplementation: vi.fn().mockResolvedValue(new Response("{}")),
    });
    await expect(source.load()).rejects.toBeInstanceOf(
      TrustedAiCatalogSourceError,
    );
  });

  it("rejects a redirect that leaves the fixed trusted HTTPS hosts", async () => {
    const response = new Response("{}") as Response & { url: string };
    Object.defineProperty(response, "url", {
      value: "https://untrusted.example/catalog.json",
    });
    const source = new GitHubLiteLlmCatalogSource({
      pinnedCommitSha: "d".repeat(40),
      fetchImplementation: vi.fn().mockResolvedValue(response),
    });

    await expect(source.load()).rejects.toBeInstanceOf(
      TrustedAiCatalogSourceError,
    );
  });
});
