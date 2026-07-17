import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { isAbsolute, join, relative } from "node:path";
import { inflateRawSync } from "node:zlib";

import {
  AttachmentCancelledError,
  AttachmentError,
  type AttachmentRuntimeQuotas,
  inspectZipArchive,
  normalizeText,
} from "@caseweaver/attachments";

import {
  type AttachmentProcessorExecuteRequest,
  type AttachmentProcessorFailureCode,
  type AttachmentProcessorRequest,
  attachmentProcessorLine,
  attachmentProcessorQuotasWithinCeilings,
  isAttachmentProcessorJobId,
  parseAttachmentProcessorRequest,
  validateAttachmentProcessorQuotas,
} from "./attachment-processor-protocol.js";

const inputFilename = "input.bin";
const outputFilename = "output.txt";
const maximumProtocolLineBytes = 16 * 1024;
const localFileHeaderSignature = 0x04034b50;
const centralDirectorySignature = 0x02014b50;
const endOfCentralDirectorySignature = 0x06054b50;

export interface UnixSocketAttachmentProcessorServiceOptions {
  /** Absolute sidecar-local UDS path. No TCP listener is ever opened. */
  readonly socketPath: string;
  /** Absolute directory shared only with the worker's attachment-runtime volume. */
  readonly jobsDirectory: string;
  /** Immutable deployment maxima; requests may only lower them. */
  readonly hardCeilings: AttachmentRuntimeQuotas;
}

interface ActiveJob {
  readonly controller: AbortController;
  readonly directory: string;
}

interface ZipEntryData {
  readonly path: string;
  readonly flags: number;
  readonly compression: number;
  readonly compressedBytes: number;
  readonly expandedBytes: number;
  readonly localHeaderOffset: number;
}

function runtimeFailure(): AttachmentError {
  return new AttachmentError(
    "attachment.runtimeTimeout",
    "Attachment processor could not safely process the requested job.",
    true,
  );
}

function archiveUnsafe(): AttachmentError {
  return new AttachmentError(
    "attachment.archiveUnsafe",
    "Attachment archive is not safe to process.",
    false,
  );
}

function outputTooLarge(): AttachmentError {
  return new AttachmentError(
    "attachment.outputTooLarge",
    "Attachment processor output exceeds its byte limit.",
    false,
  );
}

function assertAbsolutePath(value: string): void {
  if (!isAbsolute(value) || value.includes("\0")) throw runtimeFailure();
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
  }
  return false;
}

function littleEndian16(bytes: Uint8Array, offset: number): number {
  const first = bytes[offset];
  const second = bytes[offset + 1];
  if (first === undefined || second === undefined) throw archiveUnsafe();
  return first | (second << 8);
}

function littleEndian32(bytes: Uint8Array, offset: number): number {
  const first = bytes[offset];
  const second = bytes[offset + 1];
  const third = bytes[offset + 2];
  const fourth = bytes[offset + 3];
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined
  ) {
    throw archiveUnsafe();
  }
  return (first | (second << 8) | (third << 16) | (fourth << 24)) >>> 0;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const first = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= first; offset -= 1) {
    if (littleEndian32(bytes, offset) === endOfCentralDirectorySignature) {
      return offset;
    }
  }
  throw archiveUnsafe();
}

function zipEntries(bytes: Uint8Array): readonly ZipEntryData[] {
  const end = findEndOfCentralDirectory(bytes);
  const disk = littleEndian16(bytes, end + 4);
  const centralDisk = littleEndian16(bytes, end + 6);
  const entriesOnDisk = littleEndian16(bytes, end + 8);
  const entryCount = littleEndian16(bytes, end + 10);
  const centralBytes = littleEndian32(bytes, end + 12);
  const centralOffset = littleEndian32(bytes, end + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralBytes === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw archiveUnsafe();
  }
  const centralEnd = centralOffset + centralBytes;
  if (centralEnd > end || centralEnd < centralOffset) throw archiveUnsafe();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ZipEntryData[] = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (littleEndian32(bytes, offset) !== centralDirectorySignature) {
      throw archiveUnsafe();
    }
    const flags = littleEndian16(bytes, offset + 8);
    const compression = littleEndian16(bytes, offset + 10);
    const compressedBytes = littleEndian32(bytes, offset + 20);
    const expandedBytes = littleEndian32(bytes, offset + 24);
    const filenameBytes = littleEndian16(bytes, offset + 28);
    const extraBytes = littleEndian16(bytes, offset + 30);
    const commentBytes = littleEndian16(bytes, offset + 32);
    const localHeaderOffset = littleEndian32(bytes, offset + 42);
    const recordBytes = 46 + filenameBytes + extraBytes + commentBytes;
    if (offset + recordBytes > centralEnd) throw archiveUnsafe();
    let path: string;
    try {
      path = decoder.decode(
        bytes.subarray(offset + 46, offset + 46 + filenameBytes),
      );
    } catch {
      throw archiveUnsafe();
    }
    entries.push({
      path,
      flags,
      compression,
      compressedBytes,
      expandedBytes,
      localHeaderOffset,
    });
    offset += recordBytes;
  }
  if (offset !== centralEnd) throw archiveUnsafe();
  return Object.freeze(entries);
}

