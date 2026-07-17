import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AttachmentRuntimeQuotas,
  BlobStore,
} from "@caseweaver/attachments";
import { describe, expect, it } from "vitest";

import {
  attachmentProcessorLine,
  parseAttachmentProcessorRequest,
} from "./attachment-processor-protocol.js";
import { UnixSocketAttachmentExecutor } from "./unix-socket-executor.js";

const unixOnlyIt = process.platform === "win32" ? it.skip : it;

const quotas: AttachmentRuntimeQuotas = {
  timeoutMs: 1_000,
  maximumMemoryBytes: 1_024 * 1_024,
  maximumInputBytes: 1_024,
  maximumOutputBytes: 1_024,
  maximumFiles: 5,
  maximumExpandedBytes: 1_024,
  maximumExtractedFileBytes: 512,
  maximumArchiveDepth: 3,
  maximumCompressionRatio: 10,
};

class MemoryBlobs implements Pick<BlobStore, "open" | "writeText"> {
  public output: string | undefined;

  public constructor(private readonly input: Uint8Array) {}

  public async open(): Promise<AsyncIterable<Uint8Array>> {
    const input = this.input;
    return (async function* () {
      yield input;
    })();
  }

  public async writeText(
    _handle: Parameters<BlobStore["writeText"]>[0],
    _workspaceId: string,
    text: string,
  ): Promise<void> {
    this.output = text;
  }
}

