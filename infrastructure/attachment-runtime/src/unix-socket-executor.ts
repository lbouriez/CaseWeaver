import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { isAbsolute, join, relative } from "node:path";

import {
  AttachmentCancelledError,
  AttachmentError,
  type AttachmentRuntimeAttestation,
  type AttachmentRuntimeQuotas,
  type AttachmentRuntimeRequest,
  type BlobStore,
  normalizeText,
} from "@caseweaver/attachments";
import {
  type AttachmentProcessorFailureCode,
  type AttachmentProcessorResponse,
  attachmentProcessorLine,
  attachmentProcessorQuotasWithinCeilings,
  isAttachmentProcessorJobId,
  parseAttachmentProcessorResponse,
  validateAttachmentProcessorQuotas,
} from "./attachment-processor-protocol.js";
import type { IsolatedAttachmentExecutor } from "./index.js";

const inputFilename = "input.bin";
const outputFilename = "output.txt";
const maximumProtocolLineBytes = 16 * 1024;

const attestation: AttachmentRuntimeAttestation = Object.freeze({
  networkDisabled: true,
  credentialsUnavailable: true,
  disposableFilesystem: true,
  quotasEnforced: true,
});

export interface UnixSocketAttachmentExecutorOptions {
  /** Server-private object storage boundary. Opaque handles never cross UDS. */
  readonly blobs: Pick<BlobStore, "open" | "writeText">;
  /** Absolute Unix-domain socket path for the isolated processor sidecar. */
  readonly socketPath: string;
  /** Absolute, sidecar-shared empty job directory, never an arbitrary mount. */
  readonly jobsDirectory: string;
  /** Deployment hard limits. Per-operation values may only lower these values. */
  readonly hardCeilings: AttachmentRuntimeQuotas;
}

function runtimeUnavailable(): AttachmentError {
  return new AttachmentError(
    "attachment.runtimeTimeout",
    "The isolated attachment processor is unavailable.",
    true,
  );
}

function unsafeRuntimePath(): AttachmentError {
  return new AttachmentError(
    "attachment.runtimeAttestation",
    "The isolated attachment processor path is not safe.",
    false,
  );
}

function outputInvalid(): AttachmentError {
  return new AttachmentError(
    "attachment.outputNotNormalized",
    "The isolated attachment processor returned invalid output.",
    false,
  );
}

