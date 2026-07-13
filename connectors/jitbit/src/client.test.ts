import {
  ConnectorCancelledError,
  ConnectorProtocolError,
  type ConnectorRemoteError,
} from "@caseweaver/connector-sdk";
import { describe, expect, it } from "vitest";

import { JitbitClient } from "./client.js";
import {
  createJitbitConfiguration,
  createJitbitSecretResolver,
  jsonResponse,
} from "./fakes.js";

describe("JitbitClient", () => {
  it("honors cancellation before resolving a secret or calling Jitbit", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new JitbitClient({
      configuration: createJitbitConfiguration(),
      secrets: createJitbitSecretResolver(),
      fetch: async () => {
        throw new Error("fetch must not be called");
      },
    });

    await expect(
      client.getTicket({ id: "10", signal: controller.signal }),
    ).rejects.toBeInstanceOf(ConnectorCancelledError);
  });

  it("retries a rate-limited safe read with Retry-After and preserves typed auth failures", async () => {
    const delays: number[] = [];
    let calls = 0;
    const client = new JitbitClient({
      configuration: createJitbitConfiguration(),
      secrets: createJitbitSecretResolver(),
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? jsonResponse(
              { ignored: true },
              {
                status: 429,
                headers: { "retry-after": "2", "x-request-id": "rate-1" },
              },
            )
          : jsonResponse([]);
      },
    });

    await expect(
      client.getTicketSummaries({
        count: 10,
        offset: 0,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual([]);
    expect(delays).toEqual([2_000]);

    const unauthorized = new JitbitClient({
      configuration: createJitbitConfiguration(),
      secrets: createJitbitSecretResolver(),
      fetch: async () =>
        jsonResponse(
          {},
          { status: 401, headers: { "x-request-id": "auth-1" } },
        ),
    });
    await expect(
      unauthorized.getTicket({
        id: "10",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject<Partial<ConnectorRemoteError>>({
      category: "authentication",
      details: { requestId: "auth-1", statusCode: 401 },
    });
  });

  it("maps malformed responses and timeout/network failures to safe typed errors", async () => {
    const malformed = new JitbitClient({
      configuration: createJitbitConfiguration(),
      secrets: createJitbitSecretResolver(),
      fetch: async () => jsonResponse({ unexpected: "shape" }),
    });
    await expect(
      malformed.getTicket({ id: "10", signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(ConnectorProtocolError);

    const timeout = new JitbitClient({
      configuration: createJitbitConfiguration({ requestTimeoutMs: 100 }),
      secrets: createJitbitSecretResolver(),
      sleep: async () => undefined,
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Timed out", "AbortError")),
            { once: true },
          );
        }),
    });
    await expect(
      timeout.getTicket({ id: "10", signal: new AbortController().signal }),
    ).rejects.toMatchObject<Partial<ConnectorRemoteError>>({
      category: "timeout",
      retryable: true,
    });
  });
});