async function temporaryRuntime(): Promise<{
  readonly root: string;
  readonly jobs: string;
  readonly socket: string;
  close(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "caseweaver-attachment-runtime-"));
  const jobs = join(root, "jobs");
  await mkdir(jobs, { mode: 0o700 });
  return {
    root,
    jobs,
    socket: join(root, "processor.sock"),
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function request(signal = new AbortController().signal) {
  return {
    workspaceId: "workspace-1",
    processor: "text" as const,
    input: {
      workspaceId: "workspace-1",
      storageBackendId: "local",
      key: "input",
    },
    output: {
      workspaceId: "workspace-1",
      storageBackendId: "local",
      key: "output",
    },
    quotas,
    signal,
  };
}

async function closeServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("UnixSocketAttachmentExecutor", () => {
  unixOnlyIt(
    "streams opaque input to a fresh job and accepts only canonical bounded output",
    async () => {
      const runtime = await temporaryRuntime();
      const observed: unknown[] = [];
      const server = createServer((connection) => {
        let buffer = "";
        connection.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const parsed = parseAttachmentProcessorRequest(
            buffer.slice(0, newline),
          );
          if (parsed?.kind !== "execute") return;
          observed.push(JSON.parse(buffer.slice(0, newline)) as unknown);
          void (async () => {
            const input = await readFile(
              join(runtime.jobs, parsed.jobId, "input.bin"),
            );
            expect(input.toString("utf8")).toBe("operator supplied attachment");
            await writeFile(
              join(runtime.jobs, parsed.jobId, "output.txt"),
              "safe\n",
              {
                mode: 0o600,
              },
            );
            connection.write(
              attachmentProcessorLine({
                kind: "result",
                jobId: parsed.jobId,
                outputByteLength: 5,
              }),
            );
          })();
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(runtime.socket, resolve),
      );

      try {
        const blobs = new MemoryBlobs(
          new TextEncoder().encode("operator supplied attachment"),
        );
        const executor = new UnixSocketAttachmentExecutor({
          blobs,
          socketPath: runtime.socket,
          jobsDirectory: runtime.jobs,
          hardCeilings: quotas,
        });

        await expect(executor.execute(request())).resolves.toEqual({
          outputByteLength: 5,
        });
        expect(blobs.output).toBe("safe\n");
        expect(observed).toHaveLength(1);
        expect(observed[0]).toMatchObject({
          kind: "execute",
          processor: "text",
          quotas,
        });
        expect(JSON.stringify(observed[0])).not.toContain("workspace-1");
        expect(JSON.stringify(observed[0])).not.toContain("input.bin");
        expect(await readdir(runtime.jobs)).toEqual([]);
      } finally {
        await closeServer(server);
        await runtime.close();
      }
    },
  );

  unixOnlyIt(
    "rejects noncanonical processor output without storing it",
    async () => {
      const runtime = await temporaryRuntime();
      const server = createServer((connection) => {
        let buffer = "";
        connection.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const parsed = parseAttachmentProcessorRequest(
            buffer.slice(0, newline),
          );
          if (parsed?.kind !== "execute") return;
          void (async () => {
            await writeFile(
              join(runtime.jobs, parsed.jobId, "output.txt"),
              "not canonical\r\n",
            );
            connection.write(
              attachmentProcessorLine({
                kind: "result",
                jobId: parsed.jobId,
                outputByteLength: 15,
              }),
            );
          })();
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(runtime.socket, resolve),
      );

      try {
        const blobs = new MemoryBlobs(new TextEncoder().encode("input"));
        const executor = new UnixSocketAttachmentExecutor({
          blobs,
          socketPath: runtime.socket,
          jobsDirectory: runtime.jobs,
          hardCeilings: quotas,
        });

        await expect(executor.execute(request())).rejects.toMatchObject({
          code: "attachment.outputNotNormalized",
        });
        expect(blobs.output).toBeUndefined();
        expect(await readdir(runtime.jobs)).toEqual([]);
      } finally {
        await closeServer(server);
        await runtime.close();
      }
    },
  );

  unixOnlyIt(
    "accepts an empty canonical result but rejects output beyond its exact byte limit",
    async () => {
      const runtime = await temporaryRuntime();
      let requestCount = 0;
      const server = createServer((connection) => {
        let buffer = "";
        connection.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const parsed = parseAttachmentProcessorRequest(
            buffer.slice(0, newline),
          );
          if (parsed?.kind !== "execute") return;
          requestCount += 1;
          void (async () => {
            const output =
              requestCount === 1
                ? ""
                : "x".repeat(quotas.maximumOutputBytes + 1);
            await writeFile(
              join(runtime.jobs, parsed.jobId, "output.txt"),
              output,
              { mode: 0o600 },
            );
            connection.write(
              attachmentProcessorLine({
                kind: "result",
                jobId: parsed.jobId,
                outputByteLength: output.length,
              }),
            );
          })();
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(runtime.socket, resolve),
      );

      try {
        const emptyBlobs = new MemoryBlobs(new TextEncoder().encode("input"));
        const executor = new UnixSocketAttachmentExecutor({
          blobs: emptyBlobs,
          socketPath: runtime.socket,
          jobsDirectory: runtime.jobs,
          hardCeilings: quotas,
        });
        await expect(executor.execute(request())).resolves.toEqual({
          outputByteLength: 0,
        });
        expect(emptyBlobs.output).toBe("");

        const tooLargeBlobs = new MemoryBlobs(
          new TextEncoder().encode("input"),
        );
        const tooLargeExecutor = new UnixSocketAttachmentExecutor({
          blobs: tooLargeBlobs,
          socketPath: runtime.socket,
          jobsDirectory: runtime.jobs,
          hardCeilings: quotas,
        });
        await expect(tooLargeExecutor.execute(request())).rejects.toMatchObject(
          {
            code: "attachment.outputNotNormalized",
          },
        );
        expect(tooLargeBlobs.output).toBeUndefined();
        expect(await readdir(runtime.jobs)).toEqual([]);
      } finally {
        await closeServer(server);
        await runtime.close();
      }
    },
  );

  unixOnlyIt(
    "sends a cancellation request and cleans only its generated job directory",
    async () => {
      const runtime = await temporaryRuntime();
      let cancelled = false;
      let receivedExecute = false;
      let resolveCancelled: (() => void) | undefined;
      const cancelledRequest = new Promise<void>((resolve) => {
        resolveCancelled = resolve;
      });
      const server = createServer((connection) => {
        let buffer = "";
        connection.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const parsed = parseAttachmentProcessorRequest(
              buffer.slice(0, newline),
            );
            buffer = buffer.slice(newline + 1);
            if (parsed?.kind === "execute") receivedExecute = true;
            if (parsed?.kind === "cancel") {
              cancelled = true;
              resolveCancelled?.();
            }
            newline = buffer.indexOf("\n");
          }
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(runtime.socket, resolve),
      );

      try {
        const controller = new AbortController();
        const executor = new UnixSocketAttachmentExecutor({
          blobs: new MemoryBlobs(new TextEncoder().encode("input")),
          socketPath: runtime.socket,
          jobsDirectory: runtime.jobs,
          hardCeilings: quotas,
        });
        const pending = executor.execute(request(controller.signal));
        while (!receivedExecute) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        controller.abort();

        await expect(pending).rejects.toMatchObject({
          code: "attachment.aborted",
        });
        await cancelledRequest;
        expect(cancelled).toBe(true);
        expect(await readdir(runtime.jobs)).toEqual([]);
      } finally {
        await closeServer(server);
        await runtime.close();
      }
    },
  );
});
