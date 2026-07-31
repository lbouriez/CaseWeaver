import { createHash } from "node:crypto";

import type { TrustedAiCatalogSource } from "@caseweaver/administration";
import type { LiteLlmImportInput } from "@caseweaver/ai-config";

const defaultRepository = "BerriAI/litellm";
const defaultCatalogPath = "model_prices_and_context_window.json";
const defaultTimeoutMs = 20_000;
const defaultMaximumBytes = 20 * 1024 * 1024;
const commitSha = /^[a-f0-9]{40}$/iu;
const trustedHosts = new Set(["api.github.com", "raw.githubusercontent.com"]);

export class TrustedAiCatalogSourceError extends Error {
  public constructor() {
    super("The trusted AI catalog could not be refreshed.");
    this.name = "TrustedAiCatalogSourceError";
  }
}

type FetchImplementation = (
  input: string,
  init?: Readonly<{ readonly signal?: AbortSignal }>,
) => Promise<Response>;

/**
 * Resolves the LiteLLM main commit before fetching its catalog. The two URLs
 * are constants built from a trusted repository/path; no caller can replace
 * the host, resource, or revision with a browser-provided value.
 */
export class GitHubLiteLlmCatalogSource implements TrustedAiCatalogSource {
  private readonly fetchImplementation: FetchImplementation;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly maximumBytes: number;
  private readonly pinnedCommitSha?: string;

  public constructor(
    input: Readonly<{
      readonly pinnedCommitSha?: string;
      readonly fetchImplementation?: FetchImplementation;
      readonly now?: () => Date;
      readonly timeoutMs?: number;
      readonly maximumBytes?: number;
    }> = {},
  ) {
    if (
      input.pinnedCommitSha !== undefined &&
      !commitSha.test(input.pinnedCommitSha)
    ) {
      throw new TrustedAiCatalogSourceError();
    }
    const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
    const maximumBytes = input.maximumBytes ?? defaultMaximumBytes;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 60_000
    ) {
      throw new TrustedAiCatalogSourceError();
    }
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > 50 * 1024 * 1024
    ) {
      throw new TrustedAiCatalogSourceError();
    }
    this.pinnedCommitSha = input.pinnedCommitSha?.toLowerCase();
    this.fetchImplementation = input.fetchImplementation ?? fetch;
    this.now = input.now ?? (() => new Date());
    this.timeoutMs = timeoutMs;
    this.maximumBytes = maximumBytes;
  }

  public async load(signal?: AbortSignal): Promise<LiteLlmImportInput> {
    const revision =
      this.pinnedCommitSha ?? (await this.resolveRevision(signal));
    const upstreamUrl = `https://raw.githubusercontent.com/${defaultRepository}/${revision}/${defaultCatalogPath}`;
    const response = await this.request(upstreamUrl, signal);
    const bytes = await readBoundedBody(response, this.maximumBytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return Object.freeze({
      snapshotId: `litellm-${sha256}`,
      rawBytes: bytes,
      upstreamUrl,
      upstreamCommitSha: revision,
      fetchedAt: this.now().toISOString(),
      verifiedSha256: sha256,
    });
  }

  private async resolveRevision(signal?: AbortSignal): Promise<string> {
    const response = await this.request(
      // The commit-detail endpoint includes a potentially unbounded file list.
      // A Git reference is the small authoritative mapping from the trusted
      // branch name to its immutable object SHA.
      `https://api.github.com/repos/${defaultRepository}/git/ref/heads/main`,
      signal,
    );
    let document: unknown;
    try {
      document = JSON.parse(
        new TextDecoder().decode(await readBoundedBody(response, 64 * 1024)),
      );
    } catch {
      throw new TrustedAiCatalogSourceError();
    }
    const record =
      document !== null && typeof document === "object"
        ? (document as Readonly<Record<string, unknown>>)
        : undefined;
    const reference =
      record?.object !== null && typeof record?.object === "object"
        ? (record.object as Readonly<Record<string, unknown>>)
        : undefined;
    const candidate = reference?.sha;
    const sha = typeof candidate === "string" ? candidate : undefined;
    if (sha === undefined || !commitSha.test(sha)) {
      throw new TrustedAiCatalogSourceError();
    }
    return sha.toLowerCase();
  }

  private async request(url: string, signal?: AbortSignal): Promise<Response> {
    if (!isTrustedUrl(url)) throw new TrustedAiCatalogSourceError();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    try {
      const response = await this.fetchImplementation(url, {
        signal: controller.signal,
      });
      if (!response.ok) throw new TrustedAiCatalogSourceError();
      // Native fetch follows redirects. Verify the resulting URL as well so a
      // trusted source can never silently redirect catalog acquisition to a
      // browser-selected or arbitrary host.
      if (response.url.length > 0 && !isTrustedUrl(response.url)) {
        throw new TrustedAiCatalogSourceError();
      }
      const length = response.headers.get("content-length");
      if (
        length !== null &&
        (!/^\d+$/u.test(length) || Number(length) > this.maximumBytes)
      ) {
        throw new TrustedAiCatalogSourceError();
      }
      return response;
    } catch (error) {
      if (error instanceof TrustedAiCatalogSourceError) throw error;
      throw new TrustedAiCatalogSourceError();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

function isTrustedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && trustedHosts.has(url.hostname);
  } catch {
    return false;
  }
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (response.body === null) throw new TrustedAiCatalogSourceError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > maximumBytes) throw new TrustedAiCatalogSourceError();
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof TrustedAiCatalogSourceError) throw error;
    throw new TrustedAiCatalogSourceError();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
