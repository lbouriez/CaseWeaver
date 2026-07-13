const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function begins(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function isUtf8Text(bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return [...text].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
    });
  } catch {
    return false;
  }
}

export function detectMimeType(sample: Uint8Array): string {
  if (begins(sample, PNG)) return "image/png";
  if (sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    sample[0] === 0x47 &&
    sample[1] === 0x49 &&
    sample[2] === 0x46 &&
    sample[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    sample[0] === 0x52 &&
    sample[1] === 0x49 &&
    sample[2] === 0x46 &&
    sample[3] === 0x46 &&
    sample[8] === 0x57 &&
    sample[9] === 0x45 &&
    sample[10] === 0x42 &&
    sample[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    sample[0] === 0x50 &&
    sample[1] === 0x4b &&
    (sample[2] === 0x03 || sample[2] === 0x05 || sample[2] === 0x07) &&
    (sample[3] === 0x04 || sample[3] === 0x06 || sample[3] === 0x08)
  ) {
    return "application/zip";
  }
  if (!isUtf8Text(sample)) return "application/octet-stream";

  const text = new TextDecoder("utf-8").decode(sample).trimStart();
  if (text.startsWith("{") || text.startsWith("[")) return "application/json";
  if (text.startsWith("<")) return "application/xml";
  return "text/plain";
}

export function normalizedMimeType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function mimeTypesCompatible(
  declared: string | undefined,
  detected: string,
): boolean {
  if (declared === undefined) return true;
  const normalized = normalizedMimeType(declared);
  if (normalized === detected) return true;
  return (
    detected === "text/plain" &&
    (normalized === "text/csv" ||
      normalized === "text/plain" ||
      normalized === "text/x-log" ||
      normalized === "text/x-ini")
  );
}
