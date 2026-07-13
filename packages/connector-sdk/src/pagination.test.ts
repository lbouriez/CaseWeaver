import { describe, expect, it } from "vitest";

import { ConnectorCancelledError } from "./errors.js";
import { cursorFixture } from "./fakes.js";
import { paginate } from "./pagination.js";

describe("pagination primitives", () => {
  it("passes each opaque cursor to the next page request", async () => {
    const controller = new AbortController();
    const received: string[] = [];

    const pages = paginate({ signal: controller.signal }, async (request) => {
      received.push(request.cursor?.value ?? "initial");
      return request.cursor === undefined
        ? { items: ["first"], nextCursor: cursorFixture("cursor-2") }
        : { items: ["second"] };
    });

    const values: string[] = [];
    for await (const page of pages) {
      values.push(...page.items);
    }

    expect(received).toEqual(["initial", "cursor-2"]);
    expect(values).toEqual(["first", "second"]);
  });

  it("throws a distinct cancellation error before work begins", async () => {
    const controller = new AbortController();
    controller.abort();

    const pages = paginate({ signal: controller.signal }, async () => ({
      items: [],
    }));

    await expect(pages.next()).rejects.toBeInstanceOf(ConnectorCancelledError);
  });
});
