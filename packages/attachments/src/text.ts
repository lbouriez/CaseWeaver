import { AttachmentError } from "./errors.js";

export function normalizeText(
  content: Uint8Array,
  maximumBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("Maximum normalized text bytes must be positive.");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (cause) {
    throw new AttachmentError(
      "attachment.invalidText",
      "Attachment text is not valid UTF-8.",
      false,
      { cause },
    );
  }
  const normalized = text
    .replace(/\r\n?/gu, "\n")
    .replaceAll(String.fromCharCode(0), "");
  const encoded = new TextEncoder().encode(normalized);
  if (encoded.byteLength <= maximumBytes) {
    return Object.freeze({ text: normalized, truncated: false });
  }
  let end = maximumBytes;
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return Object.freeze({
    text: new TextDecoder("utf-8", { fatal: true }).decode(
      encoded.subarray(0, end),
    ),
    truncated: true,
  });
}
