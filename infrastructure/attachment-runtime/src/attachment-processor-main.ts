import type { AttachmentRuntimeQuotas } from "@caseweaver/attachments";

import { UnixSocketAttachmentProcessorService } from "./attachment-processor-service.js";

function requiredAbsolutePath(value: string | undefined): string {
  if (value === undefined || !value.startsWith("/") || value.includes("\0")) {
    throw new Error("Attachment processor configuration is invalid.");
  }
  return value;
}

function positive(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Attachment processor configuration is invalid.");
  }
  return parsed;
}

function nonNegative(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Attachment processor configuration is invalid.");
  }
  return parsed;
}

function loadQuotas(environment: NodeJS.ProcessEnv): AttachmentRuntimeQuotas {
  return Object.freeze({
    timeoutMs: positive(
      environment.WORKER_ATTACHMENT_RUNTIME_TIMEOUT_MS,
      60_000,
    ),
    maximumMemoryBytes: positive(
      environment.WORKER_ATTACHMENT_RUNTIME_MAXIMUM_MEMORY_BYTES,
      512 * 1024 * 1024,
    ),
    maximumInputBytes: positive(
      environment.WORKER_ATTACHMENT_RUNTIME_MAXIMUM_INPUT_BYTES,
      64 * 1024 * 1024,
    ),
    maximumOutputBytes: positive(
      environment.WORKER_ATTACHMENT_RUNTIME_MAXIMUM_OUTPUT_BYTES,
      8 * 1024 * 1024,
    ),
    maximumFiles: positive(
      environment.WORKER_ATTACHMENT_RUNTIME_MAXIMUM_FILES,
      1_000,
    ),
    maximumExpandedBytes: positive(
      environment.WORKER_ATTACHMENT_RUNTIME_MAXIMUM_EXPANDED_BYTES,
      256 * 1024 * 1024,
    ),
    maximumExtractedFileBytes: positive(
      environment.WORKER_ATTACHMENT_RUNTIME_MAXIMUM_EXTRACTED_FILE_BYTES,
      32 * 1024 * 1024,
    ),
    maximumArchiveDepth: nonNegative(
      environment.WORKER_ATTACHMENT_RUNTIME_MAXIMUM_ARCHIVE_DEPTH,
      16,
    ),
    maximumCompressionRatio: positive(
      environment.WORKER_ATTACHMENT_RUNTIME_MAXIMUM_COMPRESSION_RATIO,
      100,
    ),
  });
}

async function main(): Promise<void> {
  const service = new UnixSocketAttachmentProcessorService({
    socketPath: requiredAbsolutePath(
      process.env.WORKER_ATTACHMENT_RUNTIME_SOCKET_PATH,
    ),
    jobsDirectory: requiredAbsolutePath(
      process.env.WORKER_ATTACHMENT_RUNTIME_JOBS_DIRECTORY,
    ),
    hardCeilings: loadQuotas(process.env),
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void service.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await service.listen();
}

void main().catch(() => {
  // Never print environment/configuration values: this process has no
  // diagnostic surface beyond its failure exit code.
  process.exitCode = 1;
});