function extractedZipFile(
  archive: Uint8Array,
  entry: ZipEntryData,
): Uint8Array {
  const offset = entry.localHeaderOffset;
  if (littleEndian32(archive, offset) !== localFileHeaderSignature) {
    throw archiveUnsafe();
  }
  const flags = littleEndian16(archive, offset + 6);
  const compression = littleEndian16(archive, offset + 8);
  const filenameBytes = littleEndian16(archive, offset + 26);
  const extraBytes = littleEndian16(archive, offset + 28);
  if (flags !== entry.flags || compression !== entry.compression)
    throw archiveUnsafe();
  const bodyStart = offset + 30 + filenameBytes + extraBytes;
  const bodyEnd = bodyStart + entry.compressedBytes;
  if (
    bodyStart < offset ||
    bodyEnd > archive.byteLength ||
    bodyEnd < bodyStart
  ) {
    throw archiveUnsafe();
  }
  const compressed = archive.subarray(bodyStart, bodyEnd);
  let extracted: Uint8Array;
  try {
    if (entry.compression === 0) {
      extracted = compressed.slice();
    } else if (entry.compression === 8) {
      extracted = new Uint8Array(
        inflateRawSync(compressed, {
          maxOutputLength: entry.expandedBytes + 1,
        }),
      );
    } else {
      throw archiveUnsafe();
    }
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    throw archiveUnsafe();
  }
  if (extracted.byteLength !== entry.expandedBytes) throw archiveUnsafe();
  return extracted;
}

function safeFailureCode(error: unknown): AttachmentProcessorFailureCode {
  if (error instanceof AttachmentCancelledError) return "attachment.aborted";
  if (!(error instanceof AttachmentError)) return "attachment.runtimeTimeout";
  switch (error.code) {
    case "attachment.archiveUnsafe":
    case "attachment.contentTooLarge":
    case "attachment.invalidText":
    case "attachment.outputNotNormalized":
    case "attachment.outputTooLarge":
    case "attachment.runtimeTimeout":
      return error.code;
    default:
      return "attachment.runtimeTimeout";
  }
}

/**
 * The unprivileged sidecar half of the attachment runtime. It accepts no path,
 * handle, workspace, credential, or content over the socket: a UUID selects a
 * fixed directory beneath the configured shared root. The service is intended
 * to run in a networkless, credential-free container with resource limits.
 */
export class UnixSocketAttachmentProcessorService {
  private readonly activeJobs = new Map<string, ActiveJob>();
  private readonly socketPath: string;
  private readonly jobsDirectory: string;
  private readonly hardCeilings: AttachmentRuntimeQuotas;
  private canonicalJobsDirectory: Promise<string> | undefined;
  private server: Server | undefined;
  private ownsSocket = false;

  public constructor(options: UnixSocketAttachmentProcessorServiceOptions) {
    assertAbsolutePath(options.socketPath);
    assertAbsolutePath(options.jobsDirectory);
    validateAttachmentProcessorQuotas(options.hardCeilings);
    this.socketPath = options.socketPath;
    this.jobsDirectory = options.jobsDirectory;
    this.hardCeilings = Object.freeze({ ...options.hardCeilings });
  }

