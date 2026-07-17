import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachmentRuntimeQuotas } from "@caseweaver/attachments";
import { describe, expect, it } from "vitest";

import {
  type AttachmentProcessorRequest,
  type AttachmentProcessorResponse,
  attachmentProcessorLine,
  parseAttachmentProcessorResponse,
} from "./attachment-processor-protocol.js";
import { UnixSocketAttachmentProcessorService } from "./attachment-processor-service.js";

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

async function temporaryService(): Promise<{
  readonly root: string;
  readonly jobs: string;
  readonly socket: string;
  readonly service: UnixSocketAttachmentProcessorService;
  close(): Promise<void>;
}> {
  const root = await mkdtemp(
    join(tmpdir(), "caseweaver-attachment-processor-"),
  );
  const jobs = join(root, "jobs");
  await mkdir(jobs, { mode: 0o700 });
  const service = new UnixSocketAttachmentProcessorService({
    socketPath: join(root, "processor.sock"),
    jobsDirectory: jobs,
    hardCeilings: quotas,
  });
  await service.listen();
  return {
    root,
    jobs,
    socket: join(root, "processor.sock"),
    service,
    async close() {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function processorRequest(
  socketPath: string,
  request: AttachmentProcessorRequest,
): Promise<AttachmentProcessorResponse> {
  return new Promise<AttachmentProcessorResponse>((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let buffer = "";
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const response = parseAttachmentProcessorResponse(
        buffer.slice(0, newline),
      );
      socket.destroy();
      if (response === undefined) {
        reject(new Error("Processor returned an invalid protocol response."));
        return;
      }
      resolve(response);
    });
    socket.once("connect", () =>
      socket.write(attachmentProcessorLine(request)),
    );
  });
}

describe("UnixSocketAttachmentProcessorService", () => {
  unixOnlyIt(
    "uses only a UUID-selected fixed directory and writes normalized text output",
    async () => {
      const runtime = await temporaryService();
      const jobId = randomUUID();
      const directory = join(runtime.jobs, jobId);
      await mkdir(directory, { mode: 0o700 });
      await writeFile(
        join(directory, "input.bin"),
        "line one\r\nline two\r\n",
        {
          mode: 0o600,
        },
      );

      try {
        const response = await processorRequest(runtime.socket, {
          kind: "execute",
          jobId,
          processor: "text",
          quotas,
        });
        expect(response).toMatchObject({
          kind: "result",
          jobId,
          outputByteLength: 18,
        });
        await expect(
          readFile(join(directory, "output.txt"), "utf8"),
        ).resolves.toBe("line one\nline two\n");
      } finally {
        await runtime.close();
      }
    },
  );

  unixOnlyIt(
    "rejects malformed ZIP input with a redacted archive-safe failure and removes its job",
    async () => {
      const runtime = await temporaryService();
      const jobId = randomUUID();
      const directory = join(runtime.jobs, jobId);
      await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, "input.bin"), "not a zip", {
        mode: 0o600,
      });

      try {
        await expect(
          processorRequest(runtime.socket, {
            kind: "execute",
            jobId,
            processor: "zip",
            quotas,
          }),
        ).resolves.toEqual({
          kind: "failure",
          jobId,
          code: "attachment.archiveUnsafe",
        });
        await expect(
          readFile(join(directory, "input.bin")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await runtime.close();
      }
    },
  );
});
