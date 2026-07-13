import { describe, expect, it } from "vitest";

import type { ApiConfig } from "./config.js";
import { createLogger } from "./logger.js";

const config: ApiConfig = {
  databaseReadinessTimeoutMs: 500,
  databaseUrl: "postgresql://caseweaver:password@localhost:5432/caseweaver",
  host: "127.0.0.1",
  nodeEnv: "test",
  port: 3000,
};

describe("createLogger", () => {
  it("redacts credentials, request data, and future prompt content", () => {
    const entries: string[] = [];
    const logger = createLogger(config, {
      write: (entry: string) => {
        entries.push(entry);
        return true;
      },
    });

    logger.info({
      databaseUrl: "postgresql://user:super-secret@localhost/caseweaver",
      password: "super-secret",
      prompt: "private prompt content",
      request: {
        body: { content: "private request content" },
        headers: { authorization: "Bearer private-token" },
      },
      token: "private-token",
    });

    const output = entries.join("");
    expect(output).toContain("[Redacted]");
    expect(output).not.toContain("super-secret");
    expect(output).not.toContain("private prompt content");
    expect(output).not.toContain("private request content");
    expect(output).not.toContain("private-token");
  });
});
