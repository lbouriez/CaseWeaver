import { z } from "zod";

const cursorPayloadSchema = z
  .object({
    sortKey: z.string().min(1).max(500),
    id: z.string().min(1).max(200),
  })
  .strict();

export interface CursorPosition {
  readonly sortKey: string;
  readonly id: string;
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly page: Readonly<{
    readonly hasNextPage: boolean;
    readonly endCursor?: string;
  }>;
}

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(
    JSON.stringify(cursorPayloadSchema.parse(position)),
    "utf8",
  ).toString("base64url");
}

export function decodeCursor(value: string): CursorPosition {
  if (value.length > 2_000) {
    throw new RangeError("Cursor is too large.");
  }
  try {
    return Object.freeze(
      cursorPayloadSchema.parse(
        JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
      ),
    );
  } catch {
    throw new Error("Cursor is invalid.");
  }
}

export function validatePageLimit(
  value: number | undefined,
  maximum = 200,
): number {
  const limit = value ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError(`Page limit must be between 1 and ${maximum}.`);
  }
  return limit;
}
