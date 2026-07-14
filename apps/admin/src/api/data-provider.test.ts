import { describe, expect, it, vi } from "vitest";

import { CaseWeaverApiClient } from "./api-client.js";
import { createDataProvider } from "./data-provider.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const firstPage = {
  items: [{ id: "dead-letter-1", label: "Failed analysis", status: "failed" }],
  page: { hasNextPage: true, endCursor: "cursor-1" },
};

describe("React-Admin data provider", () => {
  it("maps React-Admin pages to fixed cursor endpoints and forwards cancellation", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(firstPage))
      .mockResolvedValueOnce(
        response({ items: [], page: { hasNextPage: false } }),
      );
    const provider = createDataProvider(
      new CaseWeaverApiClient(
        { apiBaseUrl: "https://api.example.test", uiTitle: "Control" },
        { fetchImplementation },
      ),
    );
    const controller = new AbortController();
    const parameters = {
      filter: {},
      pagination: { page: 1, perPage: 2 },
      signal: controller.signal,
      sort: { field: "updatedAt", order: "DESC" as const },
    };

    const first = await provider.getList("dead-letters", parameters);
    const second = await provider.getList("dead-letters", {
      ...parameters,
      pagination: { page: 2, perPage: 2 },
    });

    expect(first.pageInfo?.hasNextPage).toBe(true);
    expect(second.pageInfo?.hasNextPage).toBe(false);
    expect(fetchImplementation.mock.calls[1]?.[0]).toEqual(
      new URL(
        "https://api.example.test/v1/admin/operations/dead-letters?limit=2&after=cursor-1&sort=updatedAt&direction=DESC",
      ),
    );
    expect(fetchImplementation.mock.calls[0]?.[1]?.signal).toBe(
      controller.signal,
    );
  });

  it("refuses unregistered resources rather than constructing an arbitrary endpoint", async () => {
    const provider = createDataProvider(
      new CaseWeaverApiClient({
        apiBaseUrl: "https://api.example.test",
        uiTitle: "Control",
      }),
    );

    await expect(
      provider.getList("not-an-admin-resource", {
        filter: {},
        pagination: { page: 1, perPage: 10 },
        sort: { field: "updatedAt", order: "DESC" },
      }),
    ).rejects.toMatchObject({ code: "resource.unsupported" });
  });
});
