import { describe, expect, it } from "vitest";

import type { ApiConfig } from "./config.js";
import { createLogger } from "./logger.js";

const config: ApiConfig = {
  databaseReadinessTimeoutMs: 500,
  databaseUrl: "postgresql://caseweaver:password@localhost:5432/caseweaver",
  host: "127.0.0.1",
  nodeEnv: "test",
  port: 3000,
  workspaceId: "workspace-test",
  principalId: "principal-test",
  allowedAdminOrigins: [],
  trustedProxyCidrs: [],
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
      result: "private model result",
      sourceUrl: "https://private.example/source",
      repositoryPath: "C:\\private\\checkout",
      externalSecretLocator: "vault://private/secret",
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
    expect(output).not.toContain("private model result");
    expect(output).not.toContain("private.example");
    expect(output).not.toContain("private\\checkout");
    expect(output).not.toContain("vault://private/secret");
  });

  it("does not serialize Error messages, stacks, or causes", () => {
    const entries: string[] = [];
    const logger = createLogger(config, {
      write: (entry: string) => {
        entries.push(entry);
        return true;
      },
    });
    const cause = new Error("private cause");
    const error = new Error("private error message", { cause });
    error.stack = "private error stack";

    logger.error(error);

    const output = entries.join("");
    expect(output).toContain('"type":"Error"');
    expect(output).not.toContain("private error message");
    expect(output).not.toContain("private error stack");
    expect(output).not.toContain("private cause");
  });

  it("redacts sensitive values nested through objects and arrays", () => {
    const entries: string[] = [];
    const logger = createLogger(config, {
      write: (entry: string) => {
        entries.push(entry);
        return true;
      },
    });
    let accessorRead = false;
    const accessorBacked = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorBacked, "safeLookingValue", {
      enumerable: true,
      get: () => {
        accessorRead = true;
        return "automation-private-accessor";
      },
    });

    logger.info({
      operation: {
        inputs: [
          {
            context: {
              prompt: "automation-deep-prompt",
              sourceUrl: "https://automation.example/private-source",
            },
          },
        ],
        result: {
          output: "automation-deep-output",
          attachment: { locator: "automation-deep-locator" },
        },
        accessorBacked,
      },
    });

    const output = entries.join("");
    expect(accessorRead).toBe(false);
    for (const prohibited of [
      "automation-deep-prompt",
      "automation.example/private-source",
      "automation-deep-output",
      "automation-deep-locator",
      "automation-private-accessor",
    ]) {
      expect(output).not.toContain(prohibited);
    }
  });
});
