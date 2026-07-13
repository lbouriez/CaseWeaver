import { AttachmentError } from "./errors.js";

export interface ArchiveEntry {
  readonly path: string;
  readonly compressedBytes: number;
  readonly expandedBytes: number;
  readonly kind: "file" | "directory" | "symlink" | "device";
  readonly encrypted: boolean;
  readonly depth: number;
}

export interface ArchiveLimits {
  readonly maximumFiles: number;
  readonly maximumExpandedBytes: number;
  readonly maximumExtractedFileBytes: number;
  readonly maximumDepth: number;
  readonly maximumCompressionRatio: number;
}

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

function archiveError(message: string): AttachmentError {
  return new AttachmentError("attachment.archiveUnsafe", message, false);
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
    throw archiveError("Archive metadata is truncated.");
  }
  return (first | (second << 8) | (third << 16) | (fourth << 24)) >>> 0;
}

function littleEndian16(bytes: Uint8Array, offset: number): number {
  const first = bytes[offset];
  const second = bytes[offset + 1];
  if (first === undefined || second === undefined) {
    throw archiveError("Archive metadata is truncated.");
  }
  return first | (second << 8);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const first = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= first; offset -= 1) {
    if (littleEndian32(bytes, offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw archiveError("Archive has no central directory.");
}

function archiveEntryKind(
  path: string,
  externalAttributes: number,
): ArchiveEntry["kind"] {
  const unixType = (externalAttributes >>> 16) & 0o170000;
  if (unixType === 0o120000) return "symlink";
  if (unixType === 0o020000 || unixType === 0o060000) return "device";
  if (path.endsWith("/") || (externalAttributes & 0x10) !== 0)
    return "directory";
  return "file";
}

/**
 * Reads only ZIP central-directory metadata. Invoke this from the isolated runtime
 * before extracting any entry; ZIP64 and multi-volume archives are rejected by design.
 */
export function inspectZipArchive(
  content: Uint8Array,
  limits: ArchiveLimits,
): readonly ArchiveEntry[] {
  const end = findEndOfCentralDirectory(content);
  const disk = littleEndian16(content, end + 4);
  const centralDirectoryDisk = littleEndian16(content, end + 6);
  const entriesOnDisk = littleEndian16(content, end + 8);
  const entryCount = littleEndian16(content, end + 10);
  const centralDirectoryBytes = littleEndian32(content, end + 12);
  const centralDirectoryOffset = littleEndian32(content, end + 16);
  if (
    disk !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralDirectoryBytes === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw archiveError("Archive uses unsupported ZIP extensions.");
  }
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectoryBytes;
  if (
    centralDirectoryOffset < 0 ||
    centralDirectoryEnd > end ||
    centralDirectoryEnd < centralDirectoryOffset
  ) {
    throw archiveError("Archive central-directory bounds are invalid.");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ArchiveEntry[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (littleEndian32(content, offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw archiveError("Archive central directory is malformed.");
    }
    const flags = littleEndian16(content, offset + 8);
    const compressedBytes = littleEndian32(content, offset + 20);
    const expandedBytes = littleEndian32(content, offset + 24);
    const filenameBytes = littleEndian16(content, offset + 28);
    const extraBytes = littleEndian16(content, offset + 30);
    const commentBytes = littleEndian16(content, offset + 32);
    const externalAttributes = littleEndian32(content, offset + 38);
    const headerBytes = 46 + filenameBytes + extraBytes + commentBytes;
    if (offset + headerBytes > centralDirectoryEnd) {
      throw archiveError("Archive entry metadata is truncated.");
    }
    let path: string;
    try {
      path = decoder.decode(
        content.subarray(offset + 46, offset + 46 + filenameBytes),
      );
    } catch (cause) {
      throw new AttachmentError(
        "attachment.archiveUnsafe",
        "Archive entry name is not valid UTF-8.",
        false,
        { cause },
      );
    }
    entries.push({
      path,
      compressedBytes,
      expandedBytes,
      kind: archiveEntryKind(path, externalAttributes),
      encrypted: (flags & 1) !== 0,
      depth: path.split(/[\\/]+/u).filter(Boolean).length,
    });
    offset += headerBytes;
  }
  if (offset !== centralDirectoryEnd) {
    throw archiveError("Archive central directory has trailing metadata.");
  }
  validateArchiveEntries(entries, limits);
  return Object.freeze(entries);
}

function unsafePath(path: string): boolean {
  return (
    path.length === 0 ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(path) ||
    path.split(/[\\/]+/u).some((segment) => segment === "..")
  );
}

export function validateArchiveEntries(
  entries: readonly ArchiveEntry[],
  limits: ArchiveLimits,
): void {
  let expandedBytes = 0;
  let files = 0;
  for (const entry of entries) {
    if (unsafePath(entry.path)) {
      throw archiveError("Archive contains an unsafe path.");
    }
    if (
      entry.kind === "symlink" ||
      entry.kind === "device" ||
      entry.encrypted
    ) {
      throw archiveError("Archive contains a forbidden entry type.");
    }
    if (entry.depth > limits.maximumDepth) {
      throw archiveError("Archive nesting exceeds the configured limit.");
    }
    if (entry.kind === "directory") continue;
    files += 1;
    expandedBytes += entry.expandedBytes;
    if (
      files > limits.maximumFiles ||
      entry.expandedBytes > limits.maximumExtractedFileBytes ||
      expandedBytes > limits.maximumExpandedBytes ||
      (entry.compressedBytes === 0
        ? entry.expandedBytes > 0
        : entry.expandedBytes / entry.compressedBytes >
          limits.maximumCompressionRatio)
    ) {
      throw archiveError("Archive exceeds the configured extraction limits.");
    }
  }
}