  public async listen(): Promise<void> {
    if (this.server !== undefined) return;
    await this.jobsRoot();
    const existing = await lstat(this.socketPath).catch(() => undefined);
    if (existing !== undefined) {
      if (!existing.isSocket()) throw runtimeFailure();
      await unlink(this.socketPath).catch(() => {
        throw runtimeFailure();
      });
    }
    const server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    }).catch(() => {
      throw runtimeFailure();
    });
    this.server = server;
    this.ownsSocket = true;
  }

  public async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await Promise.all(
      [...this.activeJobs.entries()].map(async ([jobId, job]) => {
        job.controller.abort();
        await this.removeJobDirectory(jobId, job.directory);
      }),
    );
    this.activeJobs.clear();
    if (this.ownsSocket) {
      await unlink(this.socketPath).catch(() => undefined);
      this.ownsSocket = false;
    }
  }

  private async jobsRoot(): Promise<string> {
    this.canonicalJobsDirectory ??= (async () => {
      await mkdir(this.jobsDirectory, { recursive: true, mode: 0o700 }).catch(
        () => {
          throw runtimeFailure();
        },
      );
      const details = await lstat(this.jobsDirectory).catch(() => undefined);
      if (
        details === undefined ||
        !details.isDirectory() ||
        details.isSymbolicLink()
      ) {
        throw runtimeFailure();
      }
      const canonical = await realpath(this.jobsDirectory).catch(() => {
        throw runtimeFailure();
      });
      if (!isAbsolute(canonical) || canonical.includes("\0"))
        throw runtimeFailure();
      return canonical;
    })();
    return this.canonicalJobsDirectory;
  }

  private handleConnection(socket: Socket): void {
    let buffer = "";
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > maximumProtocolLineBytes) {
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const request = parseAttachmentProcessorRequest(line);
        if (request !== undefined) this.handleRequest(socket, request);
        newline = buffer.indexOf("\n");
      }
    });
  }

  private handleRequest(
    socket: Socket,
    request: AttachmentProcessorRequest,
  ): void {
    if (request.kind === "cancel") {
      void this.cancel(request.jobId);
      return;
    }
    if (this.activeJobs.has(request.jobId)) {
      socket.write(
        attachmentProcessorLine({
          kind: "failure",
          jobId: request.jobId,
          code: "attachment.runtimeTimeout",
        }),
      );
      return;
    }
    const controller = new AbortController();
    this.activeJobs.set(request.jobId, { controller, directory: "" });
    void this.execute(request, controller).then(
      (outputByteLength) => {
        if (!socket.destroyed) {
          socket.write(
            attachmentProcessorLine({
              kind: "result",
              jobId: request.jobId,
              outputByteLength,
            }),
          );
        }
      },
      (error: unknown) => {
        if (!socket.destroyed) {
          socket.write(
            attachmentProcessorLine({
              kind: "failure",
              jobId: request.jobId,
              code: safeFailureCode(error),
            }),
          );
        }
      },
    );
  }

  private async execute(
    request: AttachmentProcessorExecuteRequest,
    controller: AbortController,
  ): Promise<number> {
    validateAttachmentProcessorQuotas(request.quotas);
    if (
      !attachmentProcessorQuotasWithinCeilings(
        request.quotas,
        this.hardCeilings,
      )
    ) {
      throw runtimeFailure();
    }
    let directory: string | undefined;
    try {
      directory = await this.jobDirectory(request.jobId);
      this.activeJobs.set(request.jobId, { controller, directory });
      if (controller.signal.aborted) throw new AttachmentCancelledError();
      const input = await this.readRegularFile({
        path: join(directory, inputFilename),
        maximumBytes: request.quotas.maximumInputBytes,
        signal: controller.signal,
      });
      const text =
        request.processor === "text"
          ? normalizedText(input, request.quotas.maximumOutputBytes)
          : normalizedZip(input, request.quotas, controller.signal);
      if (controller.signal.aborted) throw new AttachmentCancelledError();
      return this.writeCanonicalOutput({
        path: join(directory, outputFilename),
        text,
        maximumBytes: request.quotas.maximumOutputBytes,
        signal: controller.signal,
      });
    } catch (error) {
      if (directory !== undefined) {
        await this.removeJobDirectory(request.jobId, directory);
      }
      throw error;
    } finally {
      this.activeJobs.delete(request.jobId);
    }
  }

  private async cancel(jobId: string): Promise<void> {
    const active = this.activeJobs.get(jobId);
    if (active === undefined) return;
    active.controller.abort();
    await this.removeJobDirectory(jobId, active.directory);
  }

  private async jobDirectory(jobId: string): Promise<string> {
    if (!isAttachmentProcessorJobId(jobId)) throw runtimeFailure();
    const root = await this.jobsRoot();
    const directory = join(root, jobId);
    if (!within(root, directory)) throw runtimeFailure();
    const details = await lstat(directory).catch(() => undefined);
    if (
      details === undefined ||
      !details.isDirectory() ||
      details.isSymbolicLink()
    ) {
      throw runtimeFailure();
    }
    const canonical = await realpath(directory).catch(() => {
      throw runtimeFailure();
    });
    if (!within(root, canonical) || canonical !== directory)
      throw runtimeFailure();
    return canonical;
  }

  private async readRegularFile(input: {
    readonly path: string;
    readonly maximumBytes: number;
    readonly signal: AbortSignal;
  }): Promise<Uint8Array> {
    if (input.signal.aborted) throw new AttachmentCancelledError();
    const details = await lstat(input.path).catch(() => undefined);
    if (
      details === undefined ||
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.size > input.maximumBytes
    ) {
      throw new AttachmentError(
        "attachment.contentTooLarge",
        "Attachment processor input is not a bounded regular file.",
        false,
      );
    }
    let file: FileHandle | undefined;
    try {
      file = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await file.stat();
      if (!opened.isFile() || opened.size !== details.size)
        throw runtimeFailure();
      const content = new Uint8Array(opened.size);
      let position = 0;
      while (position < content.byteLength) {
        if (input.signal.aborted) throw new AttachmentCancelledError();
        const { bytesRead } = await file.read(
          content,
          position,
          content.byteLength - position,
          position,
        );
        if (bytesRead === 0) throw runtimeFailure();
        position += bytesRead;
      }
      return content;
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      if (input.signal.aborted) throw new AttachmentCancelledError();
      throw runtimeFailure();
    } finally {
      await file?.close().catch(() => undefined);
    }
  }

  private async writeCanonicalOutput(input: {
    readonly path: string;
    readonly text: string;
    readonly maximumBytes: number;
    readonly signal: AbortSignal;
  }): Promise<number> {
    if (input.signal.aborted) throw new AttachmentCancelledError();
    const bytes = new TextEncoder().encode(input.text);
    if (bytes.byteLength > input.maximumBytes) throw outputTooLarge();
    let file: FileHandle | undefined;
    try {
      file = await open(
        input.path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await file.write(bytes);
      return bytes.byteLength;
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      if (input.signal.aborted) throw new AttachmentCancelledError();
      throw runtimeFailure();
    } finally {
      await file?.close().catch(() => undefined);
    }
  }

  private async removeJobDirectory(
    jobId: string,
    directory: string,
  ): Promise<void> {
    const root = await this.jobsRoot().catch(() => undefined);
    if (root === undefined || !isAttachmentProcessorJobId(jobId)) return;
    if (!within(root, directory) || directory !== join(root, jobId)) return;
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

function normalizedText(content: Uint8Array, maximumBytes: number): string {
  return normalizeText(content, maximumBytes).text;
}

function normalizedZip(
  archive: Uint8Array,
  quotas: AttachmentRuntimeQuotas,
  signal: AbortSignal,
): string {
  const inspectedEntries = inspectZipArchive(archive, {
    maximumFiles: quotas.maximumFiles,
    maximumExpandedBytes: quotas.maximumExpandedBytes,
    maximumExtractedFileBytes: quotas.maximumExtractedFileBytes,
    maximumDepth: quotas.maximumArchiveDepth,
    maximumCompressionRatio: quotas.maximumCompressionRatio,
  });
  const entries = zipEntries(archive);
  if (entries.length !== inspectedEntries.length) throw archiveUnsafe();
  const encoder = new TextEncoder();
  let output = "";
  for (const [index, entry] of entries.entries()) {
    if (signal.aborted) throw new AttachmentCancelledError();
    const inspected = inspectedEntries[index];
    if (
      inspected === undefined ||
      inspected.path !== entry.path ||
      hasControlCharacter(entry.path)
    ) {
      throw archiveUnsafe();
    }
    if (inspected.kind === "directory") continue;
    if (inspected.kind !== "file") throw archiveUnsafe();
    const extracted = extractedZipFile(archive, entry);
    let text: string;
    try {
      text = normalizeText(extracted, quotas.maximumOutputBytes).text;
    } catch (error) {
      if (
        error instanceof AttachmentError &&
        error.code === "attachment.invalidText"
      ) {
        continue;
      }
      throw error;
    }
    const section = `--- ${entry.path}\n${text}\n`;
    if (
      encoder.encode(output).byteLength + encoder.encode(section).byteLength >
      quotas.maximumOutputBytes
    ) {
      const remaining =
        quotas.maximumOutputBytes - encoder.encode(output).byteLength;
      if (remaining === 0) break;
      const partial = normalizeText(encoder.encode(section), remaining).text;
      output += partial;
      break;
    }
    output += section;
  }
  return output;
}