function assertAbsolutePath(value: string): void {
  if (!isAbsolute(value) || value.includes("\0")) throw unsafeRuntimePath();
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function canonicalDirectory(path: string): Promise<string> {
  assertAbsolutePath(path);
  const details = await lstat(path).catch(() => undefined);
  if (
    details === undefined ||
    !details.isDirectory() ||
    details.isSymbolicLink()
  ) {
    throw unsafeRuntimePath();
  }
  const canonical = await realpath(path).catch(() => {
    throw unsafeRuntimePath();
  });
  if (!isAbsolute(canonical) || canonical.includes("\0")) {
    throw unsafeRuntimePath();
  }
  return canonical;
}

/**
 * Privileged-worker half of the fixed attachment-processor boundary. It only
 * creates a fresh UUID directory below a deployment-owned shared root, streams
 * opaque blob bytes to a fixed filename, and exchanges a path-free request over
 * a Unix socket. It neither starts a container nor accesses a Docker socket.
 */
export class UnixSocketAttachmentExecutor
  implements IsolatedAttachmentExecutor
{
  public readonly attestation = attestation;

  private readonly activeJobDirectories = new Map<string, Set<string>>();
  private readonly jobsDirectory: string;
  private readonly socketPath: string;
  private readonly blobs: Pick<BlobStore, "open" | "writeText">;
  private readonly hardCeilings: AttachmentRuntimeQuotas;
  private canonicalJobsDirectory: Promise<string> | undefined;

  public constructor(options: UnixSocketAttachmentExecutorOptions) {
    assertAbsolutePath(options.socketPath);
    assertAbsolutePath(options.jobsDirectory);
    validateAttachmentProcessorQuotas(options.hardCeilings);
    this.socketPath = options.socketPath;
    this.jobsDirectory = options.jobsDirectory;
    this.blobs = options.blobs;
    this.hardCeilings = Object.freeze({ ...options.hardCeilings });
  }

  public async execute(
    request: AttachmentRuntimeRequest,
  ): Promise<{ readonly outputByteLength: number }> {
    validateAttachmentProcessorQuotas(request.quotas);
    if (
      !attachmentProcessorQuotasWithinCeilings(
        request.quotas,
        this.hardCeilings,
      )
    ) {
      throw new AttachmentError(
        "attachment.runtimeAttestation",
        "Attachment runtime request exceeds deployment safety limits.",
        false,
      );
    }
    if (request.signal.aborted) throw new AttachmentCancelledError();

    const job = await this.createJobDirectory(request.workspaceId);
    try {
      await this.streamInput({
        request,
        inputPath: join(job.directory, inputFilename),
      });
      const response = await this.executeProcessor({
        jobId: job.id,
        processor: request.processor,
        quotas: request.quotas,
        signal: request.signal,
      });
      if (response.kind === "failure") {
        throw this.processorFailure(response.code);
      }
      if (response.jobId !== job.id) throw outputInvalid();
      await this.assertCanonicalJobDirectory(job.directory);
      const text = await this.readCanonicalOutput({
        outputPath: join(job.directory, outputFilename),
        expectedByteLength: response.outputByteLength,
        maximumOutputBytes: request.quotas.maximumOutputBytes,
        signal: request.signal,
      });
      await this.blobs.writeText(
        request.output,
        request.workspaceId,
        text,
        request.signal,
      );
      return Object.freeze({
        outputByteLength: new TextEncoder().encode(text).byteLength,
      });
    } catch (error) {
      if (request.signal.aborted) throw new AttachmentCancelledError();
      if (error instanceof AttachmentError) throw error;
      throw runtimeUnavailable();
    } finally {
      await this.removeTrackedJob(request.workspaceId, job.directory);
    }
  }

  /** All directories in this map were created by this executor instance. */
  public async cleanup(workspaceId: string): Promise<void> {
    const jobs = this.activeJobDirectories.get(workspaceId);
    if (jobs === undefined) return;
    await Promise.all(
      [...jobs].map((directory) =>
        this.removeTrackedJob(workspaceId, directory),
      ),
    );
  }

  private async jobsRoot(): Promise<string> {
    this.canonicalJobsDirectory ??= canonicalDirectory(this.jobsDirectory);
    return this.canonicalJobsDirectory;
  }

  private async createJobDirectory(workspaceId: string): Promise<{
    readonly id: string;
    readonly directory: string;
  }> {
    const root = await this.jobsRoot();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = randomUUID();
      const directory = join(root, id);
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as { readonly code?: unknown }).code === "EEXIST") continue;
        throw runtimeUnavailable();
      }
      const details = await lstat(directory).catch(() => undefined);
      if (
        details === undefined ||
        !details.isDirectory() ||
        details.isSymbolicLink() ||
        !isWithin(root, directory) ||
        !isAttachmentProcessorJobId(id)
      ) {
        await rm(directory, { recursive: true, force: true }).catch(
          () => undefined,
        );
        throw unsafeRuntimePath();
      }
      try {
        await this.assertCanonicalJobDirectory(directory);
      } catch {
        throw unsafeRuntimePath();
      }
      const workspaceJobs =
        this.activeJobDirectories.get(workspaceId) ?? new Set();
      workspaceJobs.add(directory);
      this.activeJobDirectories.set(workspaceId, workspaceJobs);
      return Object.freeze({ id, directory });
    }
    throw runtimeUnavailable();
  }

  private async streamInput(input: {
    readonly request: AttachmentRuntimeRequest;
    readonly inputPath: string;
  }): Promise<void> {
    if (input.request.signal.aborted) throw new AttachmentCancelledError();
    let file: FileHandle | undefined;
    try {
      file = await open(
        input.inputPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      let byteLength = 0;
      const stream = await this.blobs.open(
        input.request.input,
        input.request.workspaceId,
        input.request.signal,
      );
      for await (const chunk of stream) {
        if (input.request.signal.aborted) throw new AttachmentCancelledError();
        byteLength += chunk.byteLength;
        if (byteLength > input.request.quotas.maximumInputBytes) {
          throw new AttachmentError(
            "attachment.contentTooLarge",
            "Attachment runtime input exceeded its byte limit.",
            false,
          );
        }
        await file.write(chunk);
      }
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      if (input.request.signal.aborted) throw new AttachmentCancelledError();
      throw runtimeUnavailable();
    } finally {
      await file?.close().catch(() => undefined);
    }
  }

  private async assertCanonicalJobDirectory(directory: string): Promise<void> {
    const root = await this.jobsRoot();
    const details = await lstat(directory).catch(() => undefined);
    if (
      details === undefined ||
      !details.isDirectory() ||
      details.isSymbolicLink() ||
      !isWithin(root, directory)
    ) {
      throw outputInvalid();
    }
    const canonical = await realpath(directory).catch(() => undefined);
    if (
      canonical === undefined ||
      canonical !== directory ||
      !isWithin(root, canonical)
    ) {
      throw outputInvalid();
    }
  }

  private async executeProcessor(input: {
    readonly jobId: string;
    readonly processor: AttachmentRuntimeRequest["processor"];
    readonly quotas: AttachmentRuntimeQuotas;
    readonly signal: AbortSignal;
  }): Promise<AttachmentProcessorResponse> {
    return new Promise<AttachmentProcessorResponse>((resolve, reject) => {
      let completed = false;
      let buffer = "";
      let socket: Socket | undefined;

      const finish = () => {
        if (completed) return;
        completed = true;
        input.signal.removeEventListener("abort", cancel);
        socket?.destroy();
      };
      const rejectUnavailable = () => {
        if (completed) return;
        finish();
        reject(runtimeUnavailable());
      };
      const cancel = () => {
        if (socket?.writable === true) {
          socket.write(
            attachmentProcessorLine({ kind: "cancel", jobId: input.jobId }),
            () => {
              if (completed) return;
              finish();
              reject(new AttachmentCancelledError());
            },
          );
          return;
        }
        if (completed) return;
        finish();
        reject(new AttachmentCancelledError());
      };

      if (input.signal.aborted) {
        cancel();
        return;
      }
      try {
        socket = createConnection({ path: this.socketPath });
      } catch {
        rejectUnavailable();
        return;
      }
      input.signal.addEventListener("abort", cancel, { once: true });
      socket.once("error", rejectUnavailable);
      socket.on("data", (chunk: Buffer) => {
        if (completed) return;
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer, "utf8") > maximumProtocolLineBytes) {
          rejectUnavailable();
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const response = parseAttachmentProcessorResponse(
          buffer.slice(0, newline),
        );
        if (response === undefined || response.jobId !== input.jobId) {
          rejectUnavailable();
          return;
        }
        finish();
        resolve(response);
      });
      socket.once("connect", () => {
        if (completed) return;
        socket?.write(
          attachmentProcessorLine({
            kind: "execute",
            jobId: input.jobId,
            processor: input.processor,
            quotas: input.quotas,
          }),
        );
      });
      socket.once("close", () => {
        if (!completed) rejectUnavailable();
      });
    });
  }

  private processorFailure(
    code: AttachmentProcessorFailureCode,
  ): AttachmentError {
    switch (code) {
      case "attachment.aborted":
        return new AttachmentCancelledError();
      case "attachment.archiveUnsafe":
      case "attachment.contentTooLarge":
      case "attachment.invalidText":
      case "attachment.outputNotNormalized":
      case "attachment.outputTooLarge":
        return new AttachmentError(
          code,
          "Attachment processor rejected the content.",
          false,
        );
      default:
        return runtimeUnavailable();
    }
  }

  private async readCanonicalOutput(input: {
    readonly outputPath: string;
    readonly expectedByteLength: number;
    readonly maximumOutputBytes: number;
    readonly signal: AbortSignal;
  }): Promise<string> {
    if (input.signal.aborted) throw new AttachmentCancelledError();
    const details = await lstat(input.outputPath).catch(() => undefined);
    if (
      details === undefined ||
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.size > input.maximumOutputBytes ||
      details.size !== input.expectedByteLength
    ) {
      throw outputInvalid();
    }
    let file: FileHandle | undefined;
    try {
      file = await open(
        input.outputPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const opened = await file.stat();
      if (!opened.isFile() || opened.size !== details.size)
        throw outputInvalid();
      const bytes = new Uint8Array(opened.size);
      let position = 0;
      while (position < bytes.byteLength) {
        if (input.signal.aborted) throw new AttachmentCancelledError();
        const { bytesRead } = await file.read(
          bytes,
          position,
          bytes.byteLength - position,
          position,
        );
        if (bytesRead === 0) throw outputInvalid();
        position += bytesRead;
      }
      const normalized = normalizeText(bytes, input.maximumOutputBytes);
      const canonical = new TextEncoder().encode(normalized.text);
      if (normalized.truncated || !equalBytes(bytes, canonical))
        throw outputInvalid();
      return normalized.text;
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      if (input.signal.aborted) throw new AttachmentCancelledError();
      throw outputInvalid();
    } finally {
      await file?.close().catch(() => undefined);
    }
  }

  private async removeTrackedJob(
    workspaceId: string,
    directory: string,
  ): Promise<void> {
    const jobs = this.activeJobDirectories.get(workspaceId);
    if (jobs === undefined || !jobs.delete(directory)) return;
    if (jobs.size === 0) this.activeJobDirectories.delete(workspaceId);
    const root = await this.jobsRoot().catch(() => undefined);
    if (root === undefined || !isWithin(root, directory)) return;
    const basename = directory.slice(root.length + 1);
    if (!isAttachmentProcessorJobId(basename)) return;
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}
