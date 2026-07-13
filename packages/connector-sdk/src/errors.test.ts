import { describe, expect, it } from "vitest";

import {
  ConnectorCancelledError,
  ConnectorRemoteError,
  isConnectorCancellation,
} from "./errors.js";

describe("connector errors", () => {
  it("preserves safe retry metadata and keeps cancellation distinct", () => {
    const error = new ConnectorRemoteError(
      "The remote service is rate limited.",
      {
        category: "rateLimit",
        retryable: true,
        retryAfterMs: 30_000,
        requestId: "remote-request-1",
      },
    );

    expect(error.retryable).toBe(true);
    expect(error.details).toMatchObject({
      retryAfterMs: 30_000,
      requestId: "remote-request-1",
    });
    expect(isConnectorCancellation(new ConnectorCancelledError())).toBe(true);
    expect(isConnectorCancellation(error)).toBe(false);
  });
});
