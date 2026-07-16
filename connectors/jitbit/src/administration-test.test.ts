import { InMemoryConnectorSecretResolver } from "@caseweaver/connector-sdk";
import { describe, expect, it, vi } from "vitest";

import { testJitbitAdministrationSettings } from "./administration-test.js";
import { createJitbitConfiguration, jsonResponse } from "./fakes.js";

describe("Jitbit administration test", () => {
  it("performs the smallest safe read and discards the remote response", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse([]));

    await expect(
      testJitbitAdministrationSettings({
        settings: {
          ...createJitbitConfiguration().settings,
          apiTokenSecretName: "env:JITBIT_TEST_TOKEN",
        },
        secrets: new InMemoryConnectorSecretResolver({
          "env:JITBIT_TEST_TOKEN": "test-only-token",
        }),
        signal: new AbortController().signal,
        fetch,
      }),
    ).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/\/api\/Tickets/u);
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/count=1/u);
    expect(String(fetch.mock.calls[0]?.[0])).not.toMatch(/token|secret/iu);
  });

  it("rejects malformed candidate settings before resolving a credential", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();

    await expect(
      testJitbitAdministrationSettings({
        settings: { baseUrl: "not a URL" },
        secrets: new InMemoryConnectorSecretResolver({}),
        signal: new AbortController().signal,
        fetch,
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
