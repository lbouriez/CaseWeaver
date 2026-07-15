import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, validatePageLimit } from "./pagination.js";

describe("administration pagination", () => {
  it("round-trips an opaque stable position", () => {
    expect(
      decodeCursor(
        encodeCursor({ sortKey: "2026-07-14T00:00:00.000Z", id: "resource-1" }),
      ),
    ).toEqual({ sortKey: "2026-07-14T00:00:00.000Z", id: "resource-1" });
  });

  it("rejects malformed cursors and unbounded limits", () => {
    expect(() => decodeCursor("not-a-cursor")).toThrow("Cursor is invalid");
    expect(() => validatePageLimit(201)).toThrow("between 1 and 200");
  });
});
